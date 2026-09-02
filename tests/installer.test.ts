import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPipeline } from '../src/installer.js';
import { sha256Buffer } from '../src/integrity.js';
import type { VersionRoute } from '../src/routes.js';
import type { ProjectInfo } from '../src/projectVersion.js';
import type { EditorGuardResult } from '../src/unityGuard.js';

const FILES = { 'package.json': Buffer.from('{"name":"com.unity.pipeline"}'), 'lib.cs': Buffer.from('class L {}') };
const HASHES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([k, v]) => [k, sha256Buffer(v)]),
);

const route = {
  schemaVersion: 1,
  editorVersion: '2022.3.62f3c1',
  editorRevision: '1623fc0bbb97',
  cli: {} as never,
  pipeline: { version: '0.5.0-exp.1', patchVersion: 1 } as never,
} as unknown as VersionRoute;

interface Ctx {
  dir: string;
  project: string;
  source: string;
}
let ctx: Ctx;

function writeTree(root: string): void {
  mkdirSync(join(root, 'sub'), { recursive: true });
  for (const [rel, bytes] of Object.entries(FILES)) {
    writeFileSync(join(root, rel), bytes);
  }
}

function makeProjectInfo(): ProjectInfo {
  mkdirSync(join(ctx.project, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(ctx.project, 'Packages'), { recursive: true });
  writeFileSync(
    join(ctx.project, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n',
  );
  return {
    projectPath: ctx.project,
    editorVersion: '2022.3.62f3c1',
    revision: '1623fc0bbb97',
    versionFile: join(ctx.project, 'ProjectSettings', 'ProjectVersion.txt'),
  };
}

function okGuard(): (p: string) => Promise<EditorGuardResult> {
  return async () => ({ ok: true, blockedBy: [] });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'epc-inst-'));
  const project = join(dir, 'project');
  const source = join(dir, 'source');
  mkdirSync(project, { recursive: true });
  writeTree(source);
  ctx = { dir, project, source };
});

