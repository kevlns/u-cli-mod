import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTgz, resolveExtractedPackageDir, ensurePipelineTgz } from '../src/pipeline.js';
import { sha1Buffer, sha256Buffer } from '../src/integrity.js';
import type { PipelineRoute } from '../src/routes.js';

interface Ctx {
  dir: string;
  target: string;
}
let ctx: Ctx;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'epc-tar-'));
  ctx = { dir, target: join(dir, 'out') };
});

afterEach(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

function checksummedHeader(header: Buffer): Buffer {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

/** Minimal ustar entry (max 100-char names, no pax), enough for node-tar to parse. */
function ustarEntry(
  name: string,
  type: '0' | '1' | '2' | '5' | '6',
  content?: Buffer,
  linkName = '',
): Buffer {
  const header = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error('test tar name too long');
  nameBuf.copy(header, 0);
  header.write('0000644', 100, 'ascii');
  header.write('0000000', 108, 'ascii');
  header.write('0000000', 116, 'ascii');
  const size = content?.length ?? 0;
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000', 136, 'ascii');
  header.write(type, 156, 'ascii');
  const linkBuf = Buffer.from(linkName, 'utf8');
  if (linkBuf.length > 100) throw new Error('test tar linkname too long');
  linkBuf.copy(header, 157);
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  checksummedHeader(header);
  const chunks = [header];
  if (content) {
    chunks.push(content);
    const pad = (512 - (size % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  return Buffer.concat(chunks);
}

function makeTar(entries: Array<{ name: string; type: '0' | '1' | '2' | '5' | '6'; content?: Buffer; linkName?: string }>): Buffer {
  const chunks: Buffer[] = entries.map((e) => ustarEntry(e.name, e.type, e.content, e.linkName));
  chunks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(chunks);
}

function writeTar(name: string, buf: Buffer): string {
  const file = join(ctx.dir, name);
  writeFileSync(file, buf);
  return file;
}

function listTarTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('extractTgz (safe extraction)', () => {
  it('extracts a benign package tree', async () => {
    const tgz = writeTar(
      'ok.tgz',
      makeTar([
        { name: 'package/', type: '5' },
        { name: 'package/package.json', type: '0', content: Buffer.from('{"name":"com.unity.pipeline"}') },
        { name: 'package/Runtime/', type: '5' },
        { name: 'package/Runtime/readme.txt', type: '0', content: Buffer.from('hello') },
      ]),
    );
    await extractTgz(tgz, ctx.target);
    expect(new Set(listTarTree(ctx.target))).toEqual(
      new Set(['package/package.json', 'package/Runtime/readme.txt']),
    );
    expect(readFileSync(join(ctx.target, 'package', 'package.json'), 'utf8')).toBe(
      '{"name":"com.unity.pipeline"}',
    );
  });

  it('rejects ../ path traversal entries BEFORE writing anything', async () => {
    const tgz = writeTar(
      'dotdot.tgz',
      makeTar([
        { name: 'safe.txt', type: '0', content: Buffer.from('x') },
        { name: '../evil.txt', type: '0', content: Buffer.from('pwned') },
      ]),
    );
    await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/路径穿越/);
    // Nothing (not even safe.txt) may have been extracted; the target is wiped.
    expect(existsSync(ctx.target)).toBe(false);
    expect(existsSync(join(ctx.dir, 'evil.txt'))).toBe(false);
  });

  it('rejects absolute path entries', async () => {
    for (const bad of ['/etc/evil.txt', 'C:/evil.txt']) {
      const tgz = writeTar(
        'abs.tgz',
        makeTar([{ name: bad, type: '0', content: Buffer.from('x') }]),
      );
      await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/绝对路径/);
      expect(existsSync(ctx.target)).toBe(false);
    }
  });

  it('rejects symlink entries', async () => {
    const tgz = writeTar(
      'symlink.tgz',
      makeTar([
        { name: 'target.txt', type: '0', content: Buffer.from('x') },
        { name: 'link', type: '2', linkName: 'target.txt' },
      ]),
    );
    await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/符号链接|硬链接/);
    expect(existsSync(ctx.target)).toBe(false);
  });

  it('rejects hardlink entries', async () => {
    const tgz = writeTar(
      'hardlink.tgz',
      makeTar([
        { name: 'a.txt', type: '0', content: Buffer.from('x') },
        { name: 'b.txt', type: '1', linkName: 'a.txt' },
      ]),
    );
    await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/符号链接|硬链接/);
    expect(existsSync(ctx.target)).toBe(false);
  });

  it('rejects fifo/device (non-regular) entries', async () => {
    const tgz = writeTar('fifo.tgz', makeTar([{ name: 'pipe', type: '6' }]));
    await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/非常规条目/);
    expect(existsSync(ctx.target)).toBe(false);
  });

  it('cleans targetRoot on failure', async () => {
    // A previously-populated target root must be wiped when extraction fails.
    mkdirSync(join(ctx.target, 'old'), { recursive: true });
    writeFileSync(join(ctx.target, 'old', 'leftover.txt'), 'x');
    const tgz = writeTar('dotdot2.tgz', makeTar([{ name: '../evil.txt', type: '0', content: Buffer.from('x') }]));
    await expect(extractTgz(tgz, ctx.target)).rejects.toThrow(/路径穿越/);
    expect(existsSync(ctx.target)).toBe(false);
  });
});

