import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CloudUsageService } from '../types.js';

const usageQuerySchema = z.object({
  bucketType: z.enum(['standard', 'infrequent', 'archive']).default('standard'),
});

const PRICE_PER_GB_MONTH_USD: Record<'standard' | 'infrequent' | 'archive', number> = {
  standard: 0.023,
  infrequent: 0.0125,
  archive: 0.004,
};

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
    const pricePerGBMonthly = PRICE_PER_GB_MONTH_USD[query.bucketType];
    const estimatedMonthlyCost = totalGB * pricePerGBMonthly;

    return {
      ...summary,
      bucketType: query.bucketType,
      totalGB,
      pricing: {
        currency: 'USD',
        pricePerGBMonthly,
      },
      estimatedMonthlyCost,
      note: 'Estimate includes storage only (no request, transfer, retrieval, or taxes).',
    };
  });
}