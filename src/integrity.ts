import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CliError } from './errors.js';

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha1Buffer(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export interface TreeEntry {
  path: string; // forward-slash relative path
  size: number;
  sha256: string;
}

export type TreeEntryKind = 'dir' | 'file' | 'other';

/** Classify a dirent; any non-regular/non-directory kind is 'other' (fail-closed). */
export function entryKind(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): TreeEntryKind {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return 'other';
}

/** Walk a directory and compute {relPath(forward-slash): sha256} for every file. */
export async function sha256Tree(
  root: string,
  readdirImpl: typeof readdirSync = readdirSync,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirImpl(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split('\\').join('/');
      const kind = entryKind(entry);
      if (kind === 'dir') {
        stack.push(abs);
      } else if (kind === 'file') {
        result.set(rel, await sha256File(abs));
      } else {
        throw new CliError(`完整性校验拒绝非常规条目（可能是符号链接）：${rel}`);
      }
    }
  }
  return result;
}

export interface TreeMismatch {
  kind: 'missing' | 'extra' | 'hash';
  path: string;
  expected?: string;
  actual?: string;
}

/** Two-way comparison: expected entries must exist with exact bytes; extra files are rejected. */
export async function compareTree(root: string, expected: Record<string, string>): Promise<{
  ok: boolean;
  mismatches: TreeMismatch[];
  fileCount: number;
}> {
  const actual = await sha256Tree(root);
  const mismatches: TreeMismatch[] = [];
  for (const [path, hash] of Object.entries(expected)) {
    const real = actual.get(path);
    if (real === undefined) {
      mismatches.push({ kind: 'missing', path });
    } else if (real !== hash) {
      mismatches.push({ kind: 'hash', path, expected: hash, actual: real });
    }
  }
  for (const path of actual.keys()) {
    if (!(path in expected)) {
      mismatches.push({ kind: 'extra', path });
    }
  }
  return { ok: mismatches.length === 0, mismatches, fileCount: Object.keys(expected).length };
}

export async function assertTreeMatches(
  root: string,
  expected: Record<string, string>,
  what: string,
): Promise<number> {
  const { ok, mismatches, fileCount } = await compareTree(root, expected);
  if (!ok) {
    const sample = mismatches
      .slice(0, 10)
      .map((m) => `[${m.kind}] ${m.path}`)
      .join('\n');
    throw new CliError(`${what} 完整性校验失败（${mismatches.length} 项）：\n${sample}`);
  }
  return fileCount;
}

export function fileSize(file: string): number {
  return statSync(file).size;
}