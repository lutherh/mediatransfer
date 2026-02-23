import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CloudUsageService } from '../types.js';

const usageQuerySchema = z.object({
  bucketType: z.enum(['standard', 'infrequent', 'archive']).default('standard'),
  putRequests: z.coerce.number().min(0).default(0),
  getRequests: z.coerce.number().min(0).default(0),
  listRequests: z.coerce.number().min(0).default(0),
  lifecycleTransitionGB: z.coerce.number().min(0).default(0),
  retrievalGB: z.coerce.number().min(0).default(0),
  egressGB: z.coerce.number().min(0).default(0),
  vatRate: z.coerce.number().min(0).max(1).default(0.25),
});

const PRICE_PER_GB_MONTH_USD: Record<'standard' | 'infrequent' | 'archive', number> = {
  standard: 0.023,
  infrequent: 0.0125,
  archive: 0.004,
};

const REQUEST_PRICE_PER_1000_USD: Record<'standard' | 'infrequent' | 'archive', { put: number; get: number; list: number }> = {
  standard: { put: 0.005, get: 0.0004, list: 0.005 },
  infrequent: { put: 0.01, get: 0.001, list: 0.01 },
  archive: { put: 0.02, get: 0.002, list: 0.01 },
};

const RETRIEVAL_PRICE_PER_GB_USD: Record<'standard' | 'infrequent' | 'archive', number> = {
  standard: 0,
  infrequent: 0.01,
  archive: 0.02,
};

const LIFECYCLE_TRANSITION_PRICE_PER_GB_USD: Record<'standard' | 'infrequent' | 'archive', number> = {
  standard: 0.01,
  infrequent: 0.01,
  archive: 0.01,
};

const EGRESS_PRICE_PER_GB_USD = 0.09;

const PROVIDER_RULES = {
  requestBillingUnit: 1000,
  lineItemRoundingDecimals: 4,
  invoiceRoundingDecimals: 2,
  minimumMonthlyChargeUSD: 0,
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export async function registerCloudUsageRoutes(
  app: FastifyInstance,
  service?: CloudUsageService,
): Promise<void> {
  app.get('/usage/cloud', async (req, reply) => {
    if (!service) {
      return reply.code(503).send({
        error: 'Cloud usage is unavailable. Configure SCW_REGION, SCW_BUCKET, SCW_ACCESS_KEY, and SCW_SECRET_KEY.',
      });
    }

    const query = usageQuerySchema.parse(req.query ?? {});
    const summary = await service.getSummary();

    const totalGB = summary.totalBytes / (1024 ** 3);
    const storageRate = PRICE_PER_GB_MONTH_USD[query.bucketType];
    const requestRates = REQUEST_PRICE_PER_1000_USD[query.bucketType];
    const retrievalRate = RETRIEVAL_PRICE_PER_GB_USD[query.bucketType];
    const transitionRate = LIFECYCLE_TRANSITION_PRICE_PER_GB_USD[query.bucketType];

    const storageCost = roundTo(totalGB * storageRate, PROVIDER_RULES.lineItemRoundingDecimals);
    const putRequestCost = roundTo((query.putRequests / PROVIDER_RULES.requestBillingUnit) * requestRates.put, PROVIDER_RULES.lineItemRoundingDecimals);
    const getRequestCost = roundTo((query.getRequests / PROVIDER_RULES.requestBillingUnit) * requestRates.get, PROVIDER_RULES.lineItemRoundingDecimals);
    const listRequestCost = roundTo((query.listRequests / PROVIDER_RULES.requestBillingUnit) * requestRates.list, PROVIDER_RULES.lineItemRoundingDecimals);
    const requestCost = roundTo(putRequestCost + getRequestCost + listRequestCost, PROVIDER_RULES.lineItemRoundingDecimals);
    const lifecycleTransitionCost = roundTo(query.lifecycleTransitionGB * transitionRate, PROVIDER_RULES.lineItemRoundingDecimals);
    const retrievalCost = roundTo(query.retrievalGB * retrievalRate, PROVIDER_RULES.lineItemRoundingDecimals);
    const egressCost = roundTo(query.egressGB * EGRESS_PRICE_PER_GB_USD, PROVIDER_RULES.lineItemRoundingDecimals);

    const subtotalBeforeMinimum = roundTo(
      storageCost + requestCost + lifecycleTransitionCost + retrievalCost + egressCost,
      PROVIDER_RULES.lineItemRoundingDecimals,
    );

    const minimumChargeAdjustment = Math.max(0, roundTo(PROVIDER_RULES.minimumMonthlyChargeUSD - subtotalBeforeMinimum, PROVIDER_RULES.lineItemRoundingDecimals));
    const subtotalExclVat = roundTo(subtotalBeforeMinimum + minimumChargeAdjustment, PROVIDER_RULES.lineItemRoundingDecimals);
    const vatAmount = roundTo(subtotalExclVat * query.vatRate, PROVIDER_RULES.lineItemRoundingDecimals);
    const totalInclVat = roundTo(subtotalExclVat + vatAmount, PROVIDER_RULES.invoiceRoundingDecimals);

    return {
      ...summary,
      bucketType: query.bucketType,
      totalGB,
      assumptions: {
        putRequests: query.putRequests,
        getRequests: query.getRequests,
        listRequests: query.listRequests,
        lifecycleTransitionGB: query.lifecycleTransitionGB,
        retrievalGB: query.retrievalGB,
        egressGB: query.egressGB,
        vatRate: query.vatRate,
      },
      pricing: {
        currency: 'USD',
        pricePerGBMonthly: storageRate,
        requestPer1000: requestRates,
        lifecycleTransitionPerGB: transitionRate,
        retrievalPerGB: retrievalRate,
        egressPerGB: EGRESS_PRICE_PER_GB_USD,
      },
      providerRules: PROVIDER_RULES,
      breakdown: {
        storageCost,
        putRequestCost,
        getRequestCost,
        listRequestCost,
        requestCost,
        lifecycleTransitionCost,
        retrievalCost,
        egressCost,
        subtotalBeforeMinimum,
        minimumChargeAdjustment,
        subtotalExclVat,
        vatAmount,
        totalInclVat,
      },
      estimatedMonthlyCost: totalInclVat,
      note: 'Estimate includes storage, requests, transition, retrieval, egress, and VAT based on supplied assumptions (not invoice data).',
    };
  });
}