#!/usr/bin/env node
/**
 * Windows Unity E2E harness (self-hosted runner ready).
 *
 * Reproducible end-to-end validation for u-cli against a real
 * Unity editor (Windows + Unity 2022.3.62f3c1 by default). Creates isolated
 * temp projects ONLY (never touches Debussy or other user projects), runs the
 * real CLI download / pipeline transform / install / Unity compile / server /
 * command loop / reload / restart / multi-editor targeting, and writes a
 * machine-readable JSON report.
 *
 * - Fresh cache by default (isolated LOCALAPPDATA under the E2E root) so every
 *   run is clean-room; set EPC_E2E_FRESH_CACHE=0 to reuse the real user cache
 *   (the tool still re-verifies SHA-256 + Authenticode on reuse).
 * - Cleanup: kills every Unity process it spawned and any other Unity.exe
 *   whose command line refers to this E2E root; removes temp projects unless
 *   EPC_E2E_KEEP=1.
 * - Exit code 0 only if every required section passes.
 *
 * Env overrides:
 *   EPC_E2E_UNITY, EPC_E2E_ROUTE (default 2022.3.62f3c1),
 *   EPC_E2E_ROOT (default C:/tmp/u-cli-e2e),
 *   EPC_E2E_REPORT (default C:/tmp/u-cli-e2e-report.json),
 *   EPC_E2E_READ_CALLS (200), EPC_E2E_MUTATION_CYCLES (20),
 *   EPC_E2E_RELOADS (5), EPC_E2E_TARGET_CALLS (60),
 *   EPC_E2E_FRESH_CACHE (1), EPC_E2E_KEEP (0), EPC_E2E_SKIP_FRESH_CLI_INSTALL (0)
 */
import { spawnSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_JS = join(REPO, 'dist', 'cli.js');
const EDITOR_VERSION = process.env.EPC_E2E_ROUTE ?? '2022.3.62f3c1';
const EDITOR_REVISION = '1623fc0bbb97';
const UNITY =
  process.env.EPC_E2E_UNITY ??
  `C:/Program Files/Unity/Hub/Editor/${EDITOR_VERSION}/Editor/Unity.exe`;
const E2E_ROOT = process.env.EPC_E2E_ROOT ?? 'C:/tmp/u-cli-e2e';
const REPORT = process.env.EPC_E2E_REPORT ?? 'C:/tmp/u-cli-e2e-report.json';
const READ_CALLS = Number(process.env.EPC_E2E_READ_CALLS ?? 200);
const MUTATION_CYCLES = Number(process.env.EPC_E2E_MUTATION_CYCLES ?? 20);
const RELOADS = Number(process.env.EPC_E2E_RELOADS ?? 5);
const TARGET_CALLS = Number(process.env.EPC_E2E_TARGET_CALLS ?? 60);
const FRESH_CACHE = (process.env.EPC_E2E_FRESH_CACHE ?? '1') !== '0';
const KEEP = (process.env.EPC_E2E_KEEP ?? '0') === '1';
const POLL_MS = 2000;
const READY_TIMEOUT_MS = 300000;

const failures = [];
let spawnedUnity = []; // { pid, kind, project, log, child }
let REPORT_OBJ = null;
let T0 = 0;

function log(msg) {
  process.stdout.write(`[e2e] ${msg}\n`);
}

function fail(section, msg) {
  failures.push({ section, message: msg });
  log(`FAIL ${section}: ${msg}`);
}

function runCli(args, { cwd, env, timeoutMs = 600000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: 'utf8',
    cwd,
    env,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
  });
  const ms = Date.now() - t0;
  let json = null;
  let parseError = null;
  if (res.status === 0 && res.stdout && res.stdout.trim().startsWith('{')) {
    try {
      json = JSON.parse(res.stdout);
    } catch (err) {
      parseError = err.message;
    }
  }
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error, ms, json, parseError };
}

function cliEnv() {
  const env = { ...process.env };
  if (FRESH_CACHE) {
    mkdirSync(join(E2E_ROOT, 'localappdata'), { recursive: true });
    env.LOCALAPPDATA = join(E2E_ROOT, 'localappdata');
  }
  return env;
}

