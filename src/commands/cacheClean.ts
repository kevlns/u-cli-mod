import { rm } from 'node:fs/promises';
import { cacheRoot, cliCacheDir, pipelineCacheDir, generatedDir, logsDir } from '../config.js';

export interface CacheCleanOptions {
  all?: boolean;
}

export async function runCacheClean(options: CacheCleanOptions = {}) {
  const removed: string[] = [];
  const targets = options.all
    ? [cliCacheDir(), pipelineCacheDir(), generatedDir(), logsDir()]
    : [generatedDir(), pipelineCacheDir()];
  for (const dir of targets) {
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { cacheRoot: cacheRoot(), removed };
}