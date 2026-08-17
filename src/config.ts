import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

function distDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Package root: dist/<...>/config.ts -> dist -> root. Works from tsc output and vitest (src). */
export function packageRoot(): string {
  return resolve(distDir(), '..');
}

export function routesDir(): string {
  return join(packageRoot(), 'routes');
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function expectedTreePath(editorVersion: string): string {
  return join(routesDir(), 'expected-tree', `${editorVersion}.json`);
}

/** User-scoped cache; never inside node_modules/package dir. */
export function cacheRoot(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'editor-pipeline-cli');
}

export function cliCacheDir(): string {
  return join(cacheRoot(), 'cache', 'cli');
}

export function pipelineCacheDir(): string {
  return join(cacheRoot(), 'cache', 'pipeline');
}

export function generatedDir(): string {
  return join(cacheRoot(), 'generated');
}

export function logsDir(): string {
  return join(cacheRoot(), 'logs');
}

export function ensureCacheLayout(): void {
  for (const dir of [cacheRoot(), cliCacheDir(), pipelineCacheDir(), generatedDir(), logsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}