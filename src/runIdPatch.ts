import { CliError } from './errors.js';

/**
 * runId protocol patch (patchVersion 3): cross-domain-reload task identity for
 * the test pipeline and recompile status, consumed by v-cli execution handles.
 *
 * Semantics (design of record: v-cli .vant/docs/spec/phase-a-identity-matrix.md §3):
 * - run_tests --async_tests assigns a runId (GUID "N"), persisted in the request
 *   file and echoed in the response (TestExecutionResponse.RunId); every status
 *   payload written for that run (completed/error/cancelled) carries the runId.
 * - test_status --run_id <id>: correlated read. Request file with matching id ->
 *   running; status file with matching id -> its content; anything else ->
 *   {"status":"unknown_run"} — NEVER another run's record, never the latest run.
 * - cancel_tests --run_id <id>: directed cancel. Mismatched or no active run ->
 *   {"status":"unknown_run"|"no_active_run"} with ZERO side effects (the status
 *   file of another run is never overwritten). Matching id -> current cancel
 *   behaviour, with runId recorded in the cancelled payload.
 * - recompile assigns a runId; engine compilation events propagate it to the
 *   terminal payload. Engine-spontaneous compiles (no pending command id) write
 *   runId:null. recompile_status --run_id mirrors the correlated-read semantics.
 *
 * All patches are exact-anchor string replacements over the pinned upstream
 * bytes; a missing anchor is a hard error (the upstream revision moved), never
 * a silent skip. Output is LF-normalized like the other patches.
 */

function applyPatches(source: Buffer, name: string, sentinel: string, pairs: Array<[string, string]>): Buffer {
  let s = source.toString('utf8');
  if (s.includes(sentinel)) {
    // Already patched: idempotent no-op (normalized passthrough).
    return Buffer.from(s.replace(/\r\n/g, '\n'), 'utf8');
  }
  for (const [anchor, replacement] of pairs) {
    if (!s.includes(anchor)) {
      throw new CliError(`${name} 缺少锚点（上游修订已变化？）: ${JSON.stringify(anchor.slice(0, 80))}…`);
    }
    s = s.replace(anchor, replacement);
  }
  return Buffer.from(s.replace(/\r\n/g, '\n'), 'utf8');
}

export const testCommandsPatches: Array<[string, string]> = [
    [
      `        [CliCommand("test_status", "Get status of running async test execution", MainThreadRequired = false, Tags = new[] { "tests" })]
        public static string GetTestStatus()
        {
            var status = PipelineTestRunner.GetTestStatus();
            return status ?? "{\\"status\\":\\"no_tests\\",\\"message\\":\\"No test run in progress\\"}";
        }`,
      `        [CliCommand("test_status", "Get status of running async test execution; optional run_id for correlated query", MainThreadRequired = false, Tags = new[] { "tests" })]
        public static string GetTestStatus(
            [CliArg("run_id", "Optional run id from run_tests --async_tests: return only that run's record; unknown_run otherwise (never another run's record)")] string runId = null)
        {
            var status = PipelineTestRunner.GetTestStatus(string.IsNullOrEmpty(runId) ? null : runId.Trim());
            return status ?? "{\\"status\\":\\"no_tests\\",\\"message\\":\\"No test run in progress\\"}";
        }`,
    ],
    [
      `        [CliCommand("cancel_tests", "Cancel running test execution", MainThreadRequired = true, Tags = new[] { "tests" })]
        public static object CancelTests()
        {
            return PipelineTestRunner.CancelTests();
        }`,
      `        [CliCommand("cancel_tests", "Cancel running test execution; optional run_id for directed cancel (mismatch has no side effects)", MainThreadRequired = true, Tags = new[] { "tests" })]
        public static object CancelTests(
            [CliArg("run_id", "Optional run id to cancel; unknown_run/no_active_run when it is not the active run, leaving everything untouched")] string runId = null)
        {
            return PipelineTestRunner.CancelTests(string.IsNullOrEmpty(runId) ? null : runId.Trim());
        }`,
    ],
];

export function patchTestCommands(bytes: Buffer): Buffer {
  return applyPatches(bytes, 'TestCommands.cs', 'CliArg("run_id"', testCommandsPatches);
}