describe('resolveExtractedPackageDir', () => {
  it('resolves the top-level package/ directory', () => {
    mkdirSync(join(ctx.target, 'package'), { recursive: true });
    writeFileSync(join(ctx.target, 'package', 'package.json'), '{}');
    expect(resolveExtractedPackageDir(ctx.target)).toBe(join(ctx.target, 'package'));
  });

  it('resolves an in-place package root', () => {
    mkdirSync(ctx.target, { recursive: true });
    writeFileSync(join(ctx.target, 'package.json'), '{}');
    expect(resolveExtractedPackageDir(ctx.target)).toBe(ctx.target);
  });

  it('throws when package.json is missing', () => {
    mkdirSync(join(ctx.target, 'other'), { recursive: true });
    expect(() => resolveExtractedPackageDir(ctx.target)).toThrow(/缺少 package.json/);
  });
});

describe('ensurePipelineTgz (cache verification)', () => {
  const route = {
    packageName: 'com.unity.pipeline',
    version: '0.5.0-exp.1',
    upstreamRevision: 'rev',
    url: 'https://download.packages.unity.com/x.tgz',
    sha1: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    expectedTree: 'x.json',
    templates: 't',
    targetUnityVersion: '2022.3',
    patchVersion: 1,
  } as PipelineRoute;

  const good = Buffer.from('fake-tgz-bytes');
  const routeWithContent = {
    ...route,
    sha1: sha1Buffer(good),
    sha256: sha256Buffer(good),
  } as PipelineRoute;

  it('reuses a cached tgz only when BOTH sha1 and sha256 match', async () => {
    const tgzPath = join(ctx.dir, 'p.tgz');
    writeFileSync(tgzPath, good);
    const result = await ensurePipelineTgz(tgzPath, routeWithContent, { force: false });
    expect(result.state).toBe('valid');
  });

  it('discards a cached tgz whose sha1 OR sha256 mismatches', async () => {
    const tgzPath = join(ctx.dir, 'p.tgz');
    writeFileSync(tgzPath, good);
    // sha1 differs -> corrupt, redownload attempt should be made and fail
    // against the fake URL (proving the corrupt cache was removed).
    await expect(
      ensurePipelineTgz(tgzPath, { ...route, sha1: 'c'.repeat(40) } as PipelineRoute, {
        force: false,
        hostAllowlist: new Set<string>(),
      }),
    ).rejects.toThrow(/下载主机不在白名单内/);
    expect(existsSync(tgzPath)).toBe(false);
  });
});