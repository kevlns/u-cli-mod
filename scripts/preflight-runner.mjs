#!/usr/bin/env node
/**
 * Self-hosted GitHub Actions runner preflight (Windows).
 *
 * Verifies the environment needed by the Unity E2E workflow BEFORE a runner
 * is registered:
 *   - Node.js >= 20, npm, Git
 *   - Unity editor at the exact version + revision required by the route
 *   - Unity license can actually run (batchmode probe on a scratch project)
 *   - prints the recommended runner directory + labels
 *
 * It NEVER downloads, registers, or configures a runner and makes no network
 * calls. Output is machine-readable JSON on stdout; exit code 0 = ready.
 *
 * Env overrides:
 *   EPC_PREFLIGHT_VERSION (default 2022.3.62f3c1)
 *   EPC_PREFLIGHT_REVISION (default 1623fc0bbb97)
 *   EPC_UNITY_PATH (default C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe)
 *   EPC_RUNNER_DIR (default C:\unity-runner)
 *   EPC_PREFLIGHT_SKIP_LICENSE=1 to skip the Unity batchmode license probe
 */
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const VERSION = process.env.EPC_PREFLIGHT_VERSION ?? '2022.3.62f3c1';
const REVISION = process.env.EPC_PREFLIGHT_REVISION ?? '1623fc0bbb97';
const UNITY =
  process.env.EPC_UNITY_PATH ??
  `C:/Program Files/Unity/Hub/Editor/${VERSION}/Editor/Unity.exe`;
const RUNNER_DIR = process.env.EPC_RUNNER_DIR ?? 'C:/unity-runner';
const SKIP_LICENSE = process.env.EPC_PREFLIGHT_SKIP_LICENSE === '1';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

function nodeMajor(versionOut) {
  const m = /v?(\d+)\./.exec(versionOut.trim());
  return m ? Number(m[1]) : NaN;
}

// --- Node.js ---
{
  const r = run(process.execPath, ['--version']);
  const major = r.status === 0 ? nodeMajor(r.stdout) : NaN;
  record('node', r.status === 0 && major >= 20, `node ${r.stdout.trim()} (需要 >= 20)`);
}

// --- npm ---
{
  if (process.env.npm_execpath) {
    const r = run(process.execPath, [process.env.npm_execpath, '--version']);
    record('npm', r.status === 0, r.status === 0 ? `npm ${r.stdout.trim()}` : r.stderr.trim() || 'npm 不可用');
  } else {
    // Direct invocation (no npm run): npm ships as npm.cmd on Windows.
    const r = spawnSync('npm --version', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 60000 });
    record('npm', r.status === 0, r.status === 0 ? `npm ${r.stdout.trim()}` : r.stderr.trim() || 'npm 不可用');
  }
}

// --- Git ---
{
  const r = run('git', ['--version']);
  record('git', r.status === 0, r.status === 0 ? r.stdout.trim() : r.stderr.trim() || 'git 不可用');
}

// --- Unity path ---
record('unity-path', existsSync(UNITY), existsSync(UNITY) ? UNITY : `未找到 Unity：${UNITY}`);

// --- Unity version text on disk (Hub folder layout doubles as a version marker) ---
if (existsSync(UNITY)) {
  const inHub = UNITY.includes(`Hub/Editor/${VERSION}/`) || UNITY.includes(`Hub\\Editor\\${VERSION}\\`);
  record('unity-version-marker', inHub, inHub ? `Hub 路径匹配 ${VERSION}` : '自定义路径，将依赖运行日志验证');
} else {
  record('unity-version-marker', false, 'Unity 不存在，跳过');
}

// --- License probe (batchmode on a scratch project; verifies version + revision + license) ---
let licenseProbe = { ok: false, detail: 'skipped', exit: null, versionInLog: false, successLine: false };
if (existsSync(UNITY) && !SKIP_LICENSE) {
  const scratch = join(tmpdir(), `epc-preflight-${randomUUID()}`);
  const log = join(scratch, 'editor.log');
  try {
    mkdirSync(join(scratch, 'ProjectSettings'), { recursive: true });
    mkdirSync(join(scratch, 'Assets'), { recursive: true });
    writeFileSync(
      join(scratch, 'ProjectSettings', 'ProjectVersion.txt'),
      `m_EditorVersion: ${VERSION}\nm_EditorVersionWithRevision: ${VERSION} (${REVISION})\n`,
      'utf8',
    );
    const t0 = Date.now();
    const r = run(UNITY, ['-batchmode', '-nographics', '-projectPath', scratch, '-quit', '-logFile', log], {
      timeoutMs: 480000,
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    let logText = '';
    try {
      const raw = readFileSync(log);
      logText = raw.toString('utf8');
      if (!logText.includes(`2022.3.62f3c1 (${REVISION})`)) {
        // Early Unity logs may be UTF-16 LE.
        logText = raw.toString('utf16le');
      }
    } catch {
      /* keep empty */
    }
    const versionInLog =
      logText.includes(`Initialize engine version: ${VERSION} (${REVISION})`) ||
      logText.includes(`"editorVersion":"${VERSION} (${REVISION})"`);
    const successLine = logText.includes('Exiting batchmode successfully');
    licenseProbe = {
      ok: r.status === 0 && versionInLog && successLine,
      detail: `exit=${r.status} versionInLog=${versionInLog} successLine=${successLine} (${elapsed}s)`,
      exit: r.status,
      versionInLog,
      successLine,
    };
  } catch (err) {
    licenseProbe = { ok: false, detail: `probe 异常：${err.message}`, exit: null, versionInLog: false, successLine: false };
  } finally {
    // Unity may still hold handles briefly after exit; retry the removal.
    try {
      execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 1500"', { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
        break;
      } catch {
        if (attempt === 4) {
          // Best-effort: leave a note instead of crashing the preflight.
          process.stderr.write(`warning: 无法删除探针临时目录 ${scratch}\n`);
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }
}
record('unity-license-probe', licenseProbe.ok, licenseProbe.detail);

// --- Summary ---
const pass = checks.every((c) => c.ok);
console.log(
  JSON.stringify(
    {
      pass,
      tool: 'u-cli-mod preflight',
      generatedAt: new Date().toISOString(),
      checks,
      suggested: {
        runnerDirectory: RUNNER_DIR,
        labels: ['self-hosted', 'windows', 'unity-2022.3.62f3c1'],
        registerHint:
          '在 GitHub 仓库 Settings -> Actions -> Runners 获取注册命令；注册后选择“允许仓库管理员为该标签分配工作”。',
        workflowTriggerPolicy: 'E2E 工作流仅由 workflow_dispatch 与受保护 tag 触发，不执行 pull_request。',
      },
    },
    null,
    2,
  ),
);
process.exit(pass ? 0 : 1);