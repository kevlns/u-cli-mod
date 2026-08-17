import { existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { sha256File } from './integrity.js';
import { downloadToFile } from './download.js';
import { verifyAuthenticode } from './authenticode.js';
import { ensurePipelineTgz, extractTgz, resolveExtractedPackageDir } from './pipeline.js';
import { transformPackage, readTemplateFile } from './transform.js';
import { verifyPackageRoot } from './installer.js';
import { loadExpectedTree } from './routes.js';
import { templatesDir } from './config.js';
import type { CliRoute, VersionRoute } from './routes.js';
import { cliBinaryPath, pipelineTgzPath, pipelineExtractDir, generatedPackageDir } from './paths.js';

export interface EnsureCliResult {
  path: string;
  state: 'valid' | 'downloaded';
  sha256: string;
}

async function verifyCliFull(route: CliRoute, path: string): Promise<string> {
  const hash = await sha256File(path);
  if (hash !== route.sha256.toLowerCase()) {
    throw new CliError(
      `CLI SHA-256 不匹配。期望 ${route.sha256}，实际 ${hash}。请运行 "u-cli-mod cli install --force" 修复。`,
    );
  }
  await verifyAuthenticode(path, route.signerSubjectContains, route.signerThumbprint);
  return hash;
}

/**
 * Download (or reuse) the pinned CLI binary. Every re-entry path — fresh
 * download AND cache reuse — requires full SHA-256 + Authenticode verification
 * before the binary is placed at (or reported valid from) its final location.
 */
export async function ensureCliBinary(
  route: CliRoute,
  { force = false }: { force?: boolean } = {},
): Promise<EnsureCliResult> {
  const path = cliBinaryPath(route);
  if (!force && existsSync(path)) {
    try {
      const hash = await verifyCliFull(route, path);
      return { path, state: 'valid', sha256: hash };
    } catch {
      // Cached binary failed hash or Authenticode: discard and redownload.
      rmSync(path, { force: true });
    }
  }

  // Verify on a temporary sibling first; only a fully verified binary is
  // renamed into the reusable cache slot.
  const tempPath = `${path}.verify-${randomUUID()}`;
  try {
    await downloadToFile(route.url, tempPath, {
      expectedSha256: route.sha256,
      expectedSize: route.expectedSize,
    });
    const hash = await verifyCliFull(route, tempPath);
    renameSync(tempPath, path);
    return { path, state: 'downloaded', sha256: hash };
  } catch (err) {
    rmSync(tempPath, { force: true });
    if (err instanceof CliError) throw err;
    throw new CliError(`CLI 下载/校验失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface EnsurePipelineResult {
  sourceDir: string;
  fileCount: number;
  state: 'valid' | 'transformed';
}

/** Download + extract + deterministically transform the pinned pipeline package. */
export async function ensurePipelineSource(
  editorVersion: string,
  route: VersionRoute,
  { force = false }: { force?: boolean } = {},
): Promise<EnsurePipelineResult> {
  const pipeline = route.pipeline;
  const tgzPath = pipelineTgzPath(pipeline);
  const extractRoot = pipelineExtractDir(pipeline);
  const generated = generatedPackageDir(editorVersion);
  const expectedTree = loadExpectedTree(editorVersion);

  // Already-generated and verified? Reuse.
  if (!force && existsSync(generated)) {
    try {
      const fileCount = await verifyPackageRoot(generated, expectedTree.files);
      return { sourceDir: generated, fileCount, state: 'valid' };
    } catch {
      // fall through and regenerate
    }
  }

  await ensurePipelineTgz(tgzPath, pipeline, { force });
  await extractTgz(tgzPath, extractRoot);
  const sourceRoot = resolveExtractedPackageDir(extractRoot);

  const monoImporterBody = readTemplateFile(
    join(templatesDir(), pipeline.templates, 'mono-importer-body.txt'),
  );
  const dllImporterBody = readTemplateFile(
    join(templatesDir(), pipeline.templates, 'dll-importer-body.txt'),
  );

  await transformPackage({
    sourceRoot,
    targetRoot: generated,
    route: pipeline,
    expectedTree: expectedTree.files,
    monoImporterBody,
    dllImporterBody,
  });
  const fileCount = Object.keys(expectedTree.files).length;
  return { sourceDir: generated, fileCount, state: 'transformed' };
}

/** Re-verify an existing CLI binary hash without downloading. Throws on mismatch. */
export async function verifyCliBinary(route: CliRoute): Promise<string> {
  const path = cliBinaryPath(route);
  if (!existsSync(path)) {
    throw new CliError(`CLI 未下载：${path}。请先运行 "u-cli-mod cli install"。`);
  }
  const hash = await sha256File(path);
  if (hash !== route.sha256.toLowerCase()) {
    throw new CliError(
      `CLI SHA-256 不匹配，拒绝执行：${path}。请运行 "u-cli-mod cli install --force" 修复。`,
    );
  }
  return hash;
}
