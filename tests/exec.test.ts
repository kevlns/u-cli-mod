import { describe, it, expect } from 'vitest';
import { findProjectPathOverride, buildExecArgs } from '../src/commands/exec.js';

function detects(arg: string): void {
  expect(findProjectPathOverride([arg])).toBe(arg);
}

function rejects(arg: string): void {
  expect(findProjectPathOverride([arg])).toBeNull();
}

function detectsWithValue(arg: string): void {
  expect(findProjectPathOverride([arg, 'C:\\x'])).toBe(arg);
  expect(findProjectPathOverride([`${arg}=C:\\x`])).toBe(`${arg}=C:\\x`);
}

describe('findProjectPathOverride', () => {
  it('detects --project-path <value>', () => {
    detectsWithValue('--project-path');
  });

  it('detects --project-path=<value>', () => {
    expect(findProjectPathOverride(['command', '--project-path=C:\\x'])).toBe(
      '--project-path=C:\\x',
    );
  });

  it('detects single-dash -project-path variants', () => {
    detectsWithValue('-project-path');
  });

  it('detects -projectPath (Unity batchmode spelling)', () => {
    detectsWithValue('-projectPath');
  });

  it('detects --projectPath and --project_path spellings', () => {
    detectsWithValue('--projectPath');
    detectsWithValue('--project_path');
    detectsWithValue('-project_path');
  });

  it('is case-insensitive', () => {
    detects('--Project-Path');
    detects('-PROJECTPATH');
    detects('--PROJECT_PATH=C:\\x');
    detects('-ProjectPath');
  });

  it('detects it anywhere in the argument list', () => {
    expect(findProjectPathOverride(['--format', 'json', 'eval', '-projectPath', '/p'])).toBe(
      '-projectPath',
    );
    expect(findProjectPathOverride(['eval', '--ProjectPath=C:\\P'])).toBe(
      '--ProjectPath=C:\\P',
    );
  });

  it('returns null when absent', () => {
    expect(
      findProjectPathOverride(['--format', 'json', 'command', 'editor_status', '--timeout', '30']),
    ).toBeNull();
  });

  it('does not false-positive on --project/--projects/--project-name', () => {
    rejects('--projects=a');
    rejects('--project');
    rejects('--project-name');
  });

  it('does not match --project-pathology or --projected', () => {
    rejects('--project-pathology');
    rejects('--projected');
  });
});

describe('buildExecArgs', () => {
  it('appends the wrapper-owned --project-path last', () => {
    expect(buildExecArgs(['command', 'editor_status'], 'C:/p')).toEqual([
      'command',
      'editor_status',
      '--project-path',
      'C:/p',
    ]);
  });
});