import fs from 'node:fs/promises';

export type ArchiveBrowserSummary = {
  account?: string;
  generatedAtText?: string;
  totalSizeText?: string;
  serviceName?: string;
  serviceFileCount?: number;
  serviceSizeText?: string;
  folderNames: string[];
  hasMetadataJson: boolean;
  hasSupplementalMetadata: boolean;
};

export async function loadArchiveBrowserSummary(
  filePath: string,
): Promise<ArchiveBrowserSummary> {
  const html = await fs.readFile(filePath, 'utf8');
  return parseArchiveBrowserHtml(html);
}

export function parseArchiveBrowserHtml(html: string): ArchiveBrowserSummary {
  const account = readFirstGroup(
    html,
    /<h1 class="header_title">\s*Archive for\s*([^<]+)<\/h1>/i,
  )?.[1]?.trim();

  const headerMeta = readFirstGroup(
    html,
    /<div class="header_subtext">\s*([^<•]+?)\s*•\s*([^•<]+)\s*•/i,
  );

  const generatedAtText = headerMeta?.[1]?.trim();
  const totalSizeText = headerMeta?.[2]?.trim();

  const serviceName = decodeEntities(
    readFirstGroup(
      html,
      /<h1 class="data-folder-name"[^>]*>([^<]+)<\/h1>/i,
    )?.[1]?.trim() ?? '',
  ) || undefined;

  const serviceSummaryMatch = readFirstGroup(
    html,
    /([\d,]+)\s+files\s*,\s*([\d.,]+\s*[A-Za-z]{1,3})/i,
  );

  const serviceFileCount = serviceSummaryMatch
    ? Number(serviceSummaryMatch[1].replace(/,/g, ''))
    : undefined;
  const serviceSizeText = serviceSummaryMatch?.[2]?.trim();

  const folderNames = uniqueInOrder(
    Array.from(
      html.matchAll(/<div class="extracted-folder-name">([^<]*)<\/div>/gi),
      (match) => decodeEntities(match[1].trim()),
    ).filter((name) => name.length > 0),
  );

  const hasMetadataJson = /\bmetadata\.json\b/i.test(html);
  const hasSupplementalMetadata = /supplemental-metadata\.json|\.supp\w*\.json/i.test(html);

  return {
    account,
    generatedAtText,
    totalSizeText,
    serviceName,
    serviceFileCount: Number.isFinite(serviceFileCount) ? serviceFileCount : undefined,
    serviceSizeText,
    folderNames,
    hasMetadataJson,
    hasSupplementalMetadata,
  };
}

function readFirstGroup(html: string, re: RegExp): RegExpExecArray | undefined {
  const match = re.exec(html);
  return match ?? undefined;
}

function uniqueInOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function decodeEntities(input: string): string {
  const named = input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");

  return named
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}