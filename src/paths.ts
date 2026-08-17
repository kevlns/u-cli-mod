import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cliCacheDir, pipelineCacheDir, generatedDir } from './config.js';
import type { CliRoute, PipelineRoute } from './routes.js';

export function cliBinaryPath(route: CliRoute): string {
  return join(cliCacheDir(), route.version, 'unity.exe');
}

export function pipelineTgzPath(route: PipelineRoute): string {
  return join(pipelineCacheDir(), `${route.version}-${route.sha1}.tgz`);
}

export function pipelineSrcDir(route: PipelineRoute): string {
  return join(pipelineCacheDir(), `${route.version}-${route.sha1}-src`);
}

export function pipelineExtractDir(route: PipelineRoute): string {
  return join(pipelineCacheDir(), `${route.version}-${route.sha1}-extract`);
}

export function generatedPackageDir(editorVersion: string): string {
  return join(generatedDir(), editorVersion, 'com.unity.pipeline');
}

export function exists(path: string): boolean {
  return existsSync(path);
}