import { ensureCliBinary } from '../ensure.js';
import { loadRoute, listEditorVersions } from '../routes.js';
import { ensureCacheLayout, cliCacheDir } from '../config.js';

export interface CliInstallOptions {
  editorVersion?: string;
  force?: boolean;
}

export async function runCliInstall(options: CliInstallOptions = {}) {
  ensureCacheLayout();
  const versions = options.editorVersion ? [options.editorVersion] : listEditorVersions();
  const results = [];
  for (const version of versions) {
    const route = loadRoute(version);
    const result = await ensureCliBinary(route.cli, { force: options.force });
    results.push({
      editorVersion: version,
      cliVersion: route.cli.version,
      path: result.path,
      state: result.state,
      sha256: result.sha256,
    });
  }
  return { cacheDir: cliCacheDir(), results };
}