import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { CliError } from './errors.js';
import { sha256File, fileSize } from './integrity.js';

/** Trusted download endpoints: Unity's public CDN and its China redirect target. */
export const DEFAULT_HOST_ALLOWLIST = new Set([
  'public-cdn.cloud.unity3d.com',
  'download.packages.unity.com',
  'public-cdn.cloud.unitychina.cn',
  // Real redirect target observed for com.unity.pipeline tarballs.
  'cdn.packages.unity.com',
]);

export const MAX_REDIRECTS = 5;
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export interface DownloadOptions {
  expectedSha256?: string;
  expectedSize?: number;
  hostAllowlist?: Set<string>;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Defaults to HTTPS-only. Tests may allow http on loopback with an explicit allowlist. */
  allowedProtocols?: ReadonlySet<string>;
}

export interface DownloadResult {
  file: string;
  size: number;
  sha256: string;
  finalUrl: string;
}

function assertHostAllowed(
  url: URL,
  allowlist: Set<string>,
  allowedProtocols: ReadonlySet<string>,
): void {
  if (!allowedProtocols.has(url.protocol)) {
    throw new CliError(`拒绝非 HTTPS 下载源：${url.protocol}//${url.host}`);
  }
  if (!allowlist.has(url.hostname.toLowerCase())) {
    throw new CliError(`下载主机不在白名单内：${url.hostname}`);
  }
}

/**
 * Download to a temporary file, verify size + sha256, then atomically rename.
 * Any failure removes the temp file; an existing destination is never touched.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const allowlist = options.hostAllowlist ?? DEFAULT_HOST_ALLOWLIST;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const allowedProtocols = options.allowedProtocols ?? new Set(['https:']);

  const destDir = dirname(destination);
  mkdirSync(destDir, { recursive: true });
  const tempFile = join(destDir, `${basename(destination)}.download-${randomUUID()}.part`);

  try {
    let current = new URL(url);
    let finalUrl = current.toString();
    let size = 0;
    let hash: string | null = null;

    for (let hop = 0; ; hop++) {
      assertHostAllowed(current, allowlist, allowedProtocols);
      // The abort timer stays armed through the whole hop, including the body
      // stream, so a stalled/slow body cannot hang the download forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs);
      try {
        const response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'u-cli/0.1' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new CliError(`重定向缺少 Location：${current}`);
          }
          if (hop >= maxRedirects) {
            throw new CliError(`重定向次数超过上限（${maxRedirects}）`);
          }
          current = new URL(location, current);
          finalUrl = current.toString();
          continue;
        }
        if (!response.ok || !response.body) {
          throw new CliError(`下载失败 HTTP ${response.status}：${current}`);
        }

        const out = createWriteStream(tempFile, { flags: 'w' });
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > (options.expectedSize ?? MAX_DOWNLOAD_BYTES) * 2) {
              throw new CliError(`下载内容超过预期大小：${size} bytes`);
            }
            if (!out.write(chunk)) {
              await new Promise<void>((resolve) => out.once('drain', () => resolve()));
            }
          }
        } finally {
          out.end();
          await new Promise<void>((resolve) => out.once('close', () => resolve()));
        }

        if (options.expectedSize !== undefined && size !== options.expectedSize) {
          throw new CliError(`文件大小不匹配：期望 ${options.expectedSize}，实际 ${size}`);
        }
        if (options.expectedSha256) {
          hash = await sha256File(tempFile);
          if (hash !== options.expectedSha256.toLowerCase()) {
            throw new CliError(`SHA-256 校验失败。期望 ${options.expectedSha256}，实际 ${hash}`);
          }
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    renameSync(tempFile, destination);
    return { file: destination, size, sha256: hash ?? (await sha256File(destination)), finalUrl };
  } catch (err) {
    rmSync(tempFile, { force: true });
    if (err instanceof CliError) throw err;
    throw new CliError(`下载失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export { fileSize };