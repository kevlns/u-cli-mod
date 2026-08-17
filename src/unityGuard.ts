import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface UnityProcessInfo {
  processId: number;
  commandLine: string | null;
}

export interface EditorGuardResult {
  ok: boolean;
  blockedBy: string[];
  reason?: string;
}

/**
 * Fail-closed guard: when the Unity process query itself fails, or a process
 * command line cannot be read, the caller must refuse to proceed unless the
 * operator explicitly opts in with --allow-running-editor.
 */
export async function queryUnityProcesses(
  projectPath: string,
  { powershell = 'powershell.exe' }: { powershell?: string } = {},
): Promise<{ all: UnityProcessInfo[]; matching: UnityProcessInfo[] }> {
  const script = String.raw`
@(Get-CimInstance Win32_Process -Filter "Name = 'Unity.exe'" | Select-Object ProcessId, CommandLine) |
  ConvertTo-Json -Compress -Depth 3
`;
  let stdout: string;
  try {
    const result = await execFileAsync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    stdout = result.stdout.trim();
  } catch (err) {
    throw new CliError(
      `无法查询运行中的 Unity Editor（fail-closed）。请确认 PowerShell 可用，或明确使用 --allow-running-editor。${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let processes: UnityProcessInfo[] = [];
  if (stdout.length > 0) {
    try {
      const parsed = JSON.parse(stdout);
      processes = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        processId: Number(p.ProcessId),
        commandLine: typeof p.CommandLine === 'string' ? p.CommandLine : null,
      }));
    } catch {
      throw new CliError('无法解析 Unity 进程查询结果（fail-closed）。请明确使用 --allow-running-editor。');
    }
  }
  const unreadable = processes.filter((p) => p.commandLine === null || p.commandLine.length === 0);
  if (unreadable.length > 0) {
    throw new CliError(
      `存在无法读取命令行的 Unity 进程（PID：${unreadable.map((p) => p.processId).join(', ')}）。无法排除目标工程正在运行，已 fail-closed。如有意继续请使用 --allow-running-editor。`,
    );
  }
  const needleFwd = projectPath.replace(/\\/g, '/').toLowerCase();
  const needle = projectPath.toLowerCase();
  const matching = processes.filter((p) => {
    const cl = p.commandLine!.toLowerCase();
    const clFwd = cl.replace(/\\/g, '/');
    return cl.includes(needle) || clFwd.includes(needleFwd);
  });
  return { all: processes, matching };
}

export async function guardNoRunningEditor(
  projectPath: string,
  { powershell }: { powershell?: string } = {},
): Promise<EditorGuardResult> {
  const { matching } = await queryUnityProcesses(projectPath, { powershell });
  return {
    ok: matching.length === 0,
    blockedBy: matching.map((p) => `PID ${p.processId}`),
  };
}