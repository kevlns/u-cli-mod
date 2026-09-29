import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Buffer } from '../src/integrity.js';
import { compareTree, assertTreeMatches, sha256Tree, entryKind } from '../src/integrity.js';

interface Ctx {
  dir: string;
  root: string;
}
let ctx: Ctx;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'epc-int-'));
  const root = join(dir, 'tree');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'aaa');
  writeFileSync(join(root, 'sub', 'b.bin'), Buffer.from([1, 2, 3]));
  ctx = { dir, root };
});

afterEach(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

function expectedMap(): Record<string, string> {
  return {
    'a.txt': sha256Buffer(Buffer.from('aaa')),
    'sub/b.bin': sha256Buffer(Buffer.from([1, 2, 3])),
  };
}

describe('integrity', () => {
  it.each(['lf', 'crlf'])('accepts only EOL drift in installed UTF-8 text (%s baseline)', async (baseline) => {
    const lf = '\uFEFFclass 示例 {\n    // preserved whitespace  \n}\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const expectedText = baseline === 'lf' ? lf : crlf;
    const actualText = baseline === 'lf' ? crlf : lf;
    writeFileSync(join(ctx.root, 'example.cs'), actualText);
    const expected = { ...expectedMap(), 'example.cs': sha256Buffer(Buffer.from(expectedText)) };
    expect((await compareTree(ctx.root, expected)).ok).toBe(false);
    const result = await compareTree(ctx.root, expected, { allowTextLineEndings: true });
    expect(result.ok).toBe(true);
    expect(result.lineEndingDifferences).toEqual(['example.cs']);
    expect(fs.readFileSync(join(ctx.root, 'example.cs'), 'utf8')).toBe(actualText);
  });

  it.each([
    ['example.cs', 'class A {\n}\n', 'class B {\r\n}\r\n'],
    ['example.cs', 'class A {\n}\n', 'class A {\r\n}'],
    ['example.cs', 'class A {\n}\n', 'class A { \r\n}\r\n'],
    ['example.cs', 'class A {\n}\n', '\uFEFFclass A {\r\n}\r\n'],
    ['example.dll', 'abc\n', 'abc\r\n'],
    ['example.cs', 'abc\0\n', 'abc\0\r\n'],
  ])('still rejects content or binary drift in %s', async (name, expectedText, actualText) => {
    writeFileSync(join(ctx.root, name), actualText);
    const expected = { ...expectedMap(), [name]: sha256Buffer(Buffer.from(expectedText)) };
    expect((await compareTree(ctx.root, expected, { allowTextLineEndings: true })).ok).toBe(false);
  });

  it('does not decode invalid UTF-8 as replacement characters', async () => {
    writeFileSync(join(ctx.root, 'example.cs'), Buffer.from([0xff, 0x0d, 0x0a]));
    const expected = { ...expectedMap(), 'example.cs': sha256Buffer(Buffer.from('\uFFFD\n')) };
    expect((await compareTree(ctx.root, expected, { allowTextLineEndings: true })).ok).toBe(false);
  });

  it('recognizes the pinned package CHECKSUMS text without relaxing unknown binary names', async () => {
    writeFileSync(join(ctx.root, 'CHECKSUMS'), 'sha256 file.dll\r\n');
    const expected = { ...expectedMap(), CHECKSUMS: sha256Buffer(Buffer.from('sha256 file.dll\n')) };
    expect((await compareTree(ctx.root, expected, { allowTextLineEndings: true })).ok).toBe(true);
    writeFileSync(join(ctx.root, 'unknown'), 'binary\r\n');
    expected.unknown = sha256Buffer(Buffer.from('binary\n'));
    expect((await compareTree(ctx.root, expected, { allowTextLineEndings: true })).ok).toBe(false);
  });

  it('matches a clean tree both ways', async () => {
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(2);
  });

  it('flags missing files', async () => {
    rmSync(join(ctx.root, 'a.txt'));
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'missing' && m.path === 'a.txt')).toBe(true);
  });

  it('flags extra files', async () => {
    writeFileSync(join(ctx.root, 'extra.txt'), 'x');
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'extra' && m.path === 'extra.txt')).toBe(true);
  });

  it('flags content tampering', async () => {
    writeFileSync(join(ctx.root, 'a.txt'), 'AAB');
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === 'hash' && m.path === 'a.txt')).toBe(true);
  });

  it('reports multiple mismatch kinds together', async () => {
    rmSync(join(ctx.root, 'sub', 'b.bin'));
    writeFileSync(join(ctx.root, 'a.txt'), 'changed');
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(false);
    const kinds = result.mismatches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['hash', 'missing']);
  });

  it('assertTreeMatches returns the expected count', async () => {
    const count = await assertTreeMatches(ctx.root, expectedMap(), '测试树');
    expect(count).toBe(2);
  });

  it('assertTreeMatches throws on mismatch', async () => {
    rmSync(ctx.root, { recursive: true });
    mkdirSync(ctx.root);
    await expect(assertTreeMatches(ctx.root, expectedMap(), '测试树')).rejects.toThrow(/完整性校验失败/);
  });
});

describe('integrity non-regular entries (fail-closed)', () => {
  it('entryKind classifies dir/file/other', () => {
    const mk = (over: Record<string, unknown>) => ({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      ...over,
    });
    expect(entryKind(mk({ isFile: () => true }) as never)).toBe('file');
    expect(entryKind(mk({ isDirectory: () => true }) as never)).toBe('dir');
    expect(entryKind(mk({ isSymbolicLink: () => true }) as never)).toBe('other');
    expect(entryKind(mk({ isFIFO: () => true }) as never)).toBe('other');
    expect(entryKind(mk({ isSocket: () => true }) as never)).toBe('other');
  });

  it('sha256Tree rejects a symlink/non-regular entry instead of silently skipping it', async () => {
    const fakeSymlink = {
      name: 'link.txt',
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
      isFIFO: () => false,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
    } as unknown as fs.Dirent;
    const fakeReaddir = (() => [fakeSymlink]) as unknown as typeof fs.readdirSync;
    await expect(sha256Tree(ctx.root, fakeReaddir)).rejects.toThrow(/非常规条目/);
  });

  it('compareTree still passes for a plain tree', async () => {
    const result = await compareTree(ctx.root, expectedMap());
    expect(result.ok).toBe(true);
  });
});
