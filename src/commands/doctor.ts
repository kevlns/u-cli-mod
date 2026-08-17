import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readProjectInfo } from '../projectVersion.js';
import { resolveRouteForProject, listEditorVersions } from '../routes.js';
import { cliBinaryPath, generatedPackageDir } from '../paths.js';
import { sha256File } from '../integrity.js';
import { queryUnityProcesses } from '../unityGuard.js';

export interface DoctorOptions {
  allowRunningEditor?: boolean;
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
  const pipelineInstalled = existsSync(
    join(project.projectPath, 'Packages', 'com.unity.pipeline', 'package.json'),
  );
  const pipelineSourceReady = existsSync(join(generated, 'package.json'));
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
    pipeline: { version: route.pipeline.version, sourceReady: pipelineSourceReady, installed: pipelineInstalled },
    unityProcesses: editors,
    supportedVersions: listEditorVersions(),
  };
}