/**
 * End-to-end transfer script:
 * 1) Auth with Google Photos Picker scope
 * 2) Create Picker session
 * 3) User selects photos in pickerUri
 * 4) Poll session until selection is complete
 * 5) Download selected media bytes and upload to Scaleway bucket
 *
 * Usage:
 *   npx tsx scripts/picker-to-scaleway-transfer.ts
 */
import http from 'node:http';
import { exec } from 'node:child_process';
import { Readable } from 'node:stream';
import os from 'node:os';
import * as dotenv from 'dotenv';
import {
  createOAuth2Client,
  getAuthUrlForScopes,
  exchangeCode,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  GooglePhotosPickerClient,
  ScalewayProvider,
  validateScalewayConfig,
} from '../src/providers/index.js';

dotenv.config();

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/google/callback';
const callbackConfig = resolveCallbackConfig(redirectUri);

if (!clientId || !clientSecret) {
  console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const scalewayConfig = validateScalewayConfig({
  provider: 'scaleway',
  region: process.env.SCW_REGION,
  bucket: process.env.SCW_BUCKET,
  accessKey: process.env.SCW_ACCESS_KEY,
  secretKey: process.env.SCW_SECRET_KEY,
  prefix: process.env.SCW_PREFIX,
});

const oauthClient = createOAuth2Client({ clientId, clientSecret, redirectUri });
const authUrl = getAuthUrlForScopes(oauthClient, [GOOGLE_PHOTOS_PICKER_SCOPE]);

console.log('\n🔗 Opening Google consent page for Picker API scope...\n');
console.log(`   ${authUrl}\n`);
openUrl(authUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', callbackConfig.origin);

  if (url.pathname !== callbackConfig.pathname) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Auth error: ${error}</h2><p>You can close this tab.</p>`);
    console.error(`❌ Google returned error: ${error}`);
    shutdown(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>Missing authorization code.</h2>');
    return;
  }

  try {
    console.log('✅ Authorization code received — exchanging for tokens...');
    const tokens = await exchangeCode(oauthClient, code);
    const pickerClient = new GooglePhotosPickerClient(oauthClient, tokens);
    const destination = new ScalewayProvider(scalewayConfig);

    const session = await pickerClient.createSession();
    const pickerUri = `${session.pickerUri}/autoclose`;
    console.log('\n📷 Picker session created.');
    console.log(`   Session ID: ${session.id}`);
    console.log(`   Open picker: ${pickerUri}\n`);

    openUrl(pickerUri);
    console.log('⏳ Waiting for you to finish selecting media in Google Photos...');

    const readySession = await waitForSelectionComplete(pickerClient, session.id);
    if (!readySession.mediaItemsSet) {
      throw new Error('Picker session timed out before media selection was completed.');
    }

    const picked = await collectPickedItems(pickerClient, session.id);
    console.log(`✅ Selected ${picked.length} item(s). Starting upload to Scaleway...\n`);

    for (let index = 0; index < picked.length; index += 1) {
      const item = picked[index];
      const baseUrl = item.baseUrl;
      const mimeType = item.mimeType;
      const filename = item.filename ?? `${item.id}.bin`;

      if (!baseUrl) {
        console.log(`⚠️ Skipping item ${item.id}: missing baseUrl`);
        continue;
      }

      const contentUrl = buildPickerDownloadUrl(baseUrl, mimeType);
      const response = await fetch(contentUrl, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });

      if (!response.ok || !response.body) {
        const body = await response.text();
        throw new Error(`Failed to download picked item ${item.id}: ${response.status} ${body}`);
      }

      // @ts-expect-error response.body is web stream in Node fetch
      const stream = Readable.fromWeb(response.body);
      const key = buildDestinationKey(filename, item.id, item.createTime);
      await destination.upload(key, stream, mimeType);

      console.log(`⬆️ [${index + 1}/${picked.length}] Uploaded ${filename} -> ${key}`);
    }

    await pickerClient.deleteSession(session.id);
    console.log('\n🎉 Transfer complete. Picker session cleaned up.');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Transfer complete!</h2><p>Check terminal logs for uploaded files.</p>');
    shutdown(0);
  } catch (err) {
    console.error('❌ Transfer failed:\n', err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Transfer error</h2><pre>${String(err)}</pre>`);
    shutdown(1);
  }
});

