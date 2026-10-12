#!/usr/bin/env node
/**
 * Regenerate routes/expected-tree/<version>.json from the current transform.
 *
 * Usage: node scripts/regen-expected-tree.mjs [editorVersion ...]
 * (no args = all routed versions)
 *
 * Flow per version: pinned tgz (cache; downloads only if missing) -> fresh
 * extract -> transformPackage (the final byte-compare against the CURRENT tree
 * is expected to fail right after a patch change — files are already written)
 * -> hash the generated tree -> write the sorted JSON.
 *
 * After regenerating, bump route.pipeline.patchVersion and run
 * `node dist/cli.js doctor <project>` style verification (or the installer's
 * dry-run) so the new tree is actually exercised end-to-end.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  listEditorVersions,
  loadRoute,
  loadExpectedTree,
} = require('../dist/routes.js');
const { ensurePipelineTgz, extractTgz, resolveExtractedPackageDir } = require('../dist/pipeline.js');
const { transformPackage, readTemplateFile } = require('../dist/transform.js');
const { pipelineTgzPath, pipelineExtractDir, generatedPackageDir } = require('../dist/paths.js');
const { sha256Tree } = require('../dist/integrity.js');
const { expectedTreePath, cacheRoot, templatesDir } = require('../dist/config.js');
const { CliError } = require('../dist/errors.js');

async function regen(version) {
  const route = loadRoute(version);
  const pipeline = route.pipeline;
  const tgzPath = pipelineTgzPath(pipeline);
  await ensurePipelineTgz(tgzPath, pipeline);
  const extractRoot = pipelineExtractDir(pipeline);
  await extractTgz(tgzPath, extractRoot);
  const sourceRoot = resolveExtractedPackageDir(extractRoot);
  const generated = generatedPackageDir(version);
  const expectedTree = loadExpectedTree(version);

  const monoImporterBody = readTemplateFile(join(templatesDir(), pipeline.templates, 'mono-importer-body.txt'));
  const dllImporterBody = readTemplateFile(join(templatesDir(), pipeline.templates, 'dll-importer-body.txt'));

  try {
    await transformPackage({
      sourceRoot,
      targetRoot: generated,
      route: pipeline,
      expectedTree: expectedTree.files,
      monoImporterBody,
      dllImporterBody,
    });
  } catch (err) {
    if (!(err instanceof CliError) || !err.message.includes('expected-tree')) throw err;
    console.log(`[${version}] transform 与旧 expected-tree 不一致（补丁变更后的预期行为），继续以产物为准再生成`);
  }

  const tree = await sha256Tree(generated);
  const files = {};
  for (const key of [...tree.keys()].sort()) files[key] = tree.get(key);
  const content = `${JSON.stringify({ algorithm: 'SHA256', entries: Object.keys(files).length, files }, null, 2)}\n`;
  writeFileSync(expectedTreePath(version), content, 'utf8');
  console.log(`[${version}] expected-tree 已再生成：${Object.keys(files).length} 个文件 -> ${expectedTreePath(version)}`);
}

const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : listEditorVersions();
console.log(`cache root: ${cacheRoot()}`);
for (const version of versions) {
  await regen(version);
}
