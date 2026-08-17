import { loadRoute, listEditorVersions } from '../routes.js';

export function runRoutes(editorVersion?: string) {
  const versions = editorVersion ? [editorVersion] : listEditorVersions();
  const routes = versions.map((v) => {
    const route = loadRoute(v);
    return {
      editorVersion: route.editorVersion,
      editorRevision: route.editorRevision,
      cliVersion: route.cli.version,
      cliSha256: route.cli.sha256,
      pipelineVersion: route.pipeline.version,
      pipelineSha256: route.pipeline.sha256,
      status: route.status ?? 'unknown',
    };
  });
  return { routes };
}