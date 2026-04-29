import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getLogger } from '../../utils/logger.js';

const log = getLogger().child({ module: 'catalog-html' });

let cachedCatalogHtml: string | null = null;

const FALLBACK_CATALOG_HTML = `<!doctype html>
<html><body style="font-family:system-ui;padding:24px">
<h2>Catalog browser</h2>
<p>Catalog UI template is unavailable.</p>
</body></html>`;

export function buildCatalogHtml(): string {
  if (cachedCatalogHtml) {
    return cachedCatalogHtml;
  }

  try {
    const filePath = path.resolve(process.cwd(), 'archive_browser.html');
    cachedCatalogHtml = readFileSync(filePath, 'utf8');
    return cachedCatalogHtml;
  } catch (err) {
    log.debug({ err }, '[catalog-html] Failed to load archive_browser.html fallback template');
    cachedCatalogHtml = FALLBACK_CATALOG_HTML;
    return cachedCatalogHtml;
  }
}
