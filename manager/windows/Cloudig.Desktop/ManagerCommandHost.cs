using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Cloudig.Desktop;

internal sealed class ManagerCommandException : InvalidOperationException
{
    public ManagerCommandException(string code, string message, string kind = "", bool retryable = false)
        : base(message)
    {
        Code = string.IsNullOrWhiteSpace(code) ? "manager_command_failed" : code;
        Kind = kind;
        Retryable = retryable;
    }

    public string Code { get; }
    public string Kind { get; }
    public bool Retryable { get; }
}

internal sealed class ManagerCommandHost
{
    private sealed class StreamingProcessState
    {
        private int _checkpointCommitted;

        public StreamingProcessState(Process process) => Process = process;
        public Process Process { get; }
        public bool CheckpointCommitted => Volatile.Read(ref _checkpointCommitted) != 0;
        public void CommitCheckpoint() => Volatile.Write(ref _checkpointCommitted, 1);
    }

    private readonly AppPaths _paths;
    private readonly ConcurrentDictionary<int, StreamingProcessState> _streamingProcesses = new();

    public ManagerCommandHost(AppPaths paths)
    {
        _paths = paths;
    }

    public async Task<JsonElement> RunAsync(JsonElement request, CancellationToken cancellationToken = default)
    {
        using var process = StartProcess(eventStream: false);

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.StandardInput.WriteAsync(request.GetRawText().AsMemory(), cancellationToken);
        await process.StandardInput.FlushAsync(cancellationToken);
        process.StandardInput.Close();
        await process.WaitForExitAsync(cancellationToken);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (string.IsNullOrWhiteSpace(stdout))
        {
            throw new InvalidOperationException(FirstLine(stderr) ?? $"Cloudig parser service exited with code {process.ExitCode}.");
        }

        using var document = JsonDocument.Parse(stdout, new JsonDocumentOptions { MaxDepth = 64 });
        var root = document.RootElement;
        if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind is not JsonValueKind.True)
        {
            var message = root.TryGetProperty("error", out var error)
                && error.TryGetProperty("message", out var errorMessage)
                    ? errorMessage.GetString()
                    : FirstLine(stderr);
            throw new InvalidOperationException(message ?? "Cloudig parser service reported an unknown error.");
        }

        if (!root.TryGetProperty("result", out var result))
        {
            throw new InvalidOperationException("Cloudig parser service returned no result.");
        }
        return result.Clone();
    }

    public async Task<JsonElement> RunStreamingAsync(
        JsonElement request,
        Func<JsonElement, Task> onEvent,
        CancellationToken cancellationToken = default,
        Func<JsonElement, Task<bool>>? onCheckpoint = null)
    {
        ArgumentNullException.ThrowIfNull(onEvent);
        using var process = StartProcess(eventStream: true);
        var processState = new StreamingProcessState(process);
        _streamingProcesses[process.Id] = processState;
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteLineAsync(request.GetRawText().AsMemory(), CancellationToken.None);
        await process.StandardInput.FlushAsync(CancellationToken.None);

        var cancellationSent = 0;
        using var registration = cancellationToken.Register(() =>
        {
            if (processState.CheckpointCommitted) return;
            if (Interlocked.Exchange(ref cancellationSent, 1) != 0) return;
            try
            {
                process.StandardInput.WriteLine("{\"type\":\"cancel\"}");
                process.StandardInput.Flush();
            }
            catch
            {
                // The exact child may already have returned between the user click and this callback.
            }
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5));
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Cooperative cancellation normally exits first; the watchdog is only a bounded fallback.
                }
            });
        });

        JsonElement? result = null;
        ManagerCommandException? failure = null;
        try
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 64 });
                var root = document.RootElement;
                var type = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : string.Empty;
                if (type is "started" or "progress")
                {
                    await onEvent(root.Clone());
                    continue;
                }
                if (type == "checkpoint")
                {
                    await onEvent(root.Clone());
                    if (onCheckpoint is null || !await onCheckpoint(root.Clone()))
                    {
                        throw new InvalidOperationException("Cloudig desktop host did not commit the library move checkpoint.");
                    }
                    processState.CommitCheckpoint();
                    await process.StandardInput.WriteLineAsync("{\"type\":\"commit\"}".AsMemory(), CancellationToken.None);
                    await process.StandardInput.FlushAsync(CancellationToken.None);
                    continue;
                }
                if (type == "result" && root.TryGetProperty("result", out var resultValue))
                {
                    result = resultValue.Clone();
                    break;
                }
                if (type == "error" && root.TryGetProperty("error", out var errorValue))
                {
                    failure = new ManagerCommandException(
                        OptionalString(errorValue, "code") ?? "manager_command_failed",
                        OptionalString(errorValue, "message") ?? "Cloudig parser service reported an unknown error.",
                        OptionalString(errorValue, "kind") ?? string.Empty,
                        errorValue.TryGetProperty("retryable", out var retryable) && retryable.ValueKind is JsonValueKind.True);
                    break;
                }
            }
        }
        finally
        {
            try
            {
                try { process.StandardInput.Close(); } catch { }
                await process.WaitForExitAsync();
            }
            finally
            {
                _streamingProcesses.TryRemove(process.Id, out _);
            }
        }

        var stderr = await stderrTask;
        if (failure is not null) throw failure;
        if (result is not null) return result.Value;
        if (cancellationToken.IsCancellationRequested)
        {
            throw new ManagerCommandException("ABORT_ERR", "Cloudig operation was cancelled", retryable: true);
        }
        throw new InvalidOperationException(FirstLine(stderr) ?? $"Cloudig parser service exited with code {process.ExitCode} without a result event.");
    }

    public void StopStreamingProcesses()
    {
        foreach (var state in _streamingProcesses.Values)
        {
            var process = state.Process;
            try
            {
                if (process.HasExited) continue;
                if (state.CheckpointCommitted)
                {
                    // The verified target is already the persisted current library.
                    // Killing now could interrupt old-root cleanup; the pending journal
                    // lets the next launch finish if this exact child outlives the window.
                    continue;
                }
                try
                {
                    process.StandardInput.WriteLine("{\"type\":\"cancel\"}");
                    process.StandardInput.Flush();
                }
                catch { }
                if (!process.WaitForExit(1_500)) process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Only the exact child processes created by this host are considered here.
            }
        }
    }

    private Process StartProcess(bool eventStream)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _paths.NodeExecutable,
            WorkingDirectory = _paths.ProjectRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false)
        };
        startInfo.ArgumentList.Add(_paths.CommandScript);
        if (eventStream) startInfo.ArgumentList.Add("--events");

        var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Cloudig could not start its local parser service.");
            return process;
        }
        catch (Exception error)
        {
            process.Dispose();
            throw new InvalidOperationException("Cloudig could not start its bundled Node.js parser runtime.", error);
        }
    }

    private static string? OptionalString(JsonElement value, string property) =>
        value.TryGetProperty(property, out var item) && item.ValueKind is JsonValueKind.String
            ? item.GetString()
            : null;

    private static string? FirstLine(string value) => value
        .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .FirstOrDefault();
}
