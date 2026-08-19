// npm pack content guard: fail when the tarball would contain Unity binaries,
// DLLs, upstream tgz files, or a vendored com.unity.pipeline source tree.
// Runs a REAL `npm pack` into an isolated temp dir and verifies both the file
// list reported by npm and the resulting .tgz on disk; the tarball is never
// left inside the repository.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const FORBIDDEN_EXT = new Set([
  '.exe',
  '.dll',
  '.tgz',
  '.pdb',
  // Unity source/asset sentinels: the package must never carry vendored
  // Unity code or assets (reviewer hardening).
  '.cs',
  '.unity',
  '.asmdef',
  '.prefab',
  '.asset',
  '.meta',
]);
const FORBIDDEN_NAMES = new Set(['.attestation.p7m', '.signature', 'integrity.json']);

// Rebrand regression guard: the publishable package must keep this identity.
const EXPECTED_PACKAGE_NAME = '@kevlns/u-cli-mod';
const EXPECTED_VERSION = '0.1.1';
// Scoped name: @kevlns/u-cli-mod -> kevlns-u-cli-mod-<version>.tgz
const EXPECTED_TGZ_FILENAME = `kevlns-u-cli-mod-${EXPECTED_VERSION}.tgz`;
const MANIFEST_PATH = 'v-cli.plugin.json';

function npmPackArgs(packDir) {
  // Run npm through the same node binary that runs this script, using
  // npm-cli.js discovered via env (robust on Windows; avoids .cmd spawn).
  const cli = process.env.npm_execpath;
  if (!cli) {
    throw new Error('缺少 npm_execpath；请通过 npm run pack:guard 执行');
  }
  return [process.execPath, [cli, 'pack', '--json', '--pack-destination', packDir]];
}

function validateEntries(entries, violations) {
  for (const entry of entries) {
    const name = entry.path.split('/').pop() ?? '';
    const ext = extname(entry.path).toLowerCase();
    if (ext !== '' && FORBIDDEN_EXT.has(ext)) {
      violations.push(`forbidden extension: ${entry.path}`);
    }
    if (FORBIDDEN_NAMES.has(entry.path) || FORBIDDEN_NAMES.has(name)) {
      violations.push(`forbidden file: ${entry.path}`);
    }
    if (entry.path === 'com.unity.pipeline/package.json') {
      violations.push(`vendored pipeline package: ${entry.path}`);
    }
    if (entry.path.startsWith('com.unity.pipeline/')) {
      violations.push(`vendored pipeline tree: ${entry.path}`);
    }
  }
}

function validateManifestIdentity() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  if (pkg.vCli?.manifest !== MANIFEST_PATH) {
    throw new Error(`package.json vCli.manifest 与预期不符：${pkg.vCli?.manifest ?? '缺失'}（期望 ${MANIFEST_PATH}）`);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes(MANIFEST_PATH)) {
    throw new Error(`package.json files 未包含 ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(readFileSync(join(process.cwd(), MANIFEST_PATH), 'utf8'));
  if (manifest.schemaVersion !== 1) {
    throw new Error(`v-cli.plugin.json schemaVersion 与预期不符：${manifest.schemaVersion}（期望 1）`);
  }
  if (manifest.package !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`v-cli.plugin.json package 与预期不符：${manifest.package}（期望 ${EXPECTED_PACKAGE_NAME}）`);
  }
  if (manifest.command !== 'unity') {
    throw new Error(`v-cli.plugin.json command 与预期不符：${manifest.command}（期望 unity）`);
  }
  if (manifest.bin !== 'u-cli-mod') {
    throw new Error(`v-cli.plugin.json bin 与预期不符：${manifest.bin}（期望 u-cli-mod）`);
  }
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes('win32')) {
    throw new Error('v-cli.plugin.json platforms 必须包含 win32');
  }
}

function run() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`package.json name 与预期不符：${pkg.name}（期望 ${EXPECTED_PACKAGE_NAME}）`);
  }
  if (pkg.version !== EXPECTED_VERSION) {
    throw new Error(`package.json version 与预期不符：${pkg.version}（期望 ${EXPECTED_VERSION}）`);
  }
  validateManifestIdentity();
  const dir = mkdtempSync(join(tmpdir(), 'epc-pack-guard-'));
  try {
    const [packFile, packArgsFrom] = npmPackArgs(dir);

    // Pass 1: --dry-run file list (no tarball written) must contain no
    // forbidden entries, and must include dist/cli.js + the bin entry.
    const dryRunOut = execFileSync(packFile, [...packArgsFrom, '--dry-run'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const dryParsed = JSON.parse(dryRunOut)[0];
    const dryViolations = [];
    validateEntries(dryParsed.files ?? [], dryViolations);
    const paths = (dryParsed.files ?? []).map((f) => f.path);
    if (!paths.includes('dist/cli.js')) dryViolations.push('dry-run 缺少 dist/cli.js（prepack 未生效？）');
    if (!paths.some((p) => p === 'package.json')) dryViolations.push('dry-run 缺少 package.json');
    if (!paths.includes(MANIFEST_PATH)) dryViolations.push(`dry-run 缺少 ${MANIFEST_PATH}`);
    if (dryViolations.length > 0) {
      throw new Error(`pack --dry-run 内容违规：\n${dryViolations.join('\n')}`);
    }

    // Pass 2: real npm pack into the isolated dir and verify the on-disk tgz
    // plus reconcile its entry list against the dry-run list.
    const out = execFileSync(packFile, packArgsFrom, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(out);
    const pack = parsed[0];
    if (!pack) throw new Error('npm pack 无输出');
    if (pack.filename !== EXPECTED_TGZ_FILENAME) {
      throw new Error(
        `tgz 文件名与预期不符：${pack.filename}（期望 ${EXPECTED_TGZ_FILENAME}，包名 ${EXPECTED_PACKAGE_NAME}，版本 ${EXPECTED_VERSION}）`,
      );
    }

    const violations = [];
    validateEntries(pack.files ?? [], violations);
    const realPaths = (pack.files ?? []).map((f) => f.path).sort();
    const dryPaths = paths.sort();
    if (JSON.stringify(realPaths) !== JSON.stringify(dryPaths)) {
      violations.push('dry-run 与真实 pack 文件列表不一致');
    }
    if (!realPaths.includes(MANIFEST_PATH)) {
      violations.push(`真实 pack 缺少 ${MANIFEST_PATH}`);
    }
    let totalBytes = 0;
    for (const entry of pack.files ?? []) totalBytes += entry.size;
    if (violations.length > 0) {
      throw new Error(`pack 内容违规：\n${violations.join('\n')}`);
    }

    // The real tarball must exist on disk (npm pack + --pack-destination).
    const tgzPath = join(dir, pack.filename);
    const stat = statSync(tgzPath);
    if (stat.size === 0) {
      throw new Error(`生成的 tgz 为空：${pack.filename}`);
    }
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
    if (onDisk.length < 1) {
      throw new Error('未在 pack 目录中发现 tgz');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          filename: pack.filename,
          files: pack.files.length,
          totalBytes,
          tgzBytes: stat.size,
          violations: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run();