import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/commands/doctor.js';

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.LOCALAPPDATA;
});

describe('runDoctor pipeline state', () => {
  it('reports an older installed patch as outdated instead of installed', async () => {
    const { root, project } = makeProjectWithReceipt(1);
    process.env.LOCALAPPDATA = join(root, 'local-app-data');

    const result = await runDoctor(project, { allowRunningEditor: true });

    expect(result.pipeline).toMatchObject({
      version: '0.5.0-exp.1',
      patchVersion: 2,
      sourceReady: false,
      present: true,
      installed: false,
      state: 'outdated',
      installedPatchVersion: 1,
    });
  });

  it('reports a current receipt with a mismatched package tree as invalid', async () => {
    const { root, project } = makeProjectWithReceipt(2);
    process.env.LOCALAPPDATA = join(root, 'local-app-data');

    const result = await runDoctor(project, { allowRunningEditor: true });

    expect(result.pipeline).toMatchObject({
      patchVersion: 2,
      present: true,
      installed: false,
      state: 'invalid',
      installedPatchVersion: 2,
    });
  });
});
