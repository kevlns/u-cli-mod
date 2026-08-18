#!/usr/bin/env node
/**
 * Local tarball install matrix (no registry publish, no login).
 *
 * Builds the real npm tarball (npm pack, which runs prepack -> build) and
 * verifies all three consumption modes against the LOCAL file:
 *   1. project devDependency install (node_modules/.bin wiring)
 *   2. global install with a temp --prefix
 *   3. npx --package <local tgz>
 * Each mode runs `u-cli-mod --version` and `u-cli-mod routes`.
 *
 * Writes a JSON report (default C:/tmp/u-cli-mod-package-test-report.json)
 * and cleans up everything it created (unless EPC_PKG_KEEP=1). Never pushes to
 * any registry.
 *
 * Env: EPC_PKG_REPORT, EPC_PKG_ROOT, EPC_PKG_KEEP.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = process.env.EPC_PKG_REPORT ?? 'C:/tmp/u-cli-mod-package-test-report.json';
const ROOT = process.env.EPC_PKG_ROOT ?? join(tmpdir(), `epc-pkg-${randomUUID()}`);
const KEEP = (process.env.EPC_PKG_KEEP ?? '0') === '1';
const NPM_CLI = process.env.npm_execpath;
const EXPECTED_VERSION = '0.1.0-beta.3';
// Scoped name: @kevlns/u-cli-mod -> kevlns-u-cli-mod-<version>.tgz
const EXPECTED_TGZ_FILENAME = `kevlns-u-cli-mod-${EXPECTED_VERSION}.tgz`;
const MANIFEST_PATH = 'v-cli.plugin.json';

function npm(args, { cwd = REPO } = {}) {
  if (!NPM_CLI) throw new Error('缺少 npm_execpath；请通过 npm run test:package 执行');
  const out = execFileSync(process.execPath, [NPM_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

function runBin(binPath, args) {
  // Windows .cmd shims need a shell; POSIX symlinks work directly.
  const res = spawnSync(binPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    shell: process.platform === 'win32',
  });
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr };
}

function log(msg) {
  process.stdout.write(`[pkg] ${msg}\n`);
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  const cacheDir = join(ROOT, 'npm-cache');
  mkdirSync(cacheDir, { recursive: true });
  const results = [];

  // Pack (runs prepack -> build; tarball lands in ROOT, never in the repo).
  let tgzPath;
  try {
    const out = npm(['pack', '--json', '--pack-destination', ROOT]);
    const parsed = JSON.parse(out);
    const pack = parsed[0];
    tgzPath = join(ROOT, pack.filename);
    if (!existsSync(tgzPath)) throw new Error(`tgz 未生成：${pack.filename}`);
    if (pack.filename !== EXPECTED_TGZ_FILENAME) {
      throw new Error(`tgz 文件名与预期不符：${pack.filename}（期望 ${EXPECTED_TGZ_FILENAME}）`);
    }
    if (!(pack.files ?? []).some((f) => f.path === MANIFEST_PATH)) {
      throw new Error(`tgz 文件列表缺少 ${MANIFEST_PATH}`);
    }
    log(`packed ${pack.filename} (${pack.entryCount ?? '?'} files)`);
    results.push({
      case: 'manifest-in-tarball',
      ok: true,
      detail: `${MANIFEST_PATH} present, filename=${pack.filename}`,
    });
  } catch (err) {
    log(`FAIL pack: ${err.message}`);
    results.push({ case: 'pack', ok: false, detail: err.message });
    writeReport(results);
    process.exit(1);
  }

  // Case 1: project devDependency.
  {
    const dir = join(ROOT, 'case-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'epc-case-project', private: true }, null, 2), 'utf8');
    try {
      npm(['install', '--no-audit', '--no-fund', '--save-dev', tgzPath], { cwd: dir });
      const binDir = join(dir, 'node_modules', '.bin');
      const candidates = ['u-cli-mod.cmd', 'u-cli-mod', 'u-cli-mod.ps1'];
      const bin = candidates.map((c) => join(binDir, c)).find((p) => existsSync(p));
      if (!bin) throw new Error('node_modules/.bin 中未找到 u-cli-mod');
      const manifestFile = join(dir, 'node_modules', '@kevlns', 'u-cli-mod', MANIFEST_PATH);
      const installedPkg = JSON.parse(
        readFileSync(join(dir, 'node_modules', '@kevlns', 'u-cli-mod', 'package.json'), 'utf8'),
      );
      const vcliOk = installedPkg.vCli?.manifest === MANIFEST_PATH && existsSync(manifestFile);
      const v = runBin(bin, ['--version']);
      const r = runBin(bin, ['routes']);
      const ok =
        v.exit === 0 &&
        r.exit === 0 &&
        v.stdout.includes(EXPECTED_VERSION) &&
        r.stdout.includes('2022.3.62f3c1') &&
        vcliOk;
      results.push({
        case: 'project-devDep',
        ok,
        bin: bin.replace(dir, '<dir>'),
        version: v.stdout.trim(),
        routes: r.stdout.trim().slice(0, 120),
        manifest: vcliOk ? 'present' : 'missing',
      });
      log(`project-devDep ok=${ok}`);
    } catch (err) {
      results.push({ case: 'project-devDep', ok: false, detail: err.message });
      log(`FAIL project-devDep: ${err.message}`);
    }
  }

  // Case 2: global install with temp prefix.
  {
    const prefix = join(ROOT, 'case-global');
    mkdirSync(prefix, { recursive: true });
    try {
      npm(['install', '--no-audit', '--no-fund', '-g', '--prefix', prefix, tgzPath]);
      let bin = null;
      for (const name of readdirSync(prefix)) {
        if (name === 'u-cli-mod' || name === 'u-cli-mod.cmd' || name === 'u-cli-mod.ps1') {
          bin = join(prefix, name);
          break;
        }
      }
      if (!bin) {
        // npm may place global bins under prefix (default global layout)
        const nested = join(prefix, 'node_modules', '.bin');
        if (existsSync(nested)) {
          bin = ['u-cli-mod.cmd', 'u-cli-mod', 'u-cli-mod.ps1']
            .map((c) => join(nested, c))
            .find((p) => existsSync(p)) ?? null;
        }
      }
      if (!bin) throw new Error(`--prefix 全局安装后未找到 bin（扫描 ${prefix} 顶层失败）`);
      const manifestFile = join(prefix, 'node_modules', '@kevlns', 'u-cli-mod', MANIFEST_PATH);
      const v = runBin(bin, ['--version']);
      const r = runBin(bin, ['routes']);
      const ok =
        v.exit === 0 &&
        r.exit === 0 &&
        v.stdout.includes(EXPECTED_VERSION) &&
        r.stdout.includes('2022.3.62f3c1') &&
        existsSync(manifestFile);
      results.push({
        case: 'global-prefix',
        ok,
        bin: bin.replace(prefix, '<prefix>'),
        version: v.stdout.trim(),
        manifest: existsSync(manifestFile) ? 'present' : 'missing',
      });
      log(`global-prefix ok=${ok}`);
    } catch (err) {
      results.push({ case: 'global-prefix', ok: false, detail: err.message });
      log(`FAIL global-prefix: ${err.message}`);
    }
  }

  // Case 3: npx --package <local tgz>.
  {
    const dir = join(ROOT, 'case-npx');
    mkdirSync(dir, { recursive: true });
    try {
      const out = npm(['exec', '--yes', '--package', tgzPath, '--', 'u-cli-mod', '--version'], { cwd: dir });
      const out2 = npm(['exec', '--yes', '--package', tgzPath, '--', 'u-cli-mod', 'routes'], { cwd: dir });
      const ok = out.includes(EXPECTED_VERSION) && out2.includes('2022.3.62f3c1');
      results.push({ case: 'npx-package', ok, version: out.trim().slice(0, 120), routes: out2.trim().slice(0, 120) });
      log(`npx-package ok=${ok}`);
    } catch (err) {
      results.push({ case: 'npx-package', ok: false, detail: err.message });
      log(`FAIL npx-package: ${err.message}`);
    }
  }

  // Repo cleanliness: no forbidden artifacts left inside the repo tree.
  {
    const forbidden = ['.exe', '.dll', '.tgz', '.pdb', '.cs', '.unity', '.asmdef', '.prefab', '.asset'];
    const found = [];
    const scanDir = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) scanDir(p);
        else if (forbidden.some((ext) => p.toLowerCase().endsWith(ext))) found.push(p.replace(REPO, '<repo>'));
      }
    };
    scanDir(REPO);
    results.push({ case: 'repo-clean-artifacts', ok: found.length === 0, detail: found.join('; ') || 'none' });
    log(`repo-clean-artifacts ok=${found.length === 0}`);
  }

  const pass = results.every((r) => r.ok);
  const report = {
    tool: 'u-cli-mod package matrix',
    generatedAt: new Date().toISOString(),
    tgz: tgzPath.replace(ROOT, '<root>'),
    expectedVersion: EXPECTED_VERSION,
    results,
    pass,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  log(`report: ${REPORT} pass=${pass}`);

  if (!KEEP) rmSync(ROOT, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

function writeReport(results) {
  writeFileSync(
    REPORT,
    JSON.stringify({ tool: 'u-cli-mod package matrix', generatedAt: new Date().toISOString(), results, pass: results.every((r) => r.ok) }, null, 2),
    'utf8',
  );
}

main().catch((err) => {
  console.error(`[pkg] fatal: ${err.message}`);
  process.exit(2);
});