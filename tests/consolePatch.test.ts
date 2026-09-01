import { describe, expect, it } from 'vitest';
import { patchConsoleCommands } from '../src/consolePatch.js';

const UPSTREAM = Buffer.from(`using System;
using System.Collections.Generic;
using System.Reflection;
using Unity.Pipeline.Commands;

namespace Unity.Pipeline.Editor.Commands.Observability
{
    public static class ConsoleCommands
    {
        [CliCommand("get_console_logs", "old")]
        public static object GetConsoleLogs(string severity = "all", int limit = 100)
        {
            return ConsoleLogBuffer.Snapshot();
        }

        [CliCommand("clear_console", "old")]
        public static object ClearConsole()
        {
            ConsoleLogBuffer.Clear();
            return new { cleared = true };
        }
    }
}
`);

describe('patchConsoleCommands', () => {
  it('replaces callback-buffer reads with an Editor LogEntries snapshot command', () => {
    const output = patchConsoleCommands(UPSTREAM).toString('utf8');

    expect(output).toContain('[CliCommand("read_console"');
    expect(output).toContain('GetEditorType("UnityEditor.LogEntries")');
    expect(output).toContain('GetRequiredMethod(logEntriesType, "StartGettingEntries")');
    expect(output).toContain('GetRequiredMethod(logEntriesType, "GetEntryInternal")');
    expect(output).toContain('endGettingEntries.Invoke(null, null)');
    expect(output).not.toContain('return ConsoleLogBuffer.Snapshot()');
  });

  it('makes reads independent of Console UI filters and restores the UI state', () => {
    const output = patchConsoleCommands(UPSTREAM).toString('utf8');

    expect(output).toContain('setConsoleFlag.Invoke(null, new object[] { 1 << 7, true })');
    expect(output).toContain('setConsoleFlag.Invoke(null, new object[] { 1 << 8, true })');
    expect(output).toContain('setConsoleFlag.Invoke(null, new object[] { 1 << 9, true })');
    expect(output).toContain('setFilteringText.Invoke(null, new object[] { string.Empty })');
    expect(output).toContain('consoleFlags.SetValue(null, originalFlags, null)');
    expect(output).toContain('setFilteringText.Invoke(null, new object[] { originalFilter })');
  });

  it('clears Unity LogEntries, both capture buffers, and the persisted snapshot', () => {
    const output = patchConsoleCommands(UPSTREAM).toString('utf8');

    expect(output).toContain('GetRequiredMethod(logEntriesType, "Clear").Invoke(null, null)');
    expect(output).toContain('ConsoleLogBuffer.Clear()');
    expect(output).toContain('Unity.Pipeline.Console.ConsoleLogCapture.Buffer.Clear()');
    expect(output).toContain(
      'Unity.Pipeline.Console.ConsoleLogCapture.Buffer.Save("Temp/pipeline_console_log.json")',
    );
  });

  it('is byte-idempotent and normalizes output to CRLF', () => {
    const once = patchConsoleCommands(UPSTREAM);
    const twice = patchConsoleCommands(once);

    expect(twice).toEqual(once);
    expect(once.toString('utf8')).not.toMatch(/(?<!\r)\n/);
  });

  it('fails closed when the pinned upstream anchor changes', () => {
    expect(() => patchConsoleCommands(Buffer.from('public class Unexpected {}\n'))).toThrow(
      /ConsoleCommands\.cs.*锚点/,
    );
  });
});