function execReady(project, passthrough) {
  return runCli(['exec', project, '--format', 'json', ...passthrough], { env: cliEnv() });
}

function realpathNorm(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function normForCompare(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function writeProject(projectDir) {
  mkdirSync(join(projectDir, 'Assets'), { recursive: true });
  mkdirSync(join(projectDir, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(projectDir, 'Packages'), { recursive: true });
  writeFileSync(
    join(projectDir, 'ProjectSettings', 'ProjectVersion.txt'),
    `m_EditorVersion: ${EDITOR_VERSION}\nm_EditorVersionWithRevision: ${EDITOR_VERSION} (${EDITOR_REVISION})\n`,
    'utf8',
  );
  const modules = [
    'ai','androidjni','animation','assetbundle','audio','cloth','director','imageconversion',
    'imgui','jsonserialize','particlesystem','physics','physics2d','screencapture','terrain',
    'terrainphysics','tilemap','ui','uielements','umbra','unityanalytics','unitywebrequest',
    'unitywebrequestassetbundle','unitywebrequestaudio','unitywebrequesttexture',
    'unitywebrequestwww','vehicles','video','vr','wind','xr',
  ];
  const deps = {};
  for (const m of modules) deps[`com.unity.modules.${m}`] = '1.0.0';
  deps['com.unity.nuget.newtonsoft-json'] = '3.0.2';
  writeFileSync(
    join(projectDir, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: deps }, null, 2),
    'utf8',
  );
}

function spawnUnityServer(projectDir, logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const child = spawn(
    UNITY,
    ['-batchmode', '-nographics', '-projectPath', projectDir, '-logFile', logFile],
    { windowsHide: true, stdio: 'ignore' },
  );
  spawnedUnity.push({ pid: child.pid, kind: 'server', project: projectDir, log: logFile, child });
  log(`Unity server launched pid=${child.pid} project=${projectDir}`);
  return child;
}

async function killUnity(pid) {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

async function sweepUnityInRoot() {
  const script = String.raw`
$root = '${E2E_ROOT.replace(/'/g, "''")}'
$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$root*") } | Select-Object ProcessId, CommandLine)
$rows = @($procs | ForEach-Object { $_.ProcessId })
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
$rows | ConvertTo-Json -Compress
`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  return res;
}

async function remainingUnityInRoot() {
  const script = String.raw`
$root = '${E2E_ROOT.replace(/'/g, "''")}'
@(Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" | Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$root*") }).Count
`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  return Number((res.stdout ?? '').trim() || res.status || 0);
}

async function waitReady(project, { timeoutMs = READY_TIMEOUT_MS, label = 'server', child = null, logFile = null } = {}) {
  const t0 = Date.now();
  let attempts = 0;
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    // Fail fast: if the Unity child has already exited, waiting is pointless.
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        attempts,
        ms: Date.now() - t0,
        reason: 'unity-child-exited',
        childExitCode: child.exitCode,
        logTail: readLogTail(logFile),
      };
    }
    attempts += 1;
    const r = execReady(project, ['command', 'editor_status']);
    last = r;
    const status = r.json?.data?.result?.status;
    if (r.exit === 0 && status === 'ready') {
      return { ok: true, attempts, ms: Date.now() - t0, status };
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return {
    ok: false,
    attempts,
    ms: Date.now() - t0,
    lastExit: last?.exit,
    lastStdout: last?.stdout?.slice(0, 2000),
    lastStderr: last?.stderr?.slice(0, 2000),
    logTail: readLogTail(logFile),
  };
}

function readLogTail(logFile, maxChars = 4000) {
  if (!logFile) return '';
  try {
    const text = readFileSync(logFile, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

async function main() {
  T0 = Date.now();
  const report = {
    tool: 'u-cli',
    scope: 'windows-e2e',
    editorVersion: EDITOR_VERSION,
    editorRevision: EDITOR_REVISION,
    unity: UNITY,
    e2eRoot: E2E_ROOT,
    freshCache: FRESH_CACHE,
    generatedAt: new Date().toISOString(),
    sections: {},
  };
  REPORT_OBJ = report;

  if (!existsSync(CLI_JS)) {
    console.error('缺少 dist/cli.js，请先运行 npm run build');
    process.exit(2);
  }
  if (!existsSync(UNITY)) {
    console.error(`未找到 Unity：${UNITY}`);
    process.exit(2);
  }

  mkdirSync(E2E_ROOT, { recursive: true });

  const projectA = join(E2E_ROOT, 'ProjectA');
  const projectB = join(E2E_ROOT, 'ProjectB');
  // Each run starts from a clean slate for projects (cache may be reused).
  // Do this AFTER the stale-process sweep so no Unity holds locks on the dirs.
  for (const d of [projectA, projectB]) rmSync(d, { recursive: true, force: true });
  writeProject(projectA);
  writeProject(projectB);

  // Commander wiring smoke test: parse must NOT report "unknown command <proj>".
  {
    const r = runCli(['exec', 'C:/definitely-not-a-project-xyz', '--format', 'json', 'command', 'editor_status'], { env: cliEnv() });
    const parseOk = !/unknown command/.test(r.stderr + r.stdout);
    report.sections.parseSmoke = { exit: r.exit, parseOk, stderr: r.stderr.slice(0, 300) };
    if (!parseOk) fail('parseSmoke', `exec 参数解析异常：${r.stderr}`);
  }

  // Kill any stale Unity that references this E2E root (previous aborted runs).
  await sweepUnityInRoot();


  // 1. CLI install (fresh cache => real download + hash/signature verify; reuse => re-verify).
  {
    const r = runCli(['cli', 'install', '--editor', EDITOR_VERSION], { env: cliEnv() });
    const state = r.json?.results?.[0]?.state;
    const ok = r.exit === 0 && (state === 'valid' || state === 'downloaded');
    report.sections.cliInstall = { exit: r.exit, state, sha256: r.json?.results?.[0]?.sha256 };
    if (!ok) {
      fail('cliInstall', `exit=${r.exit} state=${state} stderr=${r.stderr.slice(0, 500)}`);
      throw new Error('cli install 失败，中止');
    }
  }

  // 2. Pipeline install (A).
  {
    const r = runCli(['pipeline', 'install', projectA], { env: cliEnv() });
    const status = r.json?.data?.status ?? r.json?.status;
    const ok = r.exit === 0 && status === 'Installed';
    report.sections.pipelineInstallA = { exit: r.exit, status, fileCount: r.json?.fileCount ?? r.json?.data?.fileCount };
    if (!ok) {
      fail('pipelineInstallA', `exit=${r.exit} ${r.stdout.slice(0, 1000)}`);
      throw new Error('pipeline install A 失败，中止');
    }
  }

  // 3. Unity batch compile (A).
  {
    const logFile = join(E2E_ROOT, 'logs', 'compile-A.log');
    const r = spawnSync(UNITY, ['-batchmode', '-nographics', '-projectPath', projectA, '-quit', '-logFile', logFile], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
    });
    let logText = '';
    try {
      logText = readFileSync(logFile, 'utf8');
    } catch {
      /* keep empty */
    }
    const errors = (logText.match(/error CS\d+/g) ?? []).slice(0, 20);
    const ok = r.status === 0 && errors.length === 0 && logText.includes('Exiting batchmode successfully');
    report.sections.batchCompile = { exit: r.status, errors, successLine: logText.includes('Exiting batchmode successfully') };
    if (!ok) fail('batchCompile', `exit=${r.status} errors=${errors.join('|')}`);
  }

  // 4. Start server A + wait ready (fail fast if the child exits).
  {
    const logFile = join(E2E_ROOT, 'logs', 'server-A.log');
    const child = spawnUnityServer(projectA, logFile);
    const ready = await waitReady(projectA, { label: 'A', child, logFile });
    report.sections.serverStartA = { pid: child.pid, ...ready };
    if (!ready.ok) fail('serverStartA', `未就绪：${JSON.stringify(ready).slice(0, 1000)}`);
  }

  // 5. Create scene (needed by get_scene_hierarchy) then READ_CALLS read-only calls.
  {
    const cs = runCli(['exec', projectA, '--format', 'json', 'command', 'create_scene', '--path', 'E2E/Main.unity'], { env: cliEnv() });
    report.sections.createScene = { exit: cs.exit, success: cs.json?.data?.success === true };
    if (cs.exit !== 0 || cs.json?.data?.success !== true) fail('createScene', cs.stdout.slice(0, 800));
  }
  {
    const latencies = [];
    let success = 0;
    const rows = [];
    for (let i = 0; i < READ_CALLS; i += 1) {
      const passthrough = i % 2 === 0 ? ['command', 'editor_status'] : ['command', 'get_scene_hierarchy'];
      const r = execReady(projectA, passthrough);
      const ok = r.exit === 0 && r.json?.success === true && r.json?.data?.success === true;
      if (ok) success += 1;
      else rows.push({ i, exit: r.exit, out: (r.stdout || '').slice(0, 300) });
      latencies.push(r.ms);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    report.sections.readCalls = { total: READ_CALLS, success, meanMs: +mean.toFixed(2), p50Ms: p50, p95Ms: p95, p99Ms: p99, maxMs: sorted[sorted.length - 1], failures: rows };
    if (success !== READ_CALLS) fail('readCalls', `${success}/${READ_CALLS} 成功`);
  }

  // 6. Mutation cycles.
  {
    const rows = [];
    let calls = 0;
    let okCalls = 0;
    for (let i = 0; i < MUTATION_CYCLES; i += 1) {
      const name = `E2EProbe_${String(i).padStart(2, '0')}`;
      const create = execReady(projectA, ['command', 'create_gameobject', '--name', name, '--primitive', 'cube']);
      calls += 1;
      const instanceId = create.json?.data?.result?.instanceId;
      const createOk = create.exit === 0 && instanceId != null;
      if (createOk) okCalls += 1;
      else rows.push({ cycle: i, step: 'create', out: (create.stdout || '').slice(0, 300) });

      const setT = execReady(projectA, ['command', 'set_transform', '--target', `instanceId:${instanceId}`, '--position', `${i},2,3`]);
      calls += 1;
      if (setT.exit === 0 && setT.json?.data?.success === true) okCalls += 1;
      else rows.push({ cycle: i, step: 'set_transform', out: (setT.stdout || '').slice(0, 300) });

      const find = execReady(projectA, ['command', 'find_gameobjects', '--name', name]);
      calls += 1;
      const found = find.json?.data?.result?.count === 1;
      if (find.exit === 0 && found) okCalls += 1;
      else rows.push({ cycle: i, step: 'find', out: (find.stdout || '').slice(0, 300) });

      const del = execReady(projectA, ['command', 'delete_gameobject', '--target', `instanceId:${instanceId}`]);
      calls += 1;
      if (del.exit === 0 && del.json?.data?.success === true) okCalls += 1;
      else rows.push({ cycle: i, step: 'delete', out: (del.stdout || '').slice(0, 300) });
    }
    const save = execReady(projectA, ['command', 'save_scene']);
    calls += 1;
    if (save.exit === 0 && save.json?.data?.success === true) okCalls += 1;
    else rows.push({ cycle: 'save', step: 'save_scene', out: (save.stdout || '').slice(0, 300) });
    report.sections.mutationCycles = { cycles: MUTATION_CYCLES, calls, success: okCalls, failures: rows };
    if (okCalls !== calls) fail('mutationCycles', `${okCalls}/${calls} 调用成功`);
  }

  // 7. Domain reload xN — the reload must be observed in the log (polled, in
  // case reload finishes asynchronously after the refresh eval returns), then
  // the FIRST status call after the reload must already be ready.
  {
    const probe = join(projectA, 'Assets', 'ReloadProbe.cs');
    const logFile = join(E2E_ROOT, 'logs', 'server-A.log');
    const countReloads = () => {
      try {
        return readFileSync(logFile, 'utf8').split('Begin MonoManager ReloadAssembly').length - 1;
      } catch {
        return 0;
      }
    };
    const rows = [];
    let allFirstOk = true;
    for (let i = 1; i <= RELOADS; i += 1) {
      const before = countReloads();
      writeFileSync(probe, `public static class ReloadProbe { public const int Revision = ${i}; }\n`, 'utf8');
      const trigger = execReady(projectA, [
        'command', 'eval', 'UnityEditor.AssetDatabase.Refresh(); return "refreshed";', '--timeout', '60000',
      ]);
      // Poll the log until the reload count actually grows (bounded). This
      // makes the first status check below deterministic instead of racing the
      // asynchronous domain reload.
      let observed = false;
      const reloadDeadline = Date.now() + 45000;
      while (Date.now() < reloadDeadline) {
        if (countReloads() > before) {
          observed = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      const first = execReady(projectA, ['command', 'editor_status']);
      const firstOk = first.exit === 0 && first.json?.data?.result?.status === 'ready';
      if (!firstOk) allFirstOk = false;
      rows.push({ cycle: i, triggerExit: trigger.exit, reloadObserved: observed, firstOk, firstExit: first.exit, firstStatus: first.json?.data?.result?.status });
      if (trigger.exit !== 0 || !observed || !firstOk) {
        fail('domainReload', `cycle ${i}: triggerExit=${trigger.exit} observed=${observed} firstOk=${firstOk}`);
      }
    }
    report.sections.domainReload = { cycles: RELOADS, allFirstOk, rows };
  }

  // 8. Kill-restart recovery for A.
  {
    const target = spawnedUnity.find((s) => s.kind === 'server' && s.project === projectA);
    if (target) {
      await killUnity(target.pid);
      // wait until the server is unreachable
      let down = false;
      for (let i = 0; i < 15; i += 1) {
        const r = execReady(projectA, ['command', 'editor_status']);
        if (r.exit !== 0) {
          down = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      spawnedUnity = spawnedUnity.filter((s) => s.pid !== target.pid);
      const logFile = join(E2E_ROOT, 'logs', 'server-A-restart.log');
      const child = spawnUnityServer(projectA, logFile);
      const ready = await waitReady(projectA, { label: 'A-restart', child, logFile });
      report.sections.killRestart = { detectedDown: down, recoveryMs: ready.ms, ready: ready.ok, pid: child.pid, childExitCode: child.exitCode };
      if (!down || !ready.ok) fail('killRestart', `down=${down} ready=${ready.ok} ${JSON.stringify(ready).slice(0, 1200)}`);
    } else {
      fail('killRestart', '找不到 server A 进程');
    }
  }

  // 9. Project B: install + server + ready.
  {
    const r = runCli(['pipeline', 'install', projectB], { env: cliEnv() });
    const status = r.json?.data?.status ?? r.json?.status;
    const ok = r.exit === 0 && status === 'Installed';
    report.sections.pipelineInstallB = { exit: r.exit, status };
    if (!ok) fail('pipelineInstallB', r.stdout.slice(0, 800));
    const logFile = join(E2E_ROOT, 'logs', 'server-B.log');
    const child = spawnUnityServer(projectB, logFile);
    const ready = await waitReady(projectB, { label: 'B', child, logFile });
    report.sections.serverStartB = { pid: child.pid, ...ready };
    if (!ready.ok) fail('serverStartB', JSON.stringify(ready).slice(0, 1000));
  }

  // 10. Dual-project explicit routing >= 60 calls, 0 misroutes.
  {
    const rows = [];
    let misroutes = 0;
    let ok = 0;
    for (let i = 0; i < TARGET_CALLS; i += 1) {
      const proj = i % 2 === 1 ? projectB : projectA;
      const r = execReady(proj, ['command', 'eval', 'return UnityEngine.Application.dataPath;']);
      const dataPath = r.json?.data?.result?.result;
      const expected = normForCompare(join(realpathNorm(proj), 'Assets'));
      const actual = normForCompare(dataPath ?? '');
      const isOk = r.exit === 0 && actual === expected;
      if (isOk) ok += 1;
      else misroutes += 1;
      rows.push({ i, target: proj, actual: dataPath, expected, ok: isOk, exit: r.exit });
    }
    // capture ports
    const pa = execReady(projectA, ['command', 'editor_status']);
    const pb = execReady(projectB, ['command', 'editor_status']);
    report.sections.dualTargeting = {
      calls: TARGET_CALLS,
      ok,
      misroutes,
      portA: pa.json?.data?.target?.port,
      portB: pb.json?.data?.target?.port,
      failures: rows.filter((x) => !x.ok).slice(0, 10),
    };
    if (misroutes !== 0 || ok !== TARGET_CALLS) fail('dualTargeting', `${ok}/${TARGET_CALLS} 正确，误选 ${misroutes}`);
  }

  // 11. Guards while editors are running.
  {
    const g1 = runCli(['pipeline', 'install', projectA], { env: cliEnv() });
    const g1Ok = g1.exit !== 0 && /Unity Editor/.test(g1.stdout + g1.stderr);
    const g2 = runCli(['pipeline', 'install', '.'], { cwd: projectA, env: cliEnv() });
    const g2Ok = g2.exit !== 0 && /Unity Editor/.test(g2.stdout + g2.stderr);
    const g3 = runCli(['exec', projectA, '--format', 'json', 'command', 'editor_status', '-projectPath', 'C:\\wrong'], { env: cliEnv() });
    const g3Ok = g3.exit !== 0 && /project-path|覆盖/.test(g3.stderr + g3.stdout);
    report.sections.guards = {
      absolutePath: { exit: g1.exit, ok: g1Ok },
      relativeDot: { exit: g2.exit, ok: g2Ok },
      projectPathOverride: { exit: g3.exit, ok: g3Ok, stderr: g3.stderr.slice(0, 300) },
    };
    if (!g1Ok || !g2Ok || !g3Ok) fail('guards', `g1=${g1Ok} g2=${g2Ok} g3=${g3Ok}`);
  }

  // 12. Cleanup servers, then idempotence check.
  {
    for (const s of spawnedUnity) await killUnity(s.pid);
    spawnedUnity = [];
    await new Promise((res) => setTimeout(res, 3000));
    await sweepUnityInRoot();
    await new Promise((res) => setTimeout(res, 2000));
    const r = runCli(['pipeline', 'install', projectA], { env: cliEnv() });
    const status = r.json?.data?.status ?? r.json?.status;
    const ok = r.exit === 0 && status === 'AlreadyInstalled';
    report.sections.idempotence = { exit: r.exit, status, ok };
    if (!ok) fail('idempotence', `${r.exit} ${r.stdout.slice(0, 500)}`);
  }

  // 13. Final cleanup: kill every Unity spawned by this harness, sweep any
  // Unity referencing the E2E root, verify zero remain, then write the report.
  for (const s of spawnedUnity) {
    await killUnity(s.pid);
  }
  spawnedUnity = [];
  await new Promise((res) => setTimeout(res, 2000));
  await sweepUnityInRoot();
  const remaining = await remainingUnityInRoot();
  report.sections.cleanup = { remainingUnityProcesses: remaining };
  if (remaining > 0) fail('cleanup', `残留 Unity 进程 ${remaining}`);
  await finishAndExit();
}

/** Write the JSON report (also reached from the fatal-error path) and exit. */
async function finishAndExit() {
  const report = REPORT_OBJ ?? { tool: 'u-cli', scope: 'windows-e2e' };
  report.pass = failures.length === 0;
  report.failures = failures;
  report.elapsedMs = Date.now() - T0;
  report.generatedAt = new Date().toISOString();
  if (!KEEP && report.e2eRoot) {
    for (const d of ['ProjectA', 'ProjectB']) {
      try {
        rmSync(join(report.e2eRoot, d), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  log(`report written: ${REPORT}`);
  log(`pass=${report.pass} failures=${failures.length} elapsedMs=${report.elapsedMs}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`[e2e] fatal: ${err.message}`);
  fail('fatal', err instanceof Error ? err.message : String(err));
  try {
    for (const s of spawnedUnity) await killUnity(s.pid);
  } catch {
    /* best-effort */
  }
  try {
    await sweepUnityInRoot();
  } catch {
    /* best-effort */
  }
  let remaining = 0;
  try {
    remaining = await remainingUnityInRoot();
  } catch {
    /* keep 0 */
  }
  const report = REPORT_OBJ ?? {};
  report.sections = report.sections ?? {};
  report.sections.cleanup = { remainingUnityProcesses: remaining };
  await finishAndExit();
});