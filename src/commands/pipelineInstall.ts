import { readProjectInfo } from '../projectVersion.js';
import { resolveRouteForProject } from '../routes.js';
import { ensurePipelineSource } from '../ensure.js';
import { installPipeline } from '../installer.js';
import { loadExpectedTree } from '../routes.js';

export interface PipelineInstallOptions {
  force?: boolean;
  allowRunningEditor?: boolean;
  dryRun?: boolean;
}

export async function runPipelineInstall(projectPath: string, options: PipelineInstallOptions = {}) {
  const project = readProjectInfo(projectPath);
  const route = resolveRouteForProject(project);
  const expectedTree = loadExpectedTree(project.editorVersion);
  const { sourceDir, fileCount } = await ensurePipelineSource(project.editorVersion, route, {
    force: options.force,
  });
  const result = await installPipeline(project, route, sourceDir, expectedTree.files, {
    force: options.force,
    allowRunningEditor: options.allowRunningEditor,
    dryRun: options.dryRun,
  });
  return { ...result, sourceDir, sourceFileCount: fileCount };
}