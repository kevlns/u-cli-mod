import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  DEFAULT_LONG_TASK_WAIT_SECONDS,
  extractPipelineCommandName,
  execLogPath,
  resolveWaitMilliseconds,
  extractWaitOption,
} from '../src/commands/exec.js';
import { LONG_RUNNING_PIPELINE_COMMANDS } from '../src/commands/exec.js';

describe('extractPipelineCommandName', () => {
  it('reads the pipeline command name after `command`', () => {
    expect(extractPipelineCommandName(['command', 'run_tests', '--mode', 'EditMode'])).toBe(
      'run_tests',
    );
  });

  it('returns null when there is no pipeline command name', () => {
    expect(extractPipelineCommandName(['command'])).toBeNull();
    expect(extractPipelineCommandName(['eval', '1+1'])).toBeNull();
    expect(extractPipelineCommandName(['command', '--timeout', '5'])).toBeNull();
    expect(extractPipelineCommandName([])).toBeNull();
  });
});

describe('resolveWaitMilliseconds', () => {
  it('hands control back early for long-running commands (run_tests)', () => {
    expect(LONG_RUNNING_PIPELINE_COMMANDS.has('run_tests')).toBe(true);
    expect(resolveWaitMilliseconds(['command', 'run_tests', '--mode', 'EditMode'])).toBe(
      DEFAULT_LONG_TASK_WAIT_SECONDS * 1000,
    );
  });

  it('keeps synchronous waiting for everything else', () => {
    expect(resolveWaitMilliseconds(['command', 'editor_status'])).toBeNull();
    expect(resolveWaitMilliseconds(['command', 'test_status'])).toBeNull();
    expect(resolveWaitMilliseconds(['command', 'read_console', '--count', '100'])).toBeNull();
  });

  it('lets an explicit --wait win, including 0 for immediate return', () => {
    expect(resolveWaitMilliseconds(['command', 'run_tests'], 120)).toBe(120_000);
    expect(resolveWaitMilliseconds(['command', 'run_tests'], 0)).toBe(0);
    expect(resolveWaitMilliseconds(['command', 'editor_status'], 0.5)).toBe(500);
  });
});

describe('execLogPath', () => {
  it('is project-scoped, command-suffixed and deterministic for a given timestamp', () => {
    const path = execLogPath('C:/proj', 'run_tests', new Date('2026-09-20T03:00:00.000Z'));
    expect(path).toBe(
      join(
        'C:/proj',
        'Library',
        'editor-pipeline-cli',
        'exec-logs',
        '2026-09-20T03-00-00-000Z-run_tests.log',
      ),
    );
  });

  it('omits the suffix when the command name is unknown', () => {
    const path = execLogPath('C:/proj', null, new Date('2026-09-20T03:00:00.000Z'));
    expect(path.endsWith('2026-09-20T03-00-00-000Z.log')).toBe(true);
  });
});
describe('extractWaitOption', () => {
  it('lifts --wait <seconds> out of the passthrough tail', () => {
    expect(extractWaitOption(['--wait', '0', 'command', 'run_tests'])).toEqual({
      args: ['command', 'run_tests'],
      waitSeconds: 0,
    });
  });

  it('supports the --wait=<seconds> spelling', () => {
    expect(extractWaitOption(['command', 'run_tests', '--wait=120'])).toEqual({
      args: ['command', 'run_tests'],
      waitSeconds: 120,
    });
  });

  it('leaves arguments untouched when --wait is absent', () => {
    expect(extractWaitOption(['command', 'editor_status'])).toEqual({
      args: ['command', 'editor_status'],
    });
  });

  it('throws when --wait has no value', () => {
    expect(() => extractWaitOption(['command', 'run_tests', '--wait'])).toThrow();
  });

  it('throws on negative or non-numeric values', () => {
    expect(() => extractWaitOption(['--wait', '-1', 'command', 'run_tests'])).toThrow();
    expect(() => extractWaitOption(['--wait', 'soon', 'command', 'run_tests'])).toThrow();
  });
});
