import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProgram } from '../src/cli.js';

/**
 * CLI/Commander-level regression: the documented invocation
 *   u-cli-mod exec <project> -- command ...
 * must NOT forward the literal `--` separator to runExec (and therefore not
 * to the Unity CLI). With passThroughOptions(true) commander copies the whole
 * tail verbatim once the project operand is seen, so the wrapper itself is
 * responsible for stripping the separator. runExec is mocked here purely to
 * observe the exact argument array it receives; the real runExec path
 * (project-path rejection, hash re-verification, spawn) stays covered by
 * tests/cli.test.ts and tests/exec.test.ts.
 */

const captured = vi.hoisted(() => ({ calls: [] as { project: string; args: string[] }[] }));

vi.mock('../src/commands/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../src/commands/exec.js')>(
    '../src/commands/exec.js',
  );
  return {
    ...actual,
    runExec: vi.fn(async (project: string, cliArgs: string[]) => {
      captured.calls.push({ project, args: cliArgs });
      return { exitCode: 0 };
    }),
  };
});

const ARGV = ['node', 'u-cli-mod'];

afterEach(() => {
  captured.calls.length = 0;
});

describe('exec -- separator (CLI/Commander level)', () => {
  it('does not forward the literal -- separator (documented form)', async () => {
    await buildProgram().parseAsync([
      ...ARGV,
      'exec',
      'C:/proj',
      '--',
      'command',
      'editor_status',
    ]);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual(['command', 'editor_status']);
    expect(captured.calls[0].project).toBe('C:/proj');
  });

  it('supports invocation without the separator', async () => {
    await buildProgram().parseAsync([...ARGV, 'exec', 'C:/proj', 'command', 'editor_status']);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual(['command', 'editor_status']);
  });

  it('strips -- even after passthrough options (mixed form)', async () => {
    await buildProgram().parseAsync([
      ...ARGV,
      'exec',
      'C:/proj',
      '--format',
      'json',
      '--',
      'command',
      'editor_status',
    ]);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual(['--format', 'json', 'command', 'editor_status']);
  });

  it('strips -- in mid-argument position and preserves surrounding args', async () => {
    await buildProgram().parseAsync([
      ...ARGV,
      'exec',
      'C:/proj',
      'command',
      '--',
      'editor_status',
    ]);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual(['command', 'editor_status']);
  });

  it('passes an empty arg array when only the separator follows', async () => {
    await buildProgram().parseAsync([...ARGV, 'exec', 'C:/proj', '--']);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].args).toEqual([]);
  });
});