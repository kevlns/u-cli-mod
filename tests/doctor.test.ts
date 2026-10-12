import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/commands/doctor.js';
import * as routes from '../src/routes.js';
import { sha256Buffer } from '../src/integrity.js';

const roots: string[] = [];

function makeProjectWithReceipt(patchVersion: number): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'epc-doctor-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(project, 'Packages', 'com.unity.pipeline'), { recursive: true });
  mkdirSync(join(project, 'Library', 'editor-pipeline-cli'), { recursive: true });
  writeFileSync(
    join(project, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.59f1c1\n' +
      'm_EditorVersionWithRevision: 2022.3.59f1c1 (6f0f5d6fe989)\n',
  );
  writeFileSync(
    join(project, 'Packages', 'com.unity.pipeline', 'package.json'),
    '{"name":"com.unity.pipeline","version":"0.5.0-exp.1"}',
  );
  writeFileSync(
    join(project, 'Library', 'editor-pipeline-cli', 'receipt.json'),
    JSON.stringify({
      pipelineVersion: '0.5.0-exp.1',
      source: `com.unity.pipeline@0.5.0-exp.1 (patched ${patchVersion})`,
    }),
  );
  return { root, project };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.LOCALAPPDATA;
});

describe('runDoctor pipeline state', () => {
  it.each(['old', 'missing', 'malformed', 'current'])('trusts verified content with a %s receipt and reports EOL drift', async (receiptState) => {
    const { root, project } = makeProjectWithReceipt(receiptState === 'old' ? 2 : 3);
    process.env.LOCALAPPDATA = join(root, 'local-app-data');
    const packageRoot = join(project, 'Packages', 'com.unity.pipeline');
    const receipt = join(project, 'Library', 'editor-pipeline-cli', 'receipt.json');
    if (receiptState === 'missing') rmSync(receipt);
    if (receiptState === 'malformed') writeFileSync(receipt, '{broken');
    writeFileSync(join(packageRoot, 'lib.cs'), 'class L {\r\n}\r\n');
    vi.spyOn(routes, 'loadExpectedTree').mockReturnValue({
      algorithm: 'SHA256', entries: 2, files: {
        'package.json': sha256Buffer(readFileSync(join(packageRoot, 'package.json'))),
        'lib.cs': sha256Buffer(Buffer.from('class L {\n}\n')),
      },
    });
    const result = await runDoctor(project, { allowRunningEditor: true });
    expect(result.pipeline).toMatchObject({
      installed: true, state: 'current',
      verification: { ok: true, mismatches: [], lineEndingDifferences: ['lib.cs'], error: null },
    });
    expect(readFileSync(join(packageRoot, 'lib.cs'), 'utf8')).toBe('class L {\r\n}\r\n');
    writeFileSync(join(packageRoot, 'lib.cs'), 'class Changed {\r\n}\r\n');
    const changed = await runDoctor(project, { allowRunningEditor: true });
    expect(changed.pipeline.installed).toBe(false);
    expect(changed.pipeline.verification.mismatches).toContainEqual(expect.objectContaining({ kind: 'hash', path: 'lib.cs' }));
  });

  it('reports an older installed patch as outdated instead of installed', async () => {
    const { root, project } = makeProjectWithReceipt(1);
    process.env.LOCALAPPDATA = join(root, 'local-app-data');

    const result = await runDoctor(project, { allowRunningEditor: true });

    expect(result.pipeline).toMatchObject({
      version: '0.5.0-exp.1',
      patchVersion: 3,
      sourceReady: false,
      present: true,
      installed: false,
      state: 'outdated',
      installedPatchVersion: 1,
    });
  });

  it('reports a current receipt with a mismatched package tree as invalid', async () => {
    const { root, project } = makeProjectWithReceipt(3);
    process.env.LOCALAPPDATA = join(root, 'local-app-data');

    const result = await runDoctor(project, { allowRunningEditor: true });

    expect(result.pipeline).toMatchObject({
      patchVersion: 3,
      present: true,
      installed: false,
      state: 'invalid',
      installedPatchVersion: 3,
    });
  });
});
