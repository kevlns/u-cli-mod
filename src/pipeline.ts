import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.js';
import { sha1Buffer, sha256Buffer } from './integrity.js';
import { downloadToFile } from './download.js';
import { list, extract } from 'tar';
import type { PipelineRoute } from './routes.js';

/** Download + verify pinned pipeline tgz (SHA-256 primary, SHA-1 cross-check). */
export async function ensurePipelineTgz(
  tgzPath: string,
  route: PipelineRoute,
  { force = false, hostAllowlist }: { force?: boolean; hostAllowlist?: Set<string> } = {},
): Promise<{ file: string; state: 'valid' | 'downloaded' }> {
  if (!force && existsSync(tgzPath)) {
    const buf = readFileSync(tgzPath);
    const sha1 = sha1Buffer(buf);
    const sha256 = sha256Buffer(buf);
    const want1 = route.sha1.toLowerCase();
    const want256 = route.sha256.toLowerCase();
    if (sha1 === want1 && sha256 === want256) {
      return { file: tgzPath, state: 'valid' };
    }
    // sha1/sha256 mismatch -> treat as corrupt, redownload
    rmSync(tgzPath, { force: true });
  }
  await downloadToFile(route.url, tgzPath, {
    expectedSha256: route.sha256,
    expectedSize: route.expectedSize,
    hostAllowlist,
  });
  const buf = readFileSync(tgzPath);
  const sha1 = sha1Buffer(buf);
  if (sha1 !== route.sha1.toLowerCase()) {
    rmSync(tgzPath, { force: true });
    throw new CliError(`Pipeline tgz SHA-1 交叉校验失败。期望 ${route.sha1}，实际 ${sha1}`);
  }
  return { file: tgzPath, state: 'downloaded' };
}

function assertSafeEntryPath(entryPath: string): void {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new CliError(`解包拒绝绝对路径：${entryPath}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new CliError(`解包拒绝路径穿越：${entryPath}`);
  }
}

function assertSafeEntryType(type: string, entryPath: string): void {
  switch (type) {
    case 'File':
    case 'Directory':
      return;
    case 'SymbolicLink':
    case 'Link':
      throw new CliError(`解包拒绝符号链接/硬链接：${entryPath}`);
    default:
      throw new CliError(`解包拒绝非常规条目类型 ${type}：${entryPath}`);
  }
}

function validateTarEntry(entryPath: string, type: string): void {
  assertSafeEntryPath(entryPath);
  assertSafeEntryType(type, entryPath);
}

/**
 * Safe extraction via the maintained `tar` package (no system-tar dependency):
 * every entry is validated BEFORE anything is written (listing pass), then the
 * extract pass re-validates each entry with a filter that throws before write.
 */
export async function extractTgz(
  tgz: string,
  targetRoot: string,
): Promise<void> {
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  try {
    // Pass 1: list and collect every entry BEFORE any write; reject unsafe
    // paths/types as a whole once the (pure) listing pass has completed.
    const seen: Array<{ path: string; type: string }> = [];
    await list({
      file: tgz,
      strict: true,
      preservePaths: true,
      onReadEntry: (entry: { path: string; type: string }) => {
        seen.push({ path: entry.path, type: entry.type });
      },
    });
    for (const entry of seen) {
      validateTarEntry(entry.path, entry.type);
    }
    // Pass 2: extract; the filter re-validates at parse time and throws before
    // any offending entry is written.
    await extract({
      file: tgz,
      cwd: targetRoot,
      strict: true,
      preservePaths: true,
      filter: (entryPath, entry) => {
        validateTarEntry(entryPath, (entry as { type: string }).type);
        return true;
      },
    });
  } catch (err) {
    rmSync(targetRoot, { recursive: true, force: true });
    throw new CliError(
      `tgz 解包失败或包含不安全条目：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Defensive post-walk: no symlinks or non-regular files may exist in the tree.
  const stack = [targetRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (!entry.isFile()) {
        throw new CliError(`解包后存在非普通文件，拒绝：${abs}`);
      }
    }
  }
}

/** Locate the package root inside an extraction (top-level `package/` or in-place). */
export function resolveExtractedPackageDir(extractRoot: string): string {
  const packageSubdir = join(extractRoot, 'package');
  if (existsSync(join(packageSubdir, 'package.json'))) {
    return packageSubdir;
  }
  if (existsSync(join(extractRoot, 'package.json'))) {
    return extractRoot;
  }
  throw new CliError(`tgz 解包内容缺少 package.json：${extractRoot}`);
}

export function writeMarker(file: string, content: string): void {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  if (slash > 0) {
    mkdirSync(file.slice(0, slash), { recursive: true });
  }
  writeFileSync(file, content, 'utf8');
}

export function verifyMarker(file: string, expected: string): boolean {
  try {
    return existsSync(file) && readFileSync(file, 'utf8') === expected;
  } catch {
    return false;
  }
}