import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProgram } from '../src/cli.js';

/**
 * CLI/Commander-level regression for the wait budget: `--wait <seconds>` is the
 * wrapper's own option (never forwarded to the Unity CLI) and must reach runExec,
 * while the pipeline arguments stay untouched.
 */
const captured = vi.hoisted(() => ({
  calls: [] as { project: string; args: string[]; options: { waitSeconds?: number } }[],
}));

vi.mock('../src/commands/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../src/commands/exec.js')>(
    '../src/commands/exec.js',
  );
  return {
    ...actual,
    runExec: vi.fn(
      async (project: string, args: string[], options: { waitSeconds?: number } = {}) => {
        captured.calls.push({ project, args, options });
        return { exitCode: 0 };
      },
    ),
  };
});

const ARGV = ['node', 'u-cli-mod'];

afterEach(() => {
  captured.calls.length = 0;
});

describe('exec --wait (CLI/Commander level)', () => {
  it('forwards the budget without leaking it into the pipeline args', async () => {
    await buildProgram().parseAsync([
      ...ARGV,
      'exec',
      'C:/proj',
      '--wait',
      '0',
      '--',
      'command',
      'run_tests',
      '--mode',
      'EditMode',
    ]);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual(['command', 'run_tests', '--mode', 'EditMode']);
    expect(captured.calls[0].options.waitSeconds).toBe(0);
  });

  it('leaves the budget undefined when --wait is absent', async () => {
    await buildProgram().parseAsync([...ARGV, 'exec', 'C:/proj', '--', 'command', 'run_tests']);
    expect(captured.calls[0].options.waitSeconds).toBeUndefined();
  });

  it('accepts a positive budget', async () => {
    await buildProgram().parseAsync([...ARGV, 'exec', 'C:/proj', '--wait', '120', '--', 'command', 'run_tests']);
    expect(captured.calls[0].options.waitSeconds).toBe(120);
  });
});
