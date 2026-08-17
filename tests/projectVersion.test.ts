import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectVersion, readProjectInfo } from '../src/projectVersion.js';

describe('parseProjectVersion', () => {
  it('parses version and revision', () => {
    const out = parseProjectVersion(
      'm_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n',
    );
    expect(out).toEqual({ version: '2022.3.62f3c1', revision: '1623fc0bbb97' });
  });

  it('rejects missing m_EditorVersion', () => {
    expect(() => parseProjectVersion('m_EditorVersionWithRevision: x (y)\n')).toThrow(
      /m_EditorVersion/,
    );
  });

  it('returns null revision when the WithRevision line is absent', () => {
    const out = parseProjectVersion('m_EditorVersion: 2022.3.62f3c1\n');
    expect(out).toEqual({ version: '2022.3.62f3c1', revision: null });
  });

  it('returns null revision when the line has no revision group', () => {
    const out = parseProjectVersion(
      'm_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: garbage\n',
    );
    expect(out.revision).toBeNull();
  });

  it('tolerates CRLF line endings', () => {
    const out = parseProjectVersion(
      'm_EditorVersion: 2022.3.62f3c1\r\nm_EditorVersionWithRevision: 2022.3.62f3c1 (abc123)\r\n',
    );
    expect(out).toEqual({ version: '2022.3.62f3c1', revision: 'abc123' });
  });

  it('rejects path-traversal/spurious m_EditorVersion values (fail-closed)', () => {
    for (const bad of ['../foo', '..\\..\\package', '/etc/passwd', 'C:\\windows', 'a b', 'x']) {
      expect(() => parseProjectVersion(`m_EditorVersion: ${bad}\n`)).toThrow(/格式非法/);
    }
  });

  it('accepts the current route version format', () => {
    for (const good of ['2022.3.62f3c1', '2022.3.62f3', '6000.0.23f1', '2021.3.45f1']) {
      expect(parseProjectVersion(`m_EditorVersion: ${good}\n`).version).toBe(good);
    }
  });
});

describe('readProjectInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'epc-pv-'));
    mkdirSync(join(dir, 'ProjectSettings'), { recursive: true });
    writeFileSync(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a relative project path to an absolute path', () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const info = readProjectInfo('.');
      expect(info.projectPath).toBe(dir.replace(/[\\/]+$/, ''));
    } finally {
      process.chdir(cwd);
    }
  });

  it('keeps abs path normalized without trailing slashes', () => {
    const info = readProjectInfo(`${dir}\\`);
    expect(info.projectPath).toBe(dir);
  });
});