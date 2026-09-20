import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readProjectInfo } from '../projectVersion.js';
import { resolveRouteForProject } from '../routes.js';
import { verifyCliBinary, ensureCliBinary } from '../ensure.js';
import { cliBinaryPath } from '../paths.js';
import { CliError } from '../errors.js';

/**
 * Every --project-path variant must be rejected: the wrapper owns targeting.
 * Case-insensitive; covers --project-path, -projectPath, --project_path,
 * -project-path=C:\x and every mixed-case combination.
 */
export function findProjectPathOverride(args: string[]): string | null {
  for (const arg of args) {
    if (/^--?project[-_]?path(=.*)?$/i.test(arg)) {
      return arg;
    }
  }
  return null;
}

/** The wrapper always appends its own resolved project path as the last args. */
export function buildExecArgs(cliArgs: string[], projectPath: string): string[] {
  return [...cliArgs, '--project-path', projectPath];
}

/**
 * Pipeline commands that block until the Editor-side work finishes.
 * The routed Unity CLI caps that wait at 30s, and its own `--timeout` is not wired
 * in the shipped build (verified: a full run_tests still waits ~30s with
 * `--timeout 1`), so the wait budget belongs to this wrapper.
 */
export const LONG_RUNNING_PIPELINE_COMMANDS: ReadonlySet<string> = new Set(['run_tests']);

/**
 * Long tasks hand control back after this many seconds so the caller can poll the
 * matching status command (`test_status`) instead of blocking on the CLI wait cap.
 */
export const DEFAULT_LONG_TASK_WAIT_SECONDS = 5;

/** Pipeline command name of a `command <name> ...` invocation; null when absent. */
export function extractPipelineCommandName(cliArgs: string[]): string | null {
  const at = cliArgs.indexOf('command');
  if (at < 0) {
    return null;
  }
  const name = cliArgs[at + 1];
  return name !== undefined && !name.startsWith('-') ? name : null;
}

/**
 * Wait budget (ms) for the Unity CLI child process:
 * - an explicit `--wait` wins (0 returns immediately);
 * - long-running pipeline commands get a short budget so callers can poll status;
 * - null means "wait synchronously for the CLI to finish" (unchanged behaviour).
 */
export function resolveWaitMilliseconds(
  cliArgs: string[],
  explicitWaitSeconds?: number,
): number | null {
  if (explicitWaitSeconds !== undefined) {
    return Math.max(0, Math.round(explicitWaitSeconds * 1000));
  }
  const name = extractPipelineCommandName(cliArgs);
  return name !== null && LONG_RUNNING_PIPELINE_COMMANDS.has(name)
    ? DEFAULT_LONG_TASK_WAIT_SECONDS * 1000
    : null;
}

/** Non-negative seconds for --wait; throws on anything else. */
function parseWaitValue(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError(`--wait 需要非负秒数，收到：${raw}`);
  }
  return value;
}

/**
 * Strips the wrapper's own `--wait <seconds>` / `--wait=<seconds>` from the
 * passthrough tail. commander copies everything after the <project> operand
 * verbatim (passThroughOptions), so a --wait written there must be lifted here
 * and must never leak into the Unity CLI arguments.
 */
export function extractWaitOption(args: string[]): { args: string[]; waitSeconds?: number } {
  const rest: string[] = [];
  let waitSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--wait' || arg === '-wait') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--wait 需要非负秒数。');
      }
      waitSeconds = parseWaitValue(value);
      i++;
      continue;
    }
    if (arg.startsWith('--wait=')) {
      waitSeconds = parseWaitValue(arg.slice('--wait='.length));
      continue;
    }
    rest.push(arg);
  }
  return waitSeconds === undefined ? { args: rest } : { args: rest, waitSeconds };
}
/** Exec output log of a handed-back run: project-scoped, beside the install receipts. */
export function execLogPath(
  projectPath: string,
  commandName: string | null,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = commandName === null ? '' : `-${commandName}`;
  return join(projectPath, 'Library', 'editor-pipeline-cli', 'exec-logs', `${stamp}${suffix}.log`);
}

