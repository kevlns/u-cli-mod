import { readProjectInfo } from '../projectVersion.js';
import { resolveRouteForProject, loadExpectedTree } from '../routes.js';
import { ensureCliBinary, ensurePipelineSource } from '../ensure.js';
import { installPipeline } from '../installer.js';

export interface SetupOptions {
  force?: boolean;
  allowRunningEditor?: boolean;
  dryRun?: boolean;
  skipCli?: boolean;
}

export async function runSetup(projectPath: string, options: SetupOptions = {}) {
  const project = readProjectInfo(projectPath);
  const route = resolveRouteForProject(project);
  const cli =
    options.skipCli ?? false
      ? null
      : await ensureCliBinary(route.cli, { force: options.force });
  const expectedTree = loadExpectedTree(project.editorVersion);
  const { sourceDir } = await ensurePipelineSource(project.editorVersion, route, {
    force: options.force,
  });
  const result = await installPipeline(project, route, sourceDir, expectedTree.files, {
    force: options.force,
    allowRunningEditor: options.allowRunningEditor,
    dryRun: options.dryRun,
  });
  return { cli, install: result };
}