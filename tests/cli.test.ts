import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import type { Command } from 'commander';

interface Cap {
  restore: () => void;
  get: () => string;
}

function captureStdout(): Cap {
  const stdout = process.stdout as unknown as { write: (chunk: string) => boolean };
  const orig = stdout.write.bind(stdout);
  let out = '';
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  return {
    restore: () => {
      stdout.write = orig;
    },
    get: () => out,
  };
}

function captureStderr(): Cap {
  const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
  const orig = stderr.write.bind(stderr);
  let out = '';
  stderr.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  return {
    restore: () => {
      stderr.write = orig;
    },
    get: () => out,
  };
}

/** exitOverride on the root does NOT propagate to subcommands; apply it recursively. */
function overrideExit(program: Command): void {
  program.exitOverride();
  for (const cmd of program.commands) {
    overrideExit(cmd);
  }
}

// commander needs the full argv (node + script + args); pass a stable prefix.
const ARGV = ['node', 'u-cli-mod'];

const tmpRoots: string[] = [];

function makeProject(): { dir: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'epc-cli-'));
  tmpRoots.push(dir);
  const project = join(dir, 'proj');
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
  writeFileSync(
    join(project, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f3c1\nm_EditorVersionWithRevision: 2022.3.62f3c1 (1623fc0bbb97)\n',
  );
  return { dir, project };
}

afterEach(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tmpRoots.length = 0;
  delete process.env.LOCALAPPDATA;
});

describe('buildProgram (commander wiring)', () => {
  it('routes command prints the supported route set', async () => {
    const cap = captureStdout();
    try {
      const program = buildProgram();
      await program.parseAsync([...ARGV, 'routes']);
    } finally {
      cap.restore();
    }
    const out = cap.get();
    expect(out).toContain('2022.3.62f3c1');
    expect(out).toContain('editorVersion');
  });

  it('--version prints the package version and exits 0', async () => {
    const program = buildProgram();
    program.exitOverride();
    const cap = captureStdout();
    try {
      await expect(program.parseAsync([...ARGV, '--version'])).rejects.toMatchObject({
        exitCode: 0,
      });
    } finally {
      cap.restore();
    }
    expect(cap.get()).toContain('0.1.4');
  });

  it('unknown top-level command fails closed with exit code 1', async () => {
    const program = buildProgram();
    program.exitOverride();
    await expect(program.parseAsync([...ARGV, 'bogus-cmd'])).rejects.toMatchObject({
      exitCode: 1,
    });
  });

  it('subcommand groups are wired (cli install / pipeline install / cache clean)', async () => {
    const program = buildProgram();
    overrideExit(program);
    const cap = captureStderr();
    try {
      // Running a group command without a subcommand prints help and exits.
      for (const group of ['cli', 'pipeline', 'cache']) {
        await expect(program.parseAsync([...ARGV, group])).rejects.toThrow();
      }
    } finally {
      cap.restore();
    }
    // The group help output must list the actual subcommands.
    expect(cap.get()).toContain('install');
    expect(cap.get()).toContain('clean');
  });
});

describe('exec passthrough (commander)', () => {
  function execProgram(): ReturnType<typeof buildProgram> {
    return buildProgram();
  }

  it('rejects any project-path override variant passed through --', async () => {
    const { dir, project } = makeProject();
    process.env.LOCALAPPDATA = join(dir, 'la'); // hermetic cache, no real CLI running
    await expect(
      execProgram().parseAsync([
        ...ARGV,
        'exec',
        project,
        '--',
        'command',
        'editor_status',
        '-projectPath=C:\\other',
      ]),
    ).rejects.toThrow(/禁止在参数中覆盖目标工程/);
  });

  it('rejects the override without -- (passThroughOptions raw passthrough)', async () => {
    const { dir, project } = makeProject();
    process.env.LOCALAPPDATA = join(dir, 'la');
    await expect(
      execProgram().parseAsync([
        ...ARGV,
        'exec',
        project,
        'command',
        'get_scene_hierarchy',
        '--projectPath=C:\\x',
      ]),
    ).rejects.toThrow(/禁止在参数中覆盖目标工程/);
  });

  it('fails closed when the routed CLI is not downloaded yet', async () => {
    const { dir, project } = makeProject();
    process.env.LOCALAPPDATA = join(dir, 'la');
    await expect(
      execProgram().parseAsync([...ARGV, 'exec', project, '--', 'command', 'editor_status']),
    ).rejects.toThrow(/尚未下载/);
  });

  it('keeps passthrough args intact for a benign command (missing CLI error path)', async () => {
    const { dir, project } = makeProject();
    process.env.LOCALAPPDATA = join(dir, 'la');
    await expect(
      execProgram().parseAsync([
        ...ARGV,
        'exec',
        project,
        '--',
        '--format',
        'json',
        'command',
        'editor_status',
      ]),
    ).rejects.toThrow(/尚未下载/);
  });
});
