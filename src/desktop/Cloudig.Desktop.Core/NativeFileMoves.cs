using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

/// <summary>Engine-only, root-confined access to Windows same-volume no-replace rename.</summary>
public sealed class NativeFileMoves : IAsyncDisposable
{
    public const int MaximumRequestBytes = 32768;
    public const int RequestTimeoutMilliseconds = 10000;
    private readonly string[] _roots;
    private readonly NamedPipeServerStream _server;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _listener;
    public string Endpoint { get; } = "Cloudig-FileMoves-" + Guid.NewGuid().ToString("N");
    public NativeFileMoves(params string[] roots)
    {
        _roots = roots.Select(LibraryInstance.ResolveRoot).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        _server = new NamedPipeServerStream(Endpoint, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance | PipeOptions.CurrentUserOnly);
        _listener = Task.Run(ListenAsync);
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string source, string target, uint flags);

    internal static void MoveNoReplace(string source, string target)
    {
        // Neither REPLACE_EXISTING nor COPY_ALLOWED: no overwrite, no partial cross-volume copy.
        if (!MoveFileEx(Extended(source), Extended(target), 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static string Extended(string value) => value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value
        : value.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + value[2..] : @"\\?\" + value;

    private string Checked(string value)
    {
        if (!Path.IsPathFullyQualified(value)) throw new ArgumentException("File move paths must be absolute.");
        var full = Path.GetFullPath(value);
        var root = _roots.FirstOrDefault(root => full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            ?? throw new ArgumentException("File move escaped the active Library/cache.");
        for (var current = full; current is not null; current = Path.GetDirectoryName(current))
        {
            try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("File move crosses a reparse point."); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            if (current.Equals(root, StringComparison.OrdinalIgnoreCase)) break;
        }
        return full;
    }

    private async Task ListenAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try
            {
                await _server.WaitForConnectionAsync(_lifetime.Token);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                timeout.CancelAfter(RequestTimeoutMilliseconds);
                var header = new byte[4]; await _server.ReadExactlyAsync(header, timeout.Token);
                var size = BitConverter.ToInt32(header);
                if (size is < 1 or > MaximumRequestBytes) throw new InvalidDataException("Native move request exceeds its bound.");
                var bytes = new byte[size]; await _server.ReadExactlyAsync(bytes, timeout.Token);
                string reply;
                try
                {
                    using var request = JsonDocument.Parse(bytes);
                    var value = request.RootElement;
                    if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != 2) throw new ArgumentException("Invalid native move request.");
                    var source = Checked(value[0].GetString()!);
                    var target = Checked(value[1].GetString()!);
                    MoveNoReplace(source, target);
                    reply = "{\"ok\":true}";
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or JsonException or Win32Exception)
                {
                    var native = error is Win32Exception windows ? windows.NativeErrorCode : 0;
                    var code = native switch { 80 or 183 => "EEXIST", 2 or 3 => "ENOENT", 17 => "EXDEV", 5 => "EACCES", _ => "EIO" };
                    reply = JsonSerializer.Serialize(new { ok = false, code, message = error.Message });
                }
                await _server.WriteAsync(Encoding.UTF8.GetBytes(reply + "\n"), timeout.Token);
                await _server.FlushAsync(timeout.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException or InvalidDataException) { }
            finally {
                try { if (!_lifetime.IsCancellationRequested && _server.IsConnected) _server.Disconnect(); }
                catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel(); _server.Dispose();
        await _listener; _lifetime.Dispose();
    }
}
