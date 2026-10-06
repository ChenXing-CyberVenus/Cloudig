using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

public sealed class EngineRemoteException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

public sealed class EngineJsonlClient : IAsyncDisposable
{
    public const string Protocol = "cloudig/engine-ipc/1.0.0";
    public const int MaximumConcurrentCommands = 4;
    private const int MaximumLineBytes = 1_048_576;
    private readonly Process _process;
    private readonly NativeFileMoves _fileMoves;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly SemaphoreSlim _commandSlots = new(MaximumConcurrentCommands, MaximumConcurrentCommands);
    private readonly ConcurrentDictionary<string, byte> _slotOwners = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Action<JsonElement>> _eventHandlers = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _reader;
    private readonly Task _stderr;
    private EngineRemoteException? _transportFailure;
    private int _disposed;

    public event EventHandler<JsonElement>? EventReceived;

    private EngineJsonlClient(Process process, NativeFileMoves fileMoves)
    {
        _process = process;
        _fileMoves = fileMoves;
        _reader = ReadResponsesAsync(_lifetime.Token);
        _stderr = DrainStandardErrorAsync(_lifetime.Token);
    }

    public int ProcessId => _process.Id;
    public string RuntimeRoot { get; private set; } = string.Empty;

    public static async Task<EngineJsonlClient> StartAsync(
        string nodeExecutable,
        string engineScript,
        string libraryRoot,
        string cacheRoot,
        CancellationToken cancellationToken = default)
    {
        if (!Path.IsPathFullyQualified(nodeExecutable) || !File.Exists(nodeExecutable)) throw new FileNotFoundException("Bundled Node runtime is missing.");
        if (!Path.IsPathFullyQualified(engineScript) || !File.Exists(engineScript)) throw new FileNotFoundException("Bundled Engine is missing.");
        if (!Path.IsPathFullyQualified(libraryRoot) || !Directory.Exists(libraryRoot)) throw new DirectoryNotFoundException("Selected Library is missing.");
        var start = new ProcessStartInfo
        {
            FileName = nodeExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            StandardOutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            StandardErrorEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            WorkingDirectory = Path.GetDirectoryName(engineScript)!
        };
        start.ArgumentList.Add(engineScript);
        start.ArgumentList.Add("--library-root");
        start.ArgumentList.Add(libraryRoot);
        start.ArgumentList.Add("--cache-root");
        if (!Path.IsPathFullyQualified(cacheRoot)) throw new ArgumentException("Cache root must be explicit and absolute.", nameof(cacheRoot));
        start.ArgumentList.Add(Path.GetFullPath(cacheRoot));
        start.Environment["NODE_OPTIONS"] = string.Empty;
        var fileMoves = new NativeFileMoves(libraryRoot, cacheRoot);
        start.Environment["CLOUDIG_FILE_MOVES_PIPE"] = fileMoves.Endpoint;
        // FAT-family file IDs can change on rename. Recovery must compare content
        // there, rather than confusing a successful relocation with replacement.
        start.Environment["CLOUDIG_PORTABLE_FILE_IDENTITIES"] = new DriveInfo(Path.GetPathRoot(libraryRoot)!).DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) ? "0" : "1";
        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        try { if (!process.Start()) throw new InvalidOperationException("Bundled Engine could not start."); }
        catch { await fileMoves.DisposeAsync(); process.Dispose(); throw; }
        var client = new EngineJsonlClient(process, fileMoves);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var handshake = await client.SendAsync("engine.handshake", EmptyObject(), timeout.Token);
            if (!handshake.TryGetProperty("protocol", out var protocol) || protocol.GetString() != Protocol) throw new InvalidDataException("Engine handshake protocol is invalid.");
            var storage = await client.SendAsync("engine.storage", EmptyObject(), timeout.Token);
            client.RuntimeRoot = storage.GetProperty("runtime_root").GetString() ?? throw new InvalidDataException("Engine runtime root is missing.");
            var expectedCache = Path.GetFullPath(cacheRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!Path.IsPathFullyQualified(client.RuntimeRoot) || !client.RuntimeRoot.StartsWith(expectedCache, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Engine runtime escaped the selected cache root.");
            return client;
        }
        catch
        {
            await client.DisposeAsync();
            throw;
        }
    }

