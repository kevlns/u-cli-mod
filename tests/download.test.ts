import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadToFile, DEFAULT_HOST_ALLOWLIST } from '../src/download.js';
import { sha256Buffer } from '../src/integrity.js';

const PAYLOAD = Buffer.from('hello-download-world');
const HASH = sha256Buffer(PAYLOAD);

interface Ctx {
  dir: string;
  server: Server;
  base: string;
}
let ctx: Ctx;

function startServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'epc-dl-'));
  const server = await startServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD);
    } else if (req.url === '/truncated') {
      // chunked, deliberately short body -> size verification must catch it
      res.writeHead(200);
      res.write(PAYLOAD.subarray(0, 5));
      res.end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as { port: number }).port}/ok` });
      res.end();
    } else if (req.url === '/redirect-external') {
      res.writeHead(302, { location: 'http://example.com/evil' });
      res.end();
    } else if (req.url === '/stall') {
      // Headers arrive, but the body never does: the timeout must abort the
      // body read itself (not only the initial request).
      res.writeHead(200, { 'content-length': PAYLOAD.length });
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: `/loop` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  ctx = { dir, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
});

afterEach(async () => {
  ctx.server.closeAllConnections?.();
  await new Promise((resolve) => ctx.server.close(resolve));
  rmSync(ctx.dir, { recursive: true, force: true });
});

describe('DEFAULT_HOST_ALLOWLIST', () => {
  it('covers the real Unity host chain incl. observed redirect targets', () => {
    for (const host of [
      'public-cdn.cloud.unity3d.com',
      'public-cdn.cloud.unitychina.cn',
      'download.packages.unity.com',
      'cdn.packages.unity.com',
    ]) {
      expect(DEFAULT_HOST_ALLOWLIST.has(host)).toBe(true);
    }
  });
});

describe('downloadToFile', () => {
  it('downloads and verifies hash, atomically creating the destination', async () => {
    const dest = join(ctx.dir, 'out.bin');
    const result = await downloadToFile(`${ctx.base}/ok`, dest, {
      expectedSha256: HASH,
      expectedSize: PAYLOAD.length,
      hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
    });
    expect(result.sha256).toBe(HASH);
    expect(result.size).toBe(PAYLOAD.length);
    expect(existsSync(dest)).toBe(true);
    const leftovers = (await import('node:fs')).readdirSync(ctx.dir).filter((f) => f.includes('.part'));
    expect(leftovers).toEqual([]);
  });

  it('rejects off-allowlist hosts before any transfer', async () => {
    const dest = join(ctx.dir, 'out.bin');
    await expect(
      downloadToFile('http://127.0.0.1:1/x', dest, {
        expectedSha256: HASH,
        hostAllowlist: new Set(['example.com']),
        allowedProtocols: new Set(['http:', 'https:']),
      }),
    ).rejects.toThrow(/白名单/);
    expect(existsSync(dest)).toBe(false);
  });

  it('cleans up the temp file and keeps destination untouched on hash mismatch', async () => {
    const dest = join(ctx.dir, 'out.bin');
    await expect(
      downloadToFile(`${ctx.base}/ok`, dest, {
        expectedSha256: 'f'.repeat(64),
        hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
      }),
    ).rejects.toThrow(/SHA-256 校验失败/);
    expect(existsSync(dest)).toBe(false);
    const leftovers = (await import('node:fs')).readdirSync(ctx.dir).filter((f) => f.includes('.part'));
    expect(leftovers).toEqual([]);
  });

  it('catches truncated responses via size check', async () => {
    const dest = join(ctx.dir, 'out.bin');
    await expect(
      downloadToFile(`${ctx.base}/truncated`, dest, {
        expectedSha256: HASH,
        expectedSize: PAYLOAD.length,
        hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
      }),
    ).rejects.toThrow(/文件大小不匹配/);
    expect(existsSync(dest)).toBe(false);
  });

  it('follows allowed redirects', async () => {
    const dest = join(ctx.dir, 'out.bin');
    const result = await downloadToFile(`${ctx.base}/redirect`, dest, {
      expectedSha256: HASH,
      hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
    });
    expect(result.sha256).toBe(HASH);
  });

  it('rejects redirects to non-allowlisted hosts', async () => {
    const dest = join(ctx.dir, 'out.bin');
    await expect(
      downloadToFile(`${ctx.base}/redirect-external`, dest, {
        expectedSha256: HASH,
        hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
      }),
    ).rejects.toThrow(/白名单/);
    expect(existsSync(dest)).toBe(false);
  });

  it('bails out on redirect loops', async () => {
    const dest = join(ctx.dir, 'out.bin');
    await expect(
      downloadToFile(`${ctx.base}/loop`, dest, {
        expectedSha256: HASH,
        hostAllowlist: new Set(['127.0.0.1']),
      allowedProtocols: new Set(['http:', 'https:']),
        maxRedirects: 4,
      }),
    ).rejects.toThrow(/重定向次数超过上限/);
    expect(existsSync(dest)).toBe(false);
  });

  it('aborts a stalled BODY read via the timeout (regression: timeout must cover body streaming)', async () => {
    const dest = join(ctx.dir, 'out.bin');
    const started = Date.now();
    await expect(
      downloadToFile(`${ctx.base}/stall`, dest, {
        hostAllowlist: new Set(['127.0.0.1']),
        allowedProtocols: new Set(['http:', 'https:']),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/下载超时|下载失败|abort/i);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000); // must not hang until the test timeout
    expect(existsSync(dest)).toBe(false);
    const leftovers = (await import('node:fs')).readdirSync(ctx.dir).filter((f) => f.includes('.part'));
    expect(leftovers).toEqual([]);
  });
});