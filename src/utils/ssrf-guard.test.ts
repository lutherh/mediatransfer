import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl } from './ssrf-guard.js';

// Mock node:dns/promises so we can assert behaviour deterministically without
// relying on real DNS resolution in the test environment.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';
const mockedLookup = vi.mocked(lookup);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('assertPublicHttpUrl', () => {
  it('accepts a public hostname that resolves to a public IPv4', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    const url = await assertPublicHttpUrl('https://example.com/path');
    expect(url.hostname).toBe('example.com');
    expect(mockedLookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  it('rejects http://169.254.169.254/ (cloud metadata IMDS) without DNS lookup', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/')).rejects.toThrow(
      /host not allowed/,
    );
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects http://localhost', async () => {
    await expect(assertPublicHttpUrl('http://localhost')).rejects.toThrow(/host not allowed/);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to RFC1918 (192.168/16)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }]);
    await expect(assertPublicHttpUrl('http://internal.example/')).rejects.toThrow(
      /host not allowed/,
    );
  });

  it('rejects hostnames that resolve to RFC1918 (10/8)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }]);
    await expect(assertPublicHttpUrl('http://corp.example/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects CGNAT 100.64/10', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '100.64.1.1', family: 4 }]);
    await expect(assertPublicHttpUrl('http://cgnat.example/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects IPv6 loopback', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    await expect(assertPublicHttpUrl('http://v6.example/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects IPv6 unique-local fc00::/7', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: 'fd12:3456:789a::1', family: 6 }]);
    await expect(assertPublicHttpUrl('http://ula.example/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects IPv4-mapped IPv6 of a private IPv4', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '::ffff:192.168.0.1', family: 6 }]);
    await expect(assertPublicHttpUrl('http://mapped.example/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(
      /only http\(s\) URLs allowed/,
    );
    await expect(assertPublicHttpUrl('gopher://evil.example/')).rejects.toThrow(
      /only http\(s\) URLs allowed/,
    );
  });

  it('rejects metadata.google.internal and *.internal', async () => {
    await expect(assertPublicHttpUrl('http://metadata.google.internal/')).rejects.toThrow(
      /host not allowed/,
    );
    await expect(assertPublicHttpUrl('http://foo.internal/')).rejects.toThrow(/host not allowed/);
  });

  it('rejects when DNS lookup fails', async () => {
    mockedLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertPublicHttpUrl('http://nonexistent.example/')).rejects.toThrow(
      /DNS resolution failed/,
    );
  });

  it('rejects mixed-result hostnames where any address is private', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertPublicHttpUrl('http://mixed.example/')).rejects.toThrow(/host not allowed/);
  });

  it('honors SSRF_ALLOWED_HOSTS to bypass guard for whitelisted hostnames', async () => {
    vi.stubEnv('SSRF_ALLOWED_HOSTS', 'immich.local, my.lan.box');
    const url = await assertPublicHttpUrl('http://immich.local/api');
    expect(url.hostname).toBe('immich.local');
    // No DNS lookup should be performed for allowlisted hosts.
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects invalid URL strings', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/invalid URL/);
  });
});
