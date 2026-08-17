import { spawnSync } from 'node:child_process';
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

export interface ExecOptions {
  downloadIfMissing?: boolean;
}

export async function runExec(projectPath: string, cliArgs: string[], options: ExecOptions = {}) {
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
  const child = spawnSync(cliPath, args, { stdio: 'inherit', windowsHide: true });
  if (child.error) {
    throw new CliError(`CLI 执行失败：${child.error.message}`);
  }
  return { exitCode: child.status ?? 1 };
}