#!/usr/bin/env node
import { Command } from 'commander';
import { CliError } from './errors.js';
import { runDoctor } from './commands/doctor.js';
import { runRoutes } from './commands/routesCmd.js';
import { runCliInstall } from './commands/cliInstall.js';
import { runPipelineInstall } from './commands/pipelineInstall.js';
import { runSetup } from './commands/setup.js';
import { runExec } from './commands/exec.js';
import { runCacheClean } from './commands/cacheClean.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function packageVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('u-cli-mod')
    .description('按精确 Unity Editor 版本路由、下载并安装 Unity CLI 与适配后的 com.unity.pipeline（Windows-first，非 Unity 官方项目）')
    .version(packageVersion())
    // Required so `exec` can use passThroughOptions (args after the project
    // positional are passed verbatim to the routed Unity CLI).
    .enablePositionalOptions(true);

  program
    .command('doctor <project>')
    .description('检查工程版本、路由、CLI 与 Pipeline 状态')
    .option('--allow-running-editor', '允许查询运行中的 Editor 时不失败')
    .action(async (project: string, opts: { allowRunningEditor?: boolean }) => {
      const result = await runDoctor(project, { allowRunningEditor: opts.allowRunningEditor });
      printJson(result);
    });

  program
    .command('routes')
    .description('列出所有已配置的 Editor 精确路由')
    .option('-e, --editor <version>', '只显示指定版本')
    .action((opts: { editor?: string }) => {
      printJson(runRoutes(opts.editor));
    });

  const cliCmd = program
    .command('cli')
    .description('下载并校验固定版本的 Unity CLI（SHA-256 + Authenticode）');
  cliCmd
    .command('install')
    .description('下载并校验固定版本的 Unity CLI（SHA-256 + Authenticode）')
    .option('--editor <version>', '限定 Editor 版本，默认全部路由')
    .option('--force', '强制重新下载')
    .action(async (opts: { editor?: string; force?: boolean }) => {
      printJson(await runCliInstall({ editorVersion: opts.editor, force: opts.force }));
    });

  const pipelineCmd = program
    .command('pipeline')
    .description('按工程 Editor 版本事务式安装适配后的 com.unity.pipeline');
  pipelineCmd
    .command('install <project>')
    .description('按工程 Editor 版本事务式安装适配后的 com.unity.pipeline')
    .option('--force', '覆盖现有不一致的包（先备份）')
    .option('--allow-running-editor', '跳过运行中 Editor 的 fail-closed 保护')
    .option('--dry-run', '只校验与预览，不写入工程')
    .action(
      async (
        project: string,
        opts: { force?: boolean; allowRunningEditor?: boolean; dryRun?: boolean },
      ) => {
        printJson(
          await runPipelineInstall(project, {
            force: opts.force,
            allowRunningEditor: opts.allowRunningEditor,
            dryRun: opts.dryRun,
          }),
        );
      },
    );

  program
    .command('setup <project>')
    .description('cli install + pipeline install')
    .option('--force', '覆盖现有不一致的包')
    .option('--allow-running-editor', '跳过运行中 Editor 的 fail-closed 保护')
    .option('--dry-run', '只校验与预览，不写入工程')
    .option('--skip-cli', '跳过 CLI 下载')
    .action(
      async (
        project: string,
        opts: {
          force?: boolean;
          allowRunningEditor?: boolean;
          dryRun?: boolean;
          skipCli?: boolean;
        },
      ) => {
        printJson(
          await runSetup(project, {
            force: opts.force,
            allowRunningEditor: opts.allowRunningEditor,
            dryRun: opts.dryRun,
            skipCli: opts.skipCli,
          }),
        );
      },
    );

  const execCmd = program
    .command('exec <project>')
    .description('调用路由 CLI 执行 Unity Pipeline 命令；--project-path 由工具统一绑定')
    .option('--download-if-missing', 'CLI 缺失时自动下载')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .passThroughOptions(true);
  execCmd.action(async (project: string, opts: { downloadIfMissing?: boolean }, command: Command) => {
    const extra = (command.args as string[]).slice(1);
    const { exitCode } = await runExec(project, extra, {
      downloadIfMissing: opts.downloadIfMissing,
    });
    process.exitCode = exitCode;
  });

  const cacheCmd = program
    .command('cache')
    .description('清理下载缓存与生成的适配包');
  cacheCmd
    .command('clean')
    .description('清理下载缓存与生成的适配包')
    .option('--all', '连 CLI 缓存一起清理')
    .action(async (opts: { all?: boolean }) => {
      printJson(await runCacheClean({ all: opts.all }));
    });

  return program;
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}