afterEach(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

describe('installPipeline', () => {
  it('installs fresh, verifies, and writes a receipt', async () => {
    const info = makeProjectInfo();
    const result = await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard() });
    expect(result.status).toBe('Installed');
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    for (const [rel, bytes] of Object.entries(FILES)) {
      expect(readFileSync(join(dest, rel))).toEqual(bytes);
    }
    const receiptPath = join(ctx.project, 'Library', 'editor-pipeline-cli', 'receipt.json');
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      pipelineVersion: '0.5.0-exp.1',
      patchVersion: 1,
    });
  });

  it('is idempotent without force', async () => {
    const info = makeProjectInfo();
    await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard() });
    const second = await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard() });
    expect(second.status).toBe('AlreadyInstalled');
  });

  it('refuses an inconsistent existing package without force', async () => {
    const info = makeProjectInfo();
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"tampered":true}');
    await expect(
      installPipeline(info, route, ctx.source, HASHES, { guard: okGuard() }),
    ).rejects.toThrow(/不一致或已损坏/);
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe('{"tampered":true}');
  });

  it('backups the previous package when forcing', async () => {
    const info = makeProjectInfo();
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"old":true}');
    const result = await installPipeline(info, route, ctx.source, HASHES, {
      guard: okGuard(),
      force: true,
    });
    expect(result.status).toBe('Installed');
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(join(result.backupPath!, 'package.json'), 'utf8')).toBe('{"old":true}');
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe('{"name":"com.unity.pipeline"}');
  });

  it('rolls back to the original package when a later step fails', async () => {
    const info = makeProjectInfo();
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"original":true}');
    // Break the receipt step: Library/editor-pipeline-cli already exists as a FILE.
    const libRoot = join(ctx.project, 'Library');
    mkdirSync(libRoot, { recursive: true });
    writeFileSync(join(libRoot, 'editor-pipeline-cli'), 'i am a file');
    await expect(
      installPipeline(info, route, ctx.source, HASHES, { guard: okGuard(), force: true }),
    ).rejects.toThrow(/已回滚|EEXIST|ENOTDIR|EISDIR/);
    // Original package restored, no staging leftovers.
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe('{"original":true}');
    const staging = readdirSync(join(libRoot)).filter((f) => f.startsWith('staging-'));
    expect(staging).toEqual([]);
  });

  it('cleans a PARTIAL destination copy and restores the backup (rollback)', async () => {
    const info = makeProjectInfo();
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"original":true}');
    writeFileSync(join(dest, 'original-only.txt'), 'original content');
    // The staged->destination copy simulates a mid-copy failure (disk full / AV):
    // it writes a partial file tree and then throws. This is the repaired path
    // the reviewer flagged: destMoved=true + destTouched mid-copy must roll back.
    let calls = 0;
    const partialCopy = async (src: string, dst: string): Promise<void> => {
      calls += 1;
      if (calls === 2) {
        mkdirSync(dst, { recursive: true });
        writeFileSync(join(dst, 'partial.txt'), 'partial');
        throw new Error('simulated partial copy failure');
      }
      const { cp } = await import('node:fs/promises');
      await cp(src, dst, { recursive: true });
    };
    await expect(
      installPipeline(info, route, ctx.source, HASHES, { guard: okGuard(), force: true, copy: partialCopy }),
    ).rejects.toThrow(/已回滚|simulated partial copy failure/);
    // No partial file may remain; the ORIGINAL package must be fully restored.
    expect(existsSync(join(dest, 'partial.txt'))).toBe(false);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe('{"original":true}');
    expect(readFileSync(join(dest, 'original-only.txt'), 'utf8')).toBe('original content');
    // The staged NEW content must not have leaked into the destination.
    expect(existsSync(join(dest, 'lib.cs'))).toBe(false);
  });

  it('cleans a partial fresh install (no previous package) on copy failure', async () => {
    const info = makeProjectInfo();
    let calls = 0;
    const partialCopy = async (src: string, dst: string): Promise<void> => {
      calls += 1;
      if (calls === 2) {
        mkdirSync(dst, { recursive: true });
        writeFileSync(join(dst, 'partial.txt'), 'partial');
        throw new Error('boom');
      }
      const { cp } = await import('node:fs/promises');
      await cp(src, dst, { recursive: true });
    };
    await expect(
      installPipeline(info, route, ctx.source, HASHES, { guard: okGuard(), copy: partialCopy }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(join(ctx.project, 'Packages', 'com.unity.pipeline'))).toBe(false);
    expect(existsSync(join(ctx.project, 'Library', 'editor-pipeline-cli', 'receipt.json'))).toBe(false);
  });

  it('dry-run returns DryRun even when a valid package is already installed', async () => {
    const info = makeProjectInfo();
    await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard() });
    const dry = await installPipeline(info, route, ctx.source, HASHES, {
      guard: okGuard(),
      dryRun: true,
    });
    expect(dry.status).toBe('DryRun');
  });

  it('creates collision-free backup names on rapid successive installs', async () => {
    const info = makeProjectInfo();
    const dest = join(ctx.project, 'Packages', 'com.unity.pipeline');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"old":true}');
    await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard(), force: true });
    // Tamper, then force again immediately (same millisecond window is possible).
    writeFileSync(join(dest, 'package.json'), '{"old2":true}');
    await installPipeline(info, route, ctx.source, HASHES, { guard: okGuard(), force: true });
    const backups = readdirSync(join(ctx.project, 'Library', 'editor-pipeline-cli', 'backups'));
    expect(backups.length).toBe(2);
    expect(new Set(backups).size).toBe(2); // distinct names
    for (const name of backups) {
      const content = readFileSync(join(ctx.project, 'Library', 'editor-pipeline-cli', 'backups', name, 'package.json'), 'utf8');
      expect(['{"old":true}', '{"old2":true}']).toContain(content);
    }
  });

  it('is blocked by the editor guard (fail-closed)', async () => {
    const info = makeProjectInfo();
    const guard = async () => ({ ok: false, blockedBy: ['PID 1234'] });
    await expect(installPipeline(info, route, ctx.source, HASHES, { guard })).rejects.toThrow(
      /PID 1234/,
    );
    expect(existsSync(join(ctx.project, 'Packages', 'com.unity.pipeline'))).toBe(false);
  });

  it('respects --allow-running-editor override', async () => {
    const info = makeProjectInfo();
    const guard = async () => ({ ok: false, blockedBy: ['PID 1234'] });
    const result = await installPipeline(info, route, ctx.source, HASHES, {
      guard,
      allowRunningEditor: true,
    });
    expect(result.status).toBe('Installed');
  });

  it('dry-run writes nothing', async () => {
    const info = makeProjectInfo();
    const result = await installPipeline(info, route, ctx.source, HASHES, {
      guard: okGuard(),
      dryRun: true,
    });
    expect(result.status).toBe('DryRun');
    expect(existsSync(join(ctx.project, 'Packages', 'com.unity.pipeline'))).toBe(false);
    expect(existsSync(join(ctx.project, 'Library', 'editor-pipeline-cli'))).toBe(false);
  });
});