server.listen(callbackConfig.port, callbackConfig.hostname, () => {
  console.log(`⏳ Waiting for OAuth callback on ${callbackConfig.origin}${callbackConfig.pathname} ...\n`);
});

function openUrl(url: string): void {
  const platform = os.platform();
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function resolveCallbackConfig(uri: string): {
  origin: string;
  hostname: string;
  port: number;
  pathname: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid GOOGLE_REDIRECT_URI: ${uri}`);
  }

  if (parsed.protocol !== 'http:') {
    throw new Error('GOOGLE_REDIRECT_URI must use http:// for local callback server');
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid callback port in GOOGLE_REDIRECT_URI: ${parsed.port}`);
  }

  return {
    origin: parsed.origin,
    hostname: parsed.hostname,
    port,
    pathname: parsed.pathname || '/',
  };
}

async function waitForSelectionComplete(
  pickerClient: GooglePhotosPickerClient,
  sessionId: string,
): Promise<{ mediaItemsSet: boolean; pollingConfig?: { pollInterval?: string; timeoutIn?: string } }> {
  const started = Date.now();
  let timeoutMs = 3 * 60 * 1000; // default 3 minutes

  while (Date.now() - started < timeoutMs) {
    const session = await pickerClient.getSession(sessionId);
    if (session.mediaItemsSet) return session;

    const intervalMs = parseDurationMs(session.pollingConfig?.pollInterval) ?? 3000;
    timeoutMs = parseDurationMs(session.pollingConfig?.timeoutIn) ?? timeoutMs;
    await sleep(intervalMs);
  }

  return { mediaItemsSet: false };
}

async function collectPickedItems(
  pickerClient: GooglePhotosPickerClient,
  sessionId: string,
): Promise<Array<{ id: string; filename?: string; mimeType?: string; baseUrl?: string; createTime?: string }>> {
  const items: Array<{ id: string; filename?: string; mimeType?: string; baseUrl?: string; createTime?: string }> = [];
  let pageToken: string | undefined;

  do {
    const page = await pickerClient.listPickedMediaItems(sessionId, pageToken, 100);
    items.push(...page.mediaItems);
    pageToken = page.nextPageToken;
  } while (pageToken);

  // Some Picker list responses omit fields like createTime. Hydrate via get by ID.
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].createTime || !items[i].baseUrl) {
      const detailed = await pickerClient.getPickedMediaItem(sessionId, items[i].id);
      items[i] = {
        ...items[i],
        createTime: items[i].createTime ?? detailed.createTime,
        baseUrl: items[i].baseUrl ?? detailed.baseUrl,
        mimeType: items[i].mimeType ?? detailed.mimeType,
        filename: items[i].filename ?? detailed.filename,
      };
    }
  }

  return items;
}

function buildPickerDownloadUrl(baseUrl: string, mimeType?: string): string {
  if (mimeType?.startsWith('video/')) return `${baseUrl}=dv`;
  return `${baseUrl}=d`;
}

function buildDestinationKey(
  filename: string,
  itemId: string,
  createTime?: string,
): string {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const datePath = toDatePath(createTime);
  return `${datePath}/${itemId}-${sanitized}`;
}

function toDatePath(createTime?: string): string {
  if (!createTime) {
    const now = new Date();
    return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}`;
  }

  const date = new Date(createTime);
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}`;
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}/${month}/${day}`;
}

function parseDurationMs(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = /^([0-9]+)s$/.exec(duration.trim());
  if (!match) return undefined;
  return Number(match[1]) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(code: number): void {
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 600);
}
