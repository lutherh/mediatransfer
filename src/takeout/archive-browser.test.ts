import { describe, it, expect } from 'vitest';
import { parseArchiveBrowserHtml } from './archive-browser.js';

describe('takeout/archive-browser', () => {
  it('extracts service summary and folder names from archive browser html', () => {
    const html = `
      <h1 class="header_title">Archive for user@example.com</h1>
      <div class="header_subtext">24 Feb 2026, 11:43:48 GMT-8 • 1,731.65 GB • <a href="#">Learn more</a></div>
      <h1 class="data-folder-name" data-folder-name="Google Photos">Google Photos</h1>
      <div class="service_summary">227,263 files, 1,731.65 GB</div>
      <div class="extracted-folder-name">Trip 2025</div>
      <div class="extracted-folder-name">Sample &amp; Album</div>
      <div class="extracted-folder-name">Trip 2025</div>
      <div class="extracted-file-name">IMG_0001.jpg.supplemental-metadata.json</div>
      <div class="extracted-file-name">metadata.json</div>
    `;

    const parsed = parseArchiveBrowserHtml(html);

    expect(parsed.account).toBe('user@example.com');
    expect(parsed.totalSizeText).toBe('1,731.65 GB');
    expect(parsed.serviceName).toBe('Google Photos');
    expect(parsed.serviceFileCount).toBe(227263);
    expect(parsed.folderNames).toEqual(['Trip 2025', 'Sample & Album']);
    expect(parsed.hasSupplementalMetadata).toBe(true);
    expect(parsed.hasMetadataJson).toBe(true);
  });
});