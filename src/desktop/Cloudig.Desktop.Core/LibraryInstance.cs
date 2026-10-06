using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Cloudig.Desktop.Core;

/// <summary>One live desktop per Library, including the interval before its window exists.</summary>
public sealed class LibraryInstance : IDisposable
{
    public const int ActivationTimeoutMilliseconds = 5000;
    private readonly NamedPipeServerStream _server;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _listener;
    private int _disposed;

    private LibraryInstance(NamedPipeServerStream server, Action activate)
    {
        _server = server;
        _listener = Task.Run(() => ListenAsync(activate));
    }

    public static string Endpoint(string libraryRoot)
    {
        var root = ResolveRoot(libraryRoot).ToUpperInvariant();
        var user = WindowsIdentity.GetCurrent().User?.Value ?? throw new IOException("Current Windows user is unavailable.");
        return "Cloudig-Library-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(user + "\n" + root)));
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenDirectory(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint FinalPath(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    internal static string ResolveRoot(string root)
    {
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var tail = new Stack<string>(); var existing = full;
        while (!Directory.Exists(existing))
        {
            tail.Push(Path.GetFileName(existing));
            existing = Path.GetDirectoryName(existing) ?? throw new DirectoryNotFoundException(full);
        }
        using var handle = OpenDirectory(existing, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("Cannot identify the selected Library.", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        var buffer = new StringBuilder(32768); var length = FinalPath(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new IOException("Cannot resolve the selected Library path.");
        var resolved = buffer.ToString();
        if (resolved.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) resolved = @"\\" + resolved[8..];
        else if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved[4..];
        foreach (var leaf in tail) resolved = Path.Combine(resolved, leaf);
        return Path.TrimEndingDirectorySeparator(resolved);
    }

    /// <returns>An owning lease, or null after the existing owner acknowledged activation.</returns>
    public static async Task<LibraryInstance?> AcquireOrActivateAsync(string root, Action activate,
        Action<int>? allowForeground = null, CancellationToken cancellationToken = default)
    {
        var endpoint = Endpoint(root);
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var server = new NamedPipeServerStream(endpoint, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance | PipeOptions.CurrentUserOnly);
                return new LibraryInstance(server, activate);
            }
            catch (IOException) { } // Another owner holds the first pipe instance, not a stale disk lock.
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(Math.Max(1, ActivationTimeoutMilliseconds - (int)elapsed.ElapsedMilliseconds));
            try
            {
                await using var client = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await client.ConnectAsync(250, deadline.Token);
                var pid = new byte[sizeof(int)]; await client.ReadExactlyAsync(pid, deadline.Token);
                allowForeground?.Invoke(BitConverter.ToInt32(pid));
                await client.WriteAsync(new byte[] { 1 }, deadline.Token);
                var acknowledged = new byte[1]; await client.ReadExactlyAsync(acknowledged, deadline.Token);
                if (acknowledged[0] != 1) throw new InvalidDataException("Existing Cloudig instance did not acknowledge activation.");
                return null;
            }
            catch (Exception error) when (error is IOException or TimeoutException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
            {
                // An exiting or failed first launch may release ownership while we connect.
                // Retry acquisition, but never start a second writer merely because it is busy.
                if (elapsed.ElapsedMilliseconds >= ActivationTimeoutMilliseconds)
                    throw new IOException("采云已在启动或关闭，请稍后再试。 / Cloudig is starting or closing. Please try again shortly.", error);
                await Task.Delay(40, cancellationToken);
            }
        }
    }

    private async Task ListenAsync(Action activate)
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try
            {
                await _server.WaitForConnectionAsync(_lifetime.Token);
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                deadline.CancelAfter(ActivationTimeoutMilliseconds);
                await _server.WriteAsync(BitConverter.GetBytes(Environment.ProcessId), deadline.Token);
                var request = new byte[1]; await _server.ReadExactlyAsync(request, deadline.Token);
                if (request[0] != 1) continue;
                activate();
                await _server.WriteAsync(new byte[] { 1 }, deadline.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
            finally
            {
                try { if (!_lifetime.IsCancellationRequested && _server.IsConnected) _server.Disconnect(); }
                catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            }
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _lifetime.Cancel(); _server.Dispose();
        _ = _listener.ContinueWith(_ => _lifetime.Dispose(), TaskScheduler.Default);
    }
}
