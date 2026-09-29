import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readProjectInfo } from '../projectVersion.js';
import { resolveRouteForProject, listEditorVersions, loadExpectedTree } from '../routes.js';
import { cliBinaryPath, generatedPackageDir } from '../paths.js';
import { compareTree, sha256File } from '../integrity.js';
import type { TreeComparisonOptions } from '../integrity.js';
import { queryUnityProcesses } from '../unityGuard.js';

export interface DoctorOptions {
  allowRunningEditor?: boolean;
}

interface PipelineReceipt {
  patchVersion?: unknown;
  source?: unknown;
}

async function readInstalledPatchVersion(receiptPath: string): Promise<number | null> {
  if (!existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as PipelineReceipt;
    if (Number.isInteger(receipt.patchVersion) && Number(receipt.patchVersion) >= 0) {
      return Number(receipt.patchVersion);
    }
    if (typeof receipt.source === 'string') {
      const match = /\(patched\s+(\d+)\)/i.exec(receipt.source);
      if (match?.[1]) return Number.parseInt(match[1], 10);
    }
  } catch {
    // Unknown receipt metadata never bypasses the package tree verification.
  }
  return null;
}

async function inspectPackageTree(root: string, expected: Record<string, string>, options: TreeComparisonOptions = {}) {
  if (!existsSync(root)) return { ok: false, mismatches: [], lineEndingDifferences: [], error: 'Package directory is missing' };
  try {
    return { ...await compareTree(root, expected, options), error: null };
  } catch (err) {
    return { ok: false, mismatches: [], lineEndingDifferences: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runDoctor(projectPath: string, options: DoctorOptions = {}) {
  const project = readProjectInfo(projectPath);
  const route = resolveRouteForProject(project);
  const cliPath = cliBinaryPath(route.cli);
  let cliState = 'missing';
  if (existsSync(cliPath)) {
    const hash = await sha256File(cliPath);
    cliState = hash === route.cli.sha256.toLowerCase() ? 'valid' : 'hash-mismatch';
  }
  const generated = generatedPackageDir(project.editorVersion);
  const expectedTree = loadExpectedTree(project.editorVersion);
  const pipelineRoot = join(project.projectPath, 'Packages', 'com.unity.pipeline');
  const pipelinePresent = existsSync(join(pipelineRoot, 'package.json'));
  const receiptPath = join(project.projectPath, 'Library', 'editor-pipeline-cli', 'receipt.json');
  const installedPatchVersion = await readInstalledPatchVersion(receiptPath);
  const pipelineOutdated =
    pipelinePresent &&
    installedPatchVersion !== null &&
    installedPatchVersion < route.pipeline.patchVersion;
  const verification = await inspectPackageTree(pipelineRoot, expectedTree.files, { allowTextLineEndings: true });
  // Receipts live in Library and may be stale after a checkout. The pinned tree is authoritative.
  const pipelineInstalled = pipelinePresent && verification.ok;
  const pipelineState = !pipelinePresent
    ? 'missing'
    : verification.ok
      ? 'current'
      : pipelineOutdated
        ? 'outdated'
        : 'invalid';
  const pipelineSourceReady = (await inspectPackageTree(generated, expectedTree.files)).ok;
  let editors: string[] = [];
  if (!options.allowRunningEditor) {
    try {
      const { all } = await queryUnityProcesses(project.projectPath);
      editors = all.map((p) => `PID ${p.processId}`);
    } catch (err) {
      editors = [`<query failed: ${err instanceof Error ? err.message : String(err)}>`];
    }
  }
  return {
    projectPath: project.projectPath,
    editorVersion: project.editorVersion,
    editorRevision: project.revision,
    routeSupported: true,
    routeRevision: route.editorRevision,
    cli: { version: route.cli.version, path: cliPath, state: cliState },
    pipeline: {
      version: route.pipeline.version,
      patchVersion: route.pipeline.patchVersion,
      sourceReady: pipelineSourceReady,
      present: pipelinePresent,
      installed: pipelineInstalled,
      state: pipelineState,
      installedPatchVersion,
      verification,
    },
    unityProcesses: editors,
    supportedVersions: listEditorVersions(),
  };
}
