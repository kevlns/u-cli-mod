import { describe, expect, it } from 'vitest';
import { CliError } from '../src/errors.js';
import {
  patchPipelineTestRunner,
  patchRecompileCommand,
  patchTestCommands,
  patchTestExecutionResponse,
  pipelineTestRunnerPatches,
  recompileCommandPatches,
  testCommandsPatches,
  testExecutionResponsePatches,
} from '../src/runIdPatch.js';

/** 由锚点构造合成上游源（各锚点块之间用占位分隔，模拟真实文件里的无关代码） */
function fixture(pairs: Array<[string, string]>): Buffer {
  return Buffer.from(pairs.map(([anchor]) => `// …\n${anchor}\n// …\n`).join('\n'), 'utf8');
}

describe('runId 补丁（patchVersion 3）', () => {
  it('TestCommands：test_status/cancel_tests 增加 run_id 参数并透传', () => {
    const out = patchTestCommands(fixture(testCommandsPatches)).toString('utf8');
    expect(out).toContain('[CliArg("run_id"');
    expect(out).toContain('PipelineTestRunner.GetTestStatus(string.IsNullOrEmpty(runId) ? null : runId.Trim())');
    expect(out).toContain('PipelineTestRunner.CancelTests(string.IsNullOrEmpty(runId) ? null : runId.Trim())');
    // 幂等
    expect(patchTestCommands(Buffer.from(out, 'utf8')).toString('utf8')).toBe(out);
  });

  it('PipelineTestRunner：runId 生成/持久化/回显/关联读/定向取消全部落位', () => {
    const out = patchPipelineTestRunner(fixture(pipelineTestRunnerPatches)).toString('utf8');
    expect(out).toContain('public string runId;');
    expect(out).toContain('var runId = Guid.NewGuid().ToString("N");');
    expect(out).toContain('RunId = runId,');
    expect(out).toContain('StartAsyncTestExecution(testMode, filter, filterType, includeExplicit, runId);');
    expect(out).toContain('ReattachResultCollector(request.runId);');
    expect(out).toContain('WriteCompletedResults(collector, runId);');
    expect(out).toContain('runId = runId, message = "Tests did not complete"');
    expect(out).toContain('Failed to write results: {ex.Message}');
    expect(out).toContain('Failed to write results: {ex.Message}');
    // P1-3 修复回归：三处 error 载荷都携带 runId
    expect(out).toContain('runId = runId, message = ex.Message');
    expect(out).toContain('Failed to reattach result collector');
    expect(out.match(/runId = runId, message = ex\.Message/g)?.length).toBe(4);
    expect(out).toContain('public static string GetTestStatus(string runId = null)');
    expect(out).toContain('"unknown_run"');
    expect(out).toContain('requestedRunId = runId');
    expect(out).toContain('public static object CancelTests(string runId = null)');
    expect(out).toContain('"no_active_run"');
    // 定向取消不匹配分支：先于任何 WriteStatusFile（零副作用）——校验分支顺序
    const mismatchIndex = out.indexOf('no cancellation was performed.');
    const cancelledWrite = out.indexOf('WriteStatusFile(new { status = "cancelled", runId = cancelledRunId');
    expect(mismatchIndex).toBeGreaterThan(-1);
    expect(cancelledWrite).toBeGreaterThan(mismatchIndex);
    expect(patchPipelineTestRunner(Buffer.from(out, 'utf8')).toString('utf8')).toBe(out);
  });

  it('RecompileCommand：pending runId 贯穿触发→引擎事件→终态；recompile_status 关联读', () => {
    const out = patchRecompileCommand(fixture(recompileCommandPatches)).toString('utf8');
    expect(out).toContain('static string s_PendingRunId;');
    expect(out).toContain('WriteStatus("triggered", runId, false, null);');
    expect(out).toContain('WriteStatus("compiling", s_PendingRunId, false, null);');
    expect(out).toContain('WriteStatus("completed", s_PendingRunId, s_Errors.Count > 0, s_Errors.ToArray());');
    expect(out).toContain('public static string RecompileStatus(');
    expect(out).toContain('"unknown_run"');
    expect(out).toContain('var payload = new { status, runId, failed, errors = errors ?? Array.Empty<string>() };');
    // 一审修复回归：up_to_date 清 pending；三处 error 载荷带 runId（在 PipelineTestRunner 断言中覆盖后两类）
    expect(out).toContain('s_PendingRunId = null;');
    expect(patchRecompileCommand(Buffer.from(out, 'utf8')).toString('utf8')).toBe(out);
  });

  it('TestExecutionResponse：RunId 字段加入', () => {
    const out = patchTestExecutionResponse(fixture(testExecutionResponsePatches)).toString('utf8');
    expect(out).toContain('public string RunId { get; set; }');
    expect(patchTestExecutionResponse(Buffer.from(out, 'utf8')).toString('utf8')).toBe(out);
  });

  it('CRLF 输入被 LF 归一；锚点缺失硬失败（上游修订漂移显式暴露）', () => {
    const crlf = fixture(testExecutionResponsePatches).toString('utf8').replace(/\n/g, '\r\n');
    const out = patchTestExecutionResponse(Buffer.from(crlf, 'utf8')).toString('utf8');
    expect(out).not.toContain('\r\n');

    const broken = testExecutionResponsePatches.map((pair, i) =>
      i === 0 ? ([pair[0].replace('StatusPath', 'Status_Path'), pair[1]] as [string, string]) : pair,
    );
    expect(() => patchTestExecutionResponse(fixture(broken))).toThrow(CliError);
  });
});