export const pipelineTestRunnerPatches: Array<[string, string]> = [
    // 1) request model carries the run id
    [
      `            public bool includeExplicit;
            public bool isSync;
        }`,
      `            public bool includeExplicit;
            public bool isSync;
            public string runId;
        }`,
    ],
    // 2) async start: assign run id, persist it, echo it, thread it through
    [
      `                // Save request to disk (survives domain reloads for PlayMode)
                var request = new TestRequest
                {
                    filter = filter,
                    filterType = filterType,
                    mode = testMode.ToString(),
                    includeExplicit = includeExplicit,
                    isSync = false
                };
                File.WriteAllText(TestRequestFile, JsonConvert.SerializeObject(request));`,
      `                // Save request to disk (survives domain reloads for PlayMode)
                var runId = Guid.NewGuid().ToString("N");
                var request = new TestRequest
                {
                    filter = filter,
                    filterType = filterType,
                    mode = testMode.ToString(),
                    includeExplicit = includeExplicit,
                    isSync = false,
                    runId = runId
                };
                File.WriteAllText(TestRequestFile, JsonConvert.SerializeObject(request));`,
    ],
    [
      `                StartAsyncTestExecution(testMode, filter, filterType, includeExplicit);`,
      `                StartAsyncTestExecution(testMode, filter, filterType, includeExplicit, runId);`,
    ],
    [
      `                    Result = "running",
                    StatusPath = TestStatusFile,
                    Mode = testMode.ToString(),`,
      `                    Result = "running",
                    RunId = runId,
                    StatusPath = TestStatusFile,
                    Mode = testMode.ToString(),`,
    ],
    // 3) async execution thread: run id into every status write
    [
      `        private static void StartAsyncTestExecution(TestMode testMode, string filter, string filterType, bool includeExplicit)
        {`,
      `        private static void StartAsyncTestExecution(TestMode testMode, string filter, string filterType, bool includeExplicit, string runId)
        {`,
    ],
    [
      `                // Async completion: write results for pollers. Set once, never overwritten.
                collector.OnRunFinished = () =>
                {
                    WriteCompletedResults(collector);
                    RestoreLiveServerIfDisrupted(); // B2: self-heal if a test broke the live server.
                    CleanupRequestFile();
                    UnregisterCollector(api, collector);
                };`,
      `                // Async completion: write results for pollers. Set once, never overwritten.
                collector.OnRunFinished = () =>
                {
                    WriteCompletedResults(collector, runId);
                    RestoreLiveServerIfDisrupted(); // B2: self-heal if a test broke the live server.
                    CleanupRequestFile();
                    UnregisterCollector(api, collector);
                };`,
    ],
    [
      `                        if (testNames.Count == 0)
                        {
                            WriteStatusFile(new
                            {
                                status = "completed",
                                duration = 0.0,
                                summary = new { total = 0, passed = 0, failed = 0, skipped = 0, inconclusive = 0 },
                                results = new object[0]
                            });`,
      `                        if (testNames.Count == 0)
                        {
                            WriteStatusFile(new
                            {
                                status = "completed",
                                runId = runId,
                                duration = 0.0,
                                summary = new { total = 0, passed = 0, failed = 0, skipped = 0, inconclusive = 0 },
                                results = new object[0]
                            });`,
    ],
    [
      `                        Debug.LogError($"[PipelineTestRunner] Async run setup error: {ex.Message}");
                        WriteStatusFile(new { status = "error", message = ex.Message });`,
      `                        Debug.LogError($"[PipelineTestRunner] Async run setup error: {ex.Message}");
                        WriteStatusFile(new { status = "error", runId = runId, message = ex.Message });`,
    ],
    [
      `                Debug.LogError($"[PipelineTestRunner] Async execution error: {ex.Message}");
                WriteStatusFile(new { status = "error", message = ex.Message });`,
      `                Debug.LogError($"[PipelineTestRunner] Async execution error: {ex.Message}");
                WriteStatusFile(new { status = "error", runId = runId, message = ex.Message });`,
    ],
    // 4) post-reload reattach: recover the run id from the request file
    [
      `        private static void ReattachResultCollector()
        {`,
      `        private static void ReattachResultCollector(string runId)
        {`,
    ],
    [
      `                collector.OnRunFinished = () =>
                {
                    WriteCompletedResults(collector);
                    RestoreLiveServerIfDisrupted();
                    CleanupRequestFile();
                    UnregisterCollector(api, collector);
                };`,
      `                collector.OnRunFinished = () =>
                {
                    WriteCompletedResults(collector, runId);
                    RestoreLiveServerIfDisrupted();
                    CleanupRequestFile();
                    UnregisterCollector(api, collector);
                };`,
    ],
    [
      `                // We only need to re-register a collector — our previous one did not survive the
                // reload — to capture the resumed run's completion. Runs on the main thread because
                // CheckForPendingTests is invoked via EditorApplication.delayCall.
                ReattachResultCollector();`,
      `                // We only need to re-register a collector — our previous one did not survive the
                // reload — to capture the resumed run's completion. Runs on the main thread because
                // CheckForPendingTests is invoked via EditorApplication.delayCall.
                ReattachResultCollector(request.runId);`,
    ],
    // 5) terminal report carries the run id
    [
      `        private static void WriteCompletedResults(TestResultCollector collector)
        {`,
      `        private static void WriteCompletedResults(TestResultCollector collector, string runId)
        {`,
    ],
    [
      `                var result = new
                {
                    status = "completed",
                    duration = Math.Round(root.Duration, 2),`,
      `                var result = new
                {
                    status = "completed",
                    runId = runId,
                    duration = Math.Round(root.Duration, 2),`,
    ],
    // 6) correlated status read + helpers
    [
      `        /// <summary>
        /// Get current test status (for async mode polling)
        /// </summary>
        public static string GetTestStatus()
        {
            if (File.Exists(TestStatusFile))
                return File.ReadAllText(TestStatusFile);
            if (File.Exists(TestRequestFile))
                return JsonConvert.SerializeObject(new { status = "running" });
            return null;
        }`,
      `        private class RunIdEnvelope
        {
            public string runId { get; set; }
        }

        private static string RequestRunId()
        {
            try
            {
                if (!File.Exists(TestRequestFile)) return null;
                var request = JsonConvert.DeserializeObject<TestRequest>(File.ReadAllText(TestRequestFile));
                return string.IsNullOrEmpty(request?.runId) ? null : request.runId;
            }
            catch
            {
                return null;
            }
        }

        private static string StatusRunId()
        {
            try
            {
                if (!File.Exists(TestStatusFile)) return null;
                var envelope = JsonConvert.DeserializeObject<RunIdEnvelope>(File.ReadAllText(TestStatusFile));
                return string.IsNullOrEmpty(envelope?.runId) ? null : envelope.runId;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Get current test status (for async mode polling). With runId: correlated
        /// read — only the requested run's record is returned; unknown_run otherwise.
        /// </summary>
        public static string GetTestStatus(string runId = null)
        {
            if (runId == null)
            {
                if (File.Exists(TestStatusFile))
                    return File.ReadAllText(TestStatusFile);
                if (File.Exists(TestRequestFile))
                    return JsonConvert.SerializeObject(new { status = "running" });
                return null;
            }

            if (File.Exists(TestRequestFile) && RequestRunId() == runId)
                return JsonConvert.SerializeObject(new { status = "running", runId = runId });

            if (File.Exists(TestStatusFile))
            {
                if (StatusRunId() == runId)
                    return File.ReadAllText(TestStatusFile);
                return JsonConvert.SerializeObject(new
                {
                    status = "unknown_run",
                    requestedRunId = runId,
                    message = "Requested run is not the tracked run; refusing to return another run's record."
                });
            }

            return JsonConvert.SerializeObject(new
            {
                status = "unknown_run",
                requestedRunId = runId,
                message = "No record for the requested run id."
            });
        }`,
    ],
    // 7) error terminal payloads carry the run id (spec: ALL status payloads of a run carry runId)
    [
      `                if (!collector.IsComplete)
                {
                    WriteStatusFile(new { status = "error", message = "Tests did not complete" });
                    return;
                }`,
      `                if (!collector.IsComplete)
                {
                    WriteStatusFile(new { status = "error", runId = runId, message = "Tests did not complete" });
                    return;
                }`,
    ],
    [
      `            catch (Exception ex)
            {
                Debug.LogError($"[PipelineTestRunner] Failed to write results: {ex.Message}");
                WriteStatusFile(new { status = "error", message = ex.Message });
            }`,
      `            catch (Exception ex)
            {
                Debug.LogError($"[PipelineTestRunner] Failed to write results: {ex.Message}");
                WriteStatusFile(new { status = "error", runId = runId, message = ex.Message });
            }`,
    ],
    [
      `            catch (Exception ex)
            {
                Debug.LogError($"[PipelineTestRunner] Failed to reattach result collector: {ex.Message}");
                WriteStatusFile(new { status = "error", message = ex.Message });
                CleanupRequestFile();
                UnregisterCollector(api, collector);
            }`,
      `            catch (Exception ex)
            {
                Debug.LogError($"[PipelineTestRunner] Failed to reattach result collector: {ex.Message}");
                WriteStatusFile(new { status = "error", runId = runId, message = ex.Message });
                CleanupRequestFile();
                UnregisterCollector(api, collector);
            }`,
    ],
    // 7) directed cancel: mismatch has zero side effects
    [
      `        public static object CancelTests()
        {
            if (m_ActiveCollector == null && !File.Exists(TestRequestFile) && !File.Exists(TestStatusFile))
                return new { status = "no_tests", message = "No test run in progress." };

            bool wasPlayMode = false;
            try
            {
                if (File.Exists(TestRequestFile))
                {
                    var json = File.ReadAllText(TestRequestFile);
                    wasPlayMode = json.Contains("PlayMode");
                }
            }
            catch { }

            InvalidatePreviousRun();
            WriteStatusFile(new { status = "cancelled", message = "Test run cancelled." });`,
      `        public static object CancelTests(string runId = null)
        {
            var hasActiveRun = File.Exists(TestRequestFile);
            // Read the request file ONCE: the guard and the cancelled payload must agree even if the
            // run completes (and deletes the request file) between the two reads.
            var activeRunId = hasActiveRun ? RequestRunId() : null;
            if (runId != null)
            {
                if (!hasActiveRun)
                    return new
                    {
                        status = "no_active_run",
                        requestedRunId = runId,
                        message = "No test run in progress; nothing was touched."
                    };
                if (activeRunId != runId)
                    return new
                    {
                        status = "unknown_run",
                        requestedRunId = runId,
                        message = "Requested run is not the active run; no cancellation was performed."
                    };
            }

            if (m_ActiveCollector == null && !File.Exists(TestRequestFile) && !File.Exists(TestStatusFile))
                return new { status = "no_tests", message = "No test run in progress." };

            bool wasPlayMode = false;
            var cancelledRunId = activeRunId;
            try
            {
                if (File.Exists(TestRequestFile))
                {
                    var json = File.ReadAllText(TestRequestFile);
                    wasPlayMode = json.Contains("PlayMode");
                }
            }
            catch { }

            InvalidatePreviousRun();
            WriteStatusFile(new { status = "cancelled", runId = cancelledRunId, message = "Test run cancelled." });`,
    ],
];

