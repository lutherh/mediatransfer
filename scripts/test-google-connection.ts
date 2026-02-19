/**
 * Quick script to verify Google Photos OAuth2 connection.
 *
 * Usage:  npx tsx scripts/test-google-connection.ts
 *
 * 1. Starts a tiny HTTP server on localhost:3000
 * 2. Opens the Google consent URL in your browser
 * 3. Handles the OAuth2 callback
 * 4. Lists up to 5 albums + 5 media items to confirm everything works
 */
import http from 'node:http';
import { exec } from 'node:child_process';
import * as dotenv from 'dotenv';
import {
  createOAuth2Client,
  getAuthUrl,
  exchangeCode,
} from '../src/providers/google-photos-auth.js';
import { GooglePhotosProvider } from '../src/providers/google-photos.js';

dotenv.config();

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/auth/google/callback';

if (!clientId || !clientSecret) {
  console.error('❌  Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauthClient = createOAuth2Client({ clientId, clientSecret, redirectUri });
const authUrl = getAuthUrl(oauthClient);

console.log('\n🔗  Opening Google consent page in your browser...\n');
console.log(`   If it doesn't open automatically, visit:\n   ${authUrl}\n`);

// Open URL in default browser (Windows)
exec(`start "" "${authUrl}"`);

// Tiny HTTP server to catch the OAuth2 callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:3000`);

  if (!url.pathname.startsWith('/auth/google/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Auth error: ${error}</h2><p>You can close this tab.</p>`);
    console.error(`❌  Google returned error: ${error}`);
    shutdown(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>Missing authorization code.</h2>');
    return;
  }

  try {
    console.log('✅  Authorization code received — exchanging for tokens...');
    const tokens = await exchangeCode(oauthClient, code);
    console.log('✅  Tokens obtained!');
    console.log(`   Access token : ${tokens.accessToken.slice(0, 20)}...`);
    console.log(`   Refresh token: ${tokens.refreshToken ? tokens.refreshToken.slice(0, 20) + '...' : '(none)'}`);
    console.log(`   Expiry       : ${tokens.expiryDate ? new Date(tokens.expiryDate).toISOString() : 'unknown'}\n`);

    // Quick raw fetch test before using the provider
    console.log('🔍  Checking Google Photos Library API access...');
    const rawRes = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=1', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    console.log(`   Status: ${rawRes.status} ${rawRes.statusText}`);
    const rawBody = await rawRes.text();
    console.log(`   Body:   ${rawBody.slice(0, 500)}\n`);

    if (!rawRes.ok) {
      throw new Error(
        [
          `Raw API test failed: ${rawRes.status} — ${rawBody}`,
          '',
          'Important: since March 2025, Google Photos Library API removed full-library scopes.',
          'Use app-created-data scopes in OAuth consent screen:',
          '- https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
          '- https://www.googleapis.com/auth/photoslibrary.appendonly',
          '',
          'If your goal is reading the entire existing Google Photos library, migrate to Google Photos Picker API.',
        ].join('\n'),
      );
    }

    // If raw fetch worked, use the provider
    const provider = new GooglePhotosProvider(oauthClient, tokens);

    console.log('📸  Listing albums...');
    const albumsPage = await provider.listAlbums();
    if (albumsPage.albums.length === 0) {
      console.log('   (no albums found — that is OK if your library has none)');
    } else {
      for (const a of albumsPage.albums.slice(0, 5)) {
        console.log(`   • ${a.title}  (${a.mediaItemsCount} items)`);
      }
      if (albumsPage.albums.length > 5) {
        console.log(`   ... and ${albumsPage.albums.length - 5} more`);
      }
    }

    console.log('\n📷  Listing recent media items...');
    const mediaPage = await provider.listMediaItems({ maxResults: 5 });
    if (mediaPage.items.length === 0) {
      console.log('   (no app-created media items found — this is expected for a fresh app)');
    } else {
      for (const m of mediaPage.items) {
        console.log(`   • ${m.filename}  (${m.mimeType}, ${m.width}×${m.height})`);
      }
    }

    console.log('\n🎉  Connection test PASSED — Google Photos API is working!\n');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✅ Connection successful!</h2><p>Check your terminal for details. You can close this tab.</p>');
  } catch (err) {
    console.error('❌  Connection test FAILED:\n', err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>❌ Error</h2><pre>${String(err)}</pre>`);
  }

  shutdown(0);
});

function shutdown(code: number) {
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 500);
}

server.listen(3000, () => {
  console.log('⏳  Waiting for OAuth2 callback on http://localhost:3000 ...\n');
});