    public async Task<JsonElement> SendAsync(string command, JsonElement payload, CancellationToken cancellationToken = default)
    {
        return await SendCoreAsync(command, payload, null, cancellationToken);
    }

    public async Task<JsonElement> SendWithEventsAsync(
        string command,
        JsonElement payload,
        Action<JsonElement> onEvent,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(onEvent);
        return await SendCoreAsync(command, payload, onEvent, cancellationToken);
    }

    private async Task<JsonElement> SendCoreAsync(
        string command,
        JsonElement payload,
        Action<JsonElement>? onEvent,
        CancellationToken cancellationToken)
    {
        ThrowIfUnavailable();
        using var queuedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        var consumesSlot = command is not ("engine.handshake" or "engine.cancel" or "engine.shutdown");
        try
        {
            if (consumesSlot) await _commandSlots.WaitAsync(queuedCancellation.Token);
        }
        catch (OperationCanceledException) { ThrowIfUnavailable(); throw; }
        try { ThrowIfUnavailable(); }
        catch
        {
            if (consumesSlot) _commandSlots.Release();
            throw;
        }
        var request = NewRequestId();
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(request, completion))
        {
            if (consumesSlot) _commandSlots.Release();
            throw new InvalidOperationException("Engine request ID collision.");
        }
        if (consumesSlot) _slotOwners.TryAdd(request, 0);
        if (onEvent is not null && !_eventHandlers.TryAdd(request, onEvent))
        {
            _pending.TryRemove(request, out _);
            ReleaseCommandSlot(request);
            throw new InvalidOperationException("Engine event handler collision.");
        }
        Task? dispatch = null;
        try
        {
            dispatch = WriteAsync(new { protocol = Protocol, kind = "request", request, command, payload }, cancellationToken);
            await dispatch.WaitAsync(cancellationToken);
            return await completion.Task.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested && dispatch is not null)
        {
            // The caller leaves immediately. Finish any started JSON frame
            // before sending its cancellation, retaining the slot until reply.
            _ = CancelAfterDispatchAsync(dispatch, request);
            throw;
        }
        catch
        {
            _pending.TryRemove(request, out _);
            ReleaseCommandSlot(request);
            ThrowIfUnavailable();
            throw;
        }
        finally
        {
            _eventHandlers.TryRemove(request, out _);
        }
    }

    private void ReleaseCommandSlot(string request)
    {
        if (_slotOwners.TryRemove(request, out _)) _commandSlots.Release();
    }

    private async Task CancelAfterDispatchAsync(Task dispatch, string request)
    {
        try { await dispatch; await SendCancelAsync(request); }
        catch
        {
            // Cancellation before the write gate never sent this request.
            // A failed in-flight write retires the transport separately.
            _pending.TryRemove(request, out _);
            ReleaseCommandSlot(request);
        }
    }

    private async Task SendCancelAsync(string target)
    {
        try
        {
            await WriteAsync(new
            {
                protocol = Protocol,
                kind = "request",
                request = NewRequestId(),
                command = "engine.cancel",
                payload = new { target }
            }, _lifetime.Token);
        }
        catch
        {
            // A closing transport needs no second cancellation failure.
        }
    }

    private async Task WriteAsync<T>(T value, CancellationToken cancellationToken, bool shutdown = false)
    {
        var json = JsonSerializer.Serialize(value);
        if (Encoding.UTF8.GetByteCount(json) + 1 > MaximumLineBytes) throw new InvalidDataException("Engine request exceeds its bound.");
        using var queued = shutdown ? null : CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        await _writeGate.WaitAsync(queued?.Token ?? cancellationToken);
        try
        {
            if (!shutdown) ThrowIfUnavailable();
            var frameCancellation = shutdown ? cancellationToken : _lifetime.Token;
            await _process.StandardInput.WriteAsync((json + "\n").AsMemory(), frameCancellation);
            await _process.StandardInput.FlushAsync(frameCancellation);
        }
        catch (Exception error) when (!shutdown && error is IOException)
        {
            FailTransport(error);
            throw _transportFailure!;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private async Task ReadResponsesAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (await _process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
            {
                if (Encoding.UTF8.GetByteCount(line) > MaximumLineBytes) throw new InvalidDataException("Engine response exceeds its bound.");
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 32 });
                var root = document.RootElement;
                if (!root.TryGetProperty("protocol", out var protocol) || protocol.GetString() != Protocol) throw new InvalidDataException("Engine response protocol is invalid.");
                var kind = root.GetProperty("kind").GetString();
                if (kind == "event")
                {
                    if (root.TryGetProperty("request", out var eventRequest)
                        && eventRequest.GetString() is { } eventRequestId
                        && _eventHandlers.TryGetValue(eventRequestId, out var handler)
                        && root.TryGetProperty("event", out var eventPayload))
                    {
                        handler(eventPayload.Clone());
                    }
                    EventReceived?.Invoke(this, root.Clone());
                    continue;
                }
                if (kind == "fatal") throw RemoteError(root.GetProperty("error"));
                if (kind != "response" || !root.TryGetProperty("request", out var requestValue)) throw new InvalidDataException("Engine response envelope is invalid.");
                var request = requestValue.GetString();
                if (request is null || !_pending.ContainsKey(request)) continue;
                // Decode before removing the waiter. An invalid result must
                // fail this request too, not strand it outside FailPending.
                var ok = root.GetProperty("ok").GetBoolean();
                var result = ok ? root.GetProperty("result").Clone() : default;
                var error = ok ? null : RemoteError(root.GetProperty("error"));
                if (!_pending.TryRemove(request, out var completion)) continue;
                ReleaseCommandSlot(request);
                if (ok) completion.TrySetResult(result);
                else completion.TrySetException(error!);
            }
            if (!_process.HasExited) throw new EndOfStreamException("Engine response stream closed unexpectedly.");
            FailTransport(new InvalidOperationException("Engine exited before completing pending requests."));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            FailPending(_transportFailure is { } failure ? failure : new OperationCanceledException("Engine client closed."));
        }
        catch (Exception error)
        {
            FailTransport(error);
        }
    }

    private async Task DrainStandardErrorAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (await _process.StandardError.ReadLineAsync(cancellationToken) is not null) { }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private void FailPending(Exception error)
    {
        foreach (var pair in _pending)
        {
            if (_pending.TryRemove(pair.Key, out var completion))
            {
                ReleaseCommandSlot(pair.Key);
                completion.TrySetException(error);
            }
        }
    }

    private void ThrowIfUnavailable()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (Volatile.Read(ref _transportFailure) is { } error) throw error;
    }

    private void FailTransport(Exception cause)
    {
        var error = cause as EngineRemoteException ?? new EngineRemoteException("CLOUDIG_ENGINE_UNAVAILABLE",
            "The local Engine connection failed. Restart Cloudig to continue.", cause);
        Interlocked.CompareExchange(ref _transportFailure, error, null);
        // Also release commands queued before the failure. New registrations
        // recheck terminal state at the write gate, closing the remaining race.
        _lifetime.Cancel();
        FailPending(_transportFailure!);
    }

    private static EngineRemoteException RemoteError(JsonElement value)
    {
        var code = value.TryGetProperty("code", out var codeValue) ? codeValue.GetString() : null;
        var message = value.TryGetProperty("message", out var messageValue) ? messageValue.GetString() : null;
        return new EngineRemoteException(code ?? "CLOUDIG_ENGINE_FAILED", message ?? "Engine command failed.");
    }

    private static JsonElement EmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static string NewRequestId()
    {
        return $"q_{Convert.ToBase64String(Guid.NewGuid().ToByteArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_')}";
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        if (!_process.HasExited)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await WriteAsync(new { protocol = Protocol, kind = "request", request = NewRequestId(), command = "engine.shutdown", payload = new { } }, timeout.Token, shutdown: true);
                await _process.WaitForExitAsync(timeout.Token);
            }
            catch
            {
                if (!_process.HasExited) _process.Kill(entireProcessTree: false);
                await _process.WaitForExitAsync();
            }
        }
        _lifetime.Cancel();
        try { await Task.WhenAll(_reader, _stderr); } catch { }
        FailPending(new ObjectDisposedException(nameof(EngineJsonlClient)));
        await _writeGate.WaitAsync();
        _writeGate.Release();
        _writeGate.Dispose();
        _lifetime.Dispose();
        _process.Dispose();
        await _fileMoves.DisposeAsync();
    }
}