export function patchPipelineTestRunner(bytes: Buffer): Buffer {
  return applyPatches(bytes, 'PipelineTestRunner.cs', 'requestedRunId', pipelineTestRunnerPatches);
}

export const recompileCommandPatches: Array<[string, string]> = [
    // pending command run id survives the trigger->engine-event handoff in-process
    [
      `        static readonly List<string> s_Errors = new List<string>();`,
      `        static readonly List<string> s_Errors = new List<string>();

        // Run id assigned by the recompile command (patchVersion 3). Engine events
        // propagate it into the terminal payload; engine-spontaneous compiles
        // (no pending id) write runId:null. Never persists across domain reloads —
        // by design: the triggering request cannot survive the reload anyway.
        static string s_PendingRunId;`,
    ],
    [
      `            if (focus)
                s_FocusAction();

            WriteStatus("triggered", false, null);

            // Trigger asset import + compilation.
            AssetDatabase.Refresh();

            if (EditorApplication.isCompiling)
            {
                // compilationStarted has written "compiling"; a domain reload will follow on success.
                return new { status = "compiling", message = "Recompilation started. Poll recompile_status until completed." };
            }

            // Nothing needed recompilation.
            WriteStatus("up_to_date", false, null);
            return new { status = "up_to_date", message = "No scripts needed recompilation." };`,
      `            if (focus)
                s_FocusAction();

            var runId = Guid.NewGuid().ToString("N");
            s_PendingRunId = runId;
            WriteStatus("triggered", runId, false, null);

            // Trigger asset import + compilation.
            AssetDatabase.Refresh();

            if (EditorApplication.isCompiling)
            {
                // compilationStarted has written "compiling"; a domain reload will follow on success.
                return new { status = "compiling", runId = runId, message = "Recompilation started. Poll recompile_status until completed." };
            }

            // Nothing needed recompilation. Terminal state reached without engine events:
            // clear the pending id so a later engine-spontaneous compile is NOT attributed to this run.
            WriteStatus("up_to_date", runId, false, null);
            s_PendingRunId = null;
            return new { status = "up_to_date", runId = runId, message = "No scripts needed recompilation." };`,
    ],
    [
      `        [CliCommand("recompile_status", "Get the status of the last recompile: idle | triggered | compiling | completed | up_to_date.", MainThreadRequired = false, Tags = new[] { "scripts/compile" })]
        public static string RecompileStatus()
        {
            if (File.Exists(StatusFile))
                return File.ReadAllText(StatusFile);
            return "{\\"status\\":\\"idle\\"}";
        }`,
      `        private class StatusEnvelope
        {
            public string runId { get; set; }
        }

        [CliCommand("recompile_status", "Get the status of the last recompile: idle | triggered | compiling | completed | up_to_date; optional run_id for correlated query", MainThreadRequired = false, Tags = new[] { "scripts/compile" })]
        public static string RecompileStatus(
            [CliArg("run_id", "Optional run id from the recompile response: return only that run's terminal payload; unknown_run otherwise (null runId = engine-spontaneous compile)")] string runId = null)
        {
            var requested = string.IsNullOrEmpty(runId) ? null : runId.Trim();
            if (requested == null)
            {
                if (File.Exists(StatusFile))
                    return File.ReadAllText(StatusFile);
                return "{\\"status\\":\\"idle\\"}";
            }

            if (File.Exists(StatusFile))
            {
                string recorded;
                try
                {
                    recorded = JsonConvert.DeserializeObject<StatusEnvelope>(File.ReadAllText(StatusFile))?.runId;
                }
                catch
                {
                    recorded = null;
                }
                if (recorded == requested)
                    return File.ReadAllText(StatusFile);
                return JsonConvert.SerializeObject(new
                {
                    status = "unknown_run",
                    requestedRunId = requested,
                    message = "Recorded compile status belongs to another run (runId mismatch or engine-spontaneous compile); refusing to return it."
                });
            }

            return JsonConvert.SerializeObject(new
            {
                status = "unknown_run",
                requestedRunId = requested,
                message = "No compile status record for the requested run id."
            });
        }`,
    ],
    [
      `        static void OnCompilationStarted(object _)
        {
            s_Errors.Clear();
            WriteStatus("compiling", false, null);
        }`,
      `        static void OnCompilationStarted(object _)
        {
            s_Errors.Clear();
            WriteStatus("compiling", s_PendingRunId, false, null);
        }`,
    ],
    [
      `        static void OnCompilationFinished(object _)
        {
            // Written before the domain reload, so it persists for pollers after the reload.
            WriteStatus("completed", s_Errors.Count > 0, s_Errors.ToArray());
        }`,
      `        static void OnCompilationFinished(object _)
        {
            // Written before the domain reload, so it persists for pollers after the reload.
            WriteStatus("completed", s_PendingRunId, s_Errors.Count > 0, s_Errors.ToArray());
            s_PendingRunId = null;
        }`,
    ],
    [
      `        static void WriteStatus(string status, bool failed, string[] errors)
        {
            try
            {
                var payload = new { status, failed, errors = errors ?? Array.Empty<string>() };
                File.WriteAllText(StatusFile, JsonConvert.SerializeObject(payload));
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Recompile] Failed to write status file: {ex.Message}");
            }
        }`,
      `        static void WriteStatus(string status, string runId, bool failed, string[] errors)
        {
            try
            {
                var payload = new { status, runId, failed, errors = errors ?? Array.Empty<string>() };
                File.WriteAllText(StatusFile, JsonConvert.SerializeObject(payload));
            }
            catch (Exception ex)
            {
                Debug.LogError($"[Recompile] Failed to write status file: {ex.Message}");
            }
        }`,
    ],
];

export function patchRecompileCommand(bytes: Buffer): Buffer {
  return applyPatches(bytes, 'RecompileCommand.cs', 's_PendingRunId', recompileCommandPatches);
}

export const testExecutionResponsePatches: Array<[string, string]> = [
    [
      `        public string StatusPath { get; set; } // For async mode`,
      `        public string StatusPath { get; set; } // For async mode
        public string RunId { get; set; } // Async run correlation id (run_tests --async_tests; patchVersion 3)`,
    ],
];

export function patchTestExecutionResponse(bytes: Buffer): Buffer {
  return applyPatches(bytes, 'TestExecutionResponse.cs', 'RunId { get; set; }', testExecutionResponsePatches);
}