export interface ExecOptions {
  downloadIfMissing?: boolean;
  waitSeconds?: number;
}

export async function runExec(
  projectPath: string,
  cliArgs: string[],
  options: ExecOptions = {},
) {
  const project = readProjectInfo(projectPath);
  const route = resolveRouteForProject(project);

  const override = findProjectPathOverride(cliArgs);
  if (override !== null) {
    throw new CliError(
      `exec 统一管理 --project-path，禁止在参数中覆盖目标工程：${override}`,
    );
  }

  let cliPath = cliBinaryPath(route.cli);
  const { existsSync } = await import('node:fs');
  if (!existsSync(cliPath)) {
    if (!options.downloadIfMissing) {
      throw new CliError(
        `该路由的 CLI 尚未下载：${cliPath}。请先运行 "u-cli-mod cli install"，或使用 --download-if-missing。`,
      );
    }
    await ensureCliBinary(route.cli);
    cliPath = cliBinaryPath(route.cli);
  }

  // Re-verify the hash on every invocation (fail closed on tamper).
  await verifyCliBinary(route.cli);

  const args = buildExecArgs(cliArgs, project.projectPath);
  const waitMs = resolveWaitMilliseconds(cliArgs, options.waitSeconds);
  if (waitMs === null) {
    const child = spawnSync(cliPath, args, { stdio: 'inherit', windowsHide: true });
    if (child.error) {
      throw new CliError(`CLI 执行失败：${child.error.message}`);
    }
    return { exitCode: child.status ?? 1 };
  }

  return runWithWaitBudget(
    cliPath,
    args,
    project.projectPath,
    waitMs,
    extractPipelineCommandName(cliArgs),
  );
}

/**
 * Runs the CLI under a wait budget. When the budget expires the child keeps running
 * (the Editor-side work is independent of it) and the wrapper hands control back
 * with the output log path, so callers can poll the matching status command.
 */
async function runWithWaitBudget(
  cliPath: string,
  args: string[],
  projectPath: string,
  waitMs: number,
  commandName: string | null,
) {
  const logPath = execLogPath(projectPath, commandName);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  const child = spawn(cliPath, args, { stdio: ['ignore', logFd, logFd], windowsHide: true });
  const spawnState: { error: Error | null } = { error: null };
  child.once('error', (error: Error) => {
    spawnState.error = error;
  });
  const finished = await waitForExit(child, waitMs);
  closeSync(logFd);

  if (finished) {
    if (spawnState.error !== null) {
      throw new CliError(`CLI 执行失败：${spawnState.error.message}`);
    }
    process.stdout.write(readFileSync(logPath, 'utf8'));
    return { exitCode: child.exitCode ?? 1 };
  }

  child.unref();
  const label = commandName ?? 'pipeline 命令';
  process.stderr.write(
    `[u-cli-mod] ${label} 仍在 Unity Editor 内继续执行：等待 ${(waitMs / 1000).toFixed(1)}s 后让出控制权（未中断）。\n` +
      `[u-cli-mod] 结果请轮询状态命令，例如：u-cli-mod exec <project> -- command test_status\n` +
      `[u-cli-mod] 完整输出日志：${logPath}\n` +
      `[u-cli-mod] 需要同步等待时传 --wait <秒>（0 = 立即返回）。\n`,
  );
  return { exitCode: 0 };
}

/** true when the child exited inside the budget; false when the budget expired. */
/** true when the child exited inside the budget; false when the budget expired. */
function waitForExit(child: ChildProcess, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(exited);
    };

    const timer = setTimeout(() => finish(false), waitMs);
    child.once('exit', () => {
      clearTimeout(timer);
      finish(true);
    });
    child.once('error', () => {
      clearTimeout(timer);
      finish(true);
    });
    if (waitMs === 0) {
      clearTimeout(timer);
      finish(false);
    }
  });
}
