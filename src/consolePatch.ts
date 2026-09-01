import { CliError } from './errors.js';

/**
 * Replacement body for the upstream Editor console commands.
 *
 * The upstream implementation only reads buffers populated from
 * Application.logMessageReceivedThreaded. That is useful for follow/player
 * scenarios, but it is not a snapshot of the Unity Editor Console: messages
 * emitted before the subscription (notably compiler/importer diagnostics) can
 * be absent. This editor-only command deliberately reflects Unity's internal
 * LogEntries store, matching the semantics agents expect from UnityMCP's
 * read_console tool. Exact-version routing makes this internal API usage
 * fail-closed and testable per supported Editor revision.
 */
const CONSOLE_COMMANDS_BODY_LF = `        [CliCommand("read_console", "Read or clear the current Unity Editor Console (including entries emitted before this command).", Tags = new[] { "observability/console" })]
        public static object ReadConsole(
            [CliArg("action", "Action: get | clear.")] string action = "get",
            [CliArg("types", "Comma-separated entry types: error, warning, log, or all. Defaults to error,warning.")] string types = "error,warning",
            [CliArg("count", "Maximum entries in non-paged mode, capped at 1000.")] int count = 100,
            [CliArg("filterText", "Optional case-insensitive substring filter over the message and stack trace.")] string filterText = null,
            [CliArg("pageSize", "Page size (1-500). Values <= 0 disable paging and use count.")] int pageSize = 0,
            [CliArg("cursor", "Zero-based matching-entry offset used with pageSize.")] int cursor = 0,
            [CliArg("outputFormat", "Entry format: plain | detailed | json (named outputFormat to avoid the Unity CLI global --format option).")] string outputFormat = "detailed",
            [CliArg("includeStacktrace", "Include the stack trace in detailed/json output.")] bool includeStacktrace = true)
        {
            switch ((action ?? "get").Trim().ToLowerInvariant())
            {
                case "clear":
                    return ClearConsole();
                case "get":
                    var result = ReadUnityConsole(types, count, filterText, pageSize, cursor, outputFormat, includeStacktrace);
                    return new
                    {
                        success = true,
                        action = "get",
                        total = result.Total,
                        returned = result.Messages.Count,
                        cursor = result.Cursor,
                        nextCursor = result.NextCursor,
                        hasMore = result.HasMore,
                        messages = result.Messages
                    };
                default:
                    throw new ArgumentException("Unknown action. Expected 'get' or 'clear'.", nameof(action));
            }
        }

        [CliCommand("get_console_logs", "Read the current Unity Editor Console (compatibility alias for read_console).", Tags = new[] { "observability/console" })]
        public static object GetConsoleLogs(
            [CliArg("severity", "Filter: all | log | warning | error.")] string severity = "all",
            [CliArg("limit", "Max entries to return, capped at 1000.")] int limit = 100)
        {
            var requested = string.Equals(severity, "all", StringComparison.OrdinalIgnoreCase)
                ? "all"
                : severity;
            var result = ReadUnityConsole(requested, limit, null, 0, 0, "detailed", true);
            return new
            {
                total = result.Total,
                returned = result.Messages.Count,
                logs = result.Messages
            };
        }

        [CliCommand("clear_console", "Clear the Unity Editor Console and all captured pipeline console buffers.", Tags = new[] { "observability/console" })]
        public static object ClearConsole()
        {
            var unityConsoleCleared = false;
            string unityConsoleError = null;

            try
            {
                var logEntriesType = GetEditorType("UnityEditor.LogEntries");
                GetRequiredMethod(logEntriesType, "Clear").Invoke(null, null);
                unityConsoleCleared = true;
            }
            catch (Exception ex)
            {
                unityConsoleError = UnwrapMessage(ex);
            }

            // These are two independent upstream buffers. Clear both so a
            // subsequent console/get_console_logs call cannot return stale data.
            ConsoleLogBuffer.Clear();
            Unity.Pipeline.Console.ConsoleLogCapture.Buffer.Clear();
            Unity.Pipeline.Console.ConsoleLogCapture.Buffer.Save("Temp/pipeline_console_log.json");

            return new
            {
                success = unityConsoleCleared,
                action = "clear",
                cleared = unityConsoleCleared,
                unityConsoleCleared,
                capturedBuffersCleared = true,
                error = unityConsoleError
            };
        }

        private sealed class ConsoleReadResult
        {
            public int Total { get; set; }
            public List<object> Messages { get; set; }
            public int? Cursor { get; set; }
            public int? NextCursor { get; set; }
            public bool HasMore { get; set; }
        }

        private static ConsoleReadResult ReadUnityConsole(
            string types,
            int count,
            string filterText,
            int pageSize,
            int cursor,
            string format,
            bool includeStacktrace)
        {
            var logEntriesType = GetEditorType("UnityEditor.LogEntries");
            var logEntryType = GetEditorType("UnityEditor.LogEntry");
            var staticFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            var instanceFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            var startGettingEntries = GetRequiredMethod(logEntriesType, "StartGettingEntries");
            var endGettingEntries = GetRequiredMethod(logEntriesType, "EndGettingEntries");
            var getEntry = GetRequiredMethod(logEntriesType, "GetEntryInternal");
            var getEntryCount = logEntriesType.GetMethod("GetEntryCount", staticFlags);
            var setConsoleFlag = GetRequiredMethod(logEntriesType, "SetConsoleFlag");
            var setFilteringText = GetRequiredMethod(logEntriesType, "SetFilteringText");
            var getFilteringText = GetRequiredMethod(logEntriesType, "GetFilteringText");
            var consoleFlags = logEntriesType.GetProperty("consoleFlags", staticFlags);
            if (consoleFlags == null)
                throw new MissingMemberException(logEntriesType.FullName, "consoleFlags");

            var modeField = GetRequiredField(logEntryType, "mode", instanceFlags);
            var messageField = GetRequiredField(logEntryType, "message", instanceFlags);
            var fileField = GetRequiredField(logEntryType, "file", instanceFlags);
            var lineField = GetRequiredField(logEntryType, "line", instanceFlags);
            var callstackStartField = logEntryType.GetField("callstackTextStartUTF16", instanceFlags);

            var requestedTypes = NormalizeTypes(types);
            var normalizedFormat = (format ?? "detailed").Trim().ToLowerInvariant();
            var usePaging = pageSize > 0;
            var resolvedPageSize = Math.Min(Math.Max(pageSize, 1), 500);
            var resolvedCursor = Math.Max(cursor, 0);
            var resolvedCount = Math.Min(Math.Max(count, 1), 1000);
            var messages = new List<object>();
            var totalMatches = 0;
            var originalFlags = (int)consoleFlags.GetValue(null, null);
            var originalFilter = (string)getFilteringText.Invoke(null, null) ?? string.Empty;
            var started = false;

            try
            {
                // StartGettingEntries observes the Console window's severity
                // toggles and search filter. Temporarily make the snapshot
                // independent from UI state, then restore both in finally.
                setConsoleFlag.Invoke(null, new object[] { 1 << 7, true });
                setConsoleFlag.Invoke(null, new object[] { 1 << 8, true });
                setConsoleFlag.Invoke(null, new object[] { 1 << 9, true });
                setFilteringText.Invoke(null, new object[] { string.Empty });

                var totalEntries = (int)startGettingEntries.Invoke(null, null);
                started = true;
                var entry = Activator.CreateInstance(logEntryType);

                for (var i = 0; i < totalEntries; i++)
                {
                    var read = getEntry.Invoke(null, new[] { (object)i, entry });
                    if (read is bool && !(bool)read)
                        continue;

                    var rawMessage = (string)messageField.GetValue(entry) ?? string.Empty;
                    if (rawMessage.Length == 0)
                        continue;

                    var mode = (int)modeField.GetValue(entry);
                    var type = ClassifyType(mode);
                    if (!requestedTypes.Contains(type.ToLowerInvariant()))
                        continue;

                    var callstackStart = callstackStartField == null ? -1 : (int)callstackStartField.GetValue(entry);
                    string message;
                    string stackTrace;
                    SplitMessage(rawMessage, callstackStart, out message, out stackTrace);

                    if (!string.IsNullOrEmpty(filterText)
                        && rawMessage.IndexOf(filterText, StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    var matchingIndex = totalMatches;
                    totalMatches++;
                    var include = usePaging
                        ? matchingIndex >= resolvedCursor && matchingIndex < resolvedCursor + resolvedPageSize
                        : messages.Count < resolvedCount;
                    if (!include)
                        continue;

                    if (normalizedFormat == "plain")
                    {
                        messages.Add(message);
                        continue;
                    }

                    var occurrences = 1;
                    if (getEntryCount != null)
                    {
                        var occurrenceResult = getEntryCount.Invoke(null, new object[] { i });
                        if (occurrenceResult is int)
                            occurrences = (int)occurrenceResult;
                    }

                    messages.Add(new
                    {
                        type,
                        message,
                        file = (string)fileField.GetValue(entry) ?? string.Empty,
                        line = (int)lineField.GetValue(entry),
                        stackTrace = includeStacktrace ? stackTrace : null,
                        occurrences
                    });
                }
            }
            finally
            {
                try
                {
                    if (started)
                        endGettingEntries.Invoke(null, null);
                }
                finally
                {
                    consoleFlags.SetValue(null, originalFlags, null);
                    setFilteringText.Invoke(null, new object[] { originalFilter });
                }
            }

            int? nextCursor = null;
            if (usePaging && resolvedCursor + messages.Count < totalMatches)
                nextCursor = resolvedCursor + messages.Count;

            return new ConsoleReadResult
            {
                Total = totalMatches,
                Messages = messages,
                Cursor = usePaging ? (int?)resolvedCursor : null,
                NextCursor = nextCursor,
                HasMore = usePaging ? nextCursor.HasValue : totalMatches > messages.Count
            };
        }

        private static HashSet<string> NormalizeTypes(string types)
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(types))
            {
                result.Add("error");
                result.Add("warning");
                return result;
            }

            foreach (var part in types.Split(','))
            {
                var normalized = part.Trim().ToLowerInvariant();
                switch (normalized)
                {
                    case "all":
                        result.Clear();
                        result.Add("error");
                        result.Add("warning");
                        result.Add("log");
                        return result;
                    case "warn":
                        result.Add("warning");
                        break;
                    case "exception":
                    case "assert":
                        result.Add("error");
                        break;
                    case "error":
                    case "warning":
                    case "log":
                        result.Add(normalized);
                        break;
                }
            }

            if (result.Count == 0)
            {
                result.Add("error");
                result.Add("warning");
            }
            return result;
        }

        private static string ClassifyType(int mode)
        {
            const int errorMask =
                (1 << 0) | (1 << 1) | (1 << 4) | (1 << 6) | (1 << 8)
                | (1 << 11) | (1 << 17) | (1 << 20) | (1 << 21) | (1 << 22);
            const int warningMask = (1 << 7) | (1 << 9) | (1 << 12);
            if ((mode & errorMask) != 0)
                return "Error";
            if ((mode & warningMask) != 0)
                return "Warning";
            return "Log";
        }

        private static void SplitMessage(string raw, int callstackStart, out string message, out string stackTrace)
        {
            if (callstackStart > 0 && callstackStart < raw.Length)
            {
                message = raw.Substring(0, callstackStart).TrimEnd('\\r', '\\n');
                stackTrace = raw.Substring(callstackStart).TrimStart('\\r', '\\n');
                return;
            }

            message = raw.TrimEnd('\\r', '\\n');
            stackTrace = string.Empty;
        }

        private static Type GetEditorType(string name)
        {
            var type = typeof(UnityEditor.EditorApplication).Assembly.GetType(name);
            if (type == null)
                throw new TypeLoadException("Could not find internal Unity Editor type: " + name);
            return type;
        }

        private static MethodInfo GetRequiredMethod(Type type, string name)
        {
            var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            var method = type.GetMethod(name, flags);
            if (method == null)
                throw new MissingMethodException(type.FullName, name);
            return method;
        }

        private static FieldInfo GetRequiredField(Type type, string name, BindingFlags flags)
        {
            var field = type.GetField(name, flags);
            if (field == null)
                throw new MissingFieldException(type.FullName, name);
            return field;
        }

        private static string UnwrapMessage(Exception exception)
        {
            var target = exception as TargetInvocationException;
            return target != null && target.InnerException != null
                ? target.InnerException.Message
                : exception.Message;
        }
`;

function normalizeCrlf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
}

/** Replace the callback-buffer console commands with an Editor LogEntries snapshot reader. */
export function patchConsoleCommands(bytes: Buffer): Buffer {
  const source = bytes.toString('utf8');
  if (source.includes('[CliCommand("read_console"')) {
    return normalizeCrlf(Buffer.from(source, 'utf8'));
  }

  const startMarker = '        [CliCommand("get_console_logs"';
  const normalized = source.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(startMarker);
  const classClose = normalized.lastIndexOf('    }\n}');
  if (start < 0 || classClose < start) {
    throw new CliError('ConsoleCommands.cs 缺少 get_console_logs/class 闭合锚点');
  }

  const patched = normalized.slice(0, start) + CONSOLE_COMMANDS_BODY_LF + normalized.slice(classClose);
  return normalizeCrlf(Buffer.from(patched, 'utf8'));
}
