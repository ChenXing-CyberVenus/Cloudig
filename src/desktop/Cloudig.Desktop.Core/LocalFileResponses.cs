using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public sealed record LocalFileResponse(Stream? Content, int Status, string Reason, string Headers);

// WebView's folder mapping stops at MAX_PATH. Managed file streams keep the
// same opaque runtime URLs without moving cache outside the user's Library.
public sealed partial class LocalFileResponses(string applicationRoot, string? runtimeRoot) : IDisposable
{
    // These four origins are always fulfilled/denied by this responder, never
    // remote websites. Resolve them locally to avoid WebView's ~2 s DNS wait.
    // This is scoped to this browser environment, not hosts/system DNS/proxy.
    public const string BrowserArguments = "--host-resolver-rules=\"MAP cloudig.local 127.0.0.1, MAP cloudig-runtime.local 127.0.0.1, MAP cloudig-work.invalid 127.0.0.1, MAP cloudig-map.local 127.0.0.1\"";
    private readonly string _applicationRoot = Path.GetFullPath(applicationRoot);
    private readonly string? _runtimeRoot = runtimeRoot is null ? null : Path.GetFullPath(runtimeRoot);
    private readonly ConcurrentDictionary<ReadLease, byte> _open = new();
    private bool _disposed;
    [GeneratedRegex(@"^/v_[A-Za-z0-9_-]{43}/(?:pages/p_[A-Za-z0-9_-]{43}\.json|assets/r_[A-Za-z0-9_-]{43}\.[a-z0-9]+)$", RegexOptions.CultureInvariant)]
    private static partial Regex AllowedPath();
    [GeneratedRegex(@"(?<prefix>\b(?:href|src)\s*=\s*[""'])(?<path>/[^""'?]+\.(?:css|js|mjs))(?<suffix>[""'])", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex LocalAssetReference();
    private const string DenyHeaders = "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n";

    public LocalFileResponse Open(string address, string method)
    {
        if (_disposed || !Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Host is not ("cloudig-runtime.local" or "cloudig.local" or "cloudig-work.invalid" or "cloudig-map.local"))
            return new(null, 403, "Forbidden", DenyHeaders);
        var runtime = uri.Host == "cloudig-runtime.local";
        var work = uri.Host == "cloudig-work.invalid";
        var map = uri.Host == "cloudig-map.local";
        if (work && uri.AbsolutePath is not ("/runtime/interactive-frame.html" or "/runtime/interactive-frame.js")) return new(null, 403, "Forbidden", DenyHeaders);
        if (map && uri.AbsolutePath is not ("/runtime/map-frame.html" or "/runtime/map-frame.js" or "/runtime/map-frame.css" or "/runtime/map-worker.js")) return new(null, 403, "Forbidden", DenyHeaders);
        if (runtime && (_runtimeRoot is null || !AllowedPath().IsMatch(uri.AbsolutePath))) return new(null, 403, "Forbidden", DenyHeaders);
        var segments = uri.AbsolutePath[1..].Split('/').Select(Uri.UnescapeDataString).ToArray();
        if (segments.Any(value => value is "" or "." or ".." || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)) return new(null, 403, "Forbidden", DenyHeaders);
        // The application origin is the installed program itself. Keeping a
        // one-hour browser cache here makes a portable test copy appear to
        // ignore a freshly rebuilt Reader bundle when it reuses the same
        // WebView2 profile. Runtime frames may keep their own policy, but the
        // local shell must always observe the bytes on disk.
        var baseHeaders = runtime
            ? DenyHeaders + "Access-Control-Allow-Origin: https://cloudig.local\r\n"
            : uri.Host == "cloudig.local"
                ? DenyHeaders
                : "Cache-Control: private, max-age=3600\r\nX-Content-Type-Options: nosniff\r\n";
        if (work && uri.AbsolutePath == "/runtime/interactive-frame.html" || map && uri.AbsolutePath == "/runtime/map-frame.html") baseHeaders += "Content-Security-Policy: sandbox allow-scripts allow-same-origin\r\n";
        if (method is not ("GET" or "HEAD")) return new(null, 405, "Method Not Allowed", baseHeaders + "Allow: GET, HEAD\r\n");
        try
        {
            var file = runtime ? _runtimeRoot! : _applicationRoot;
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return new(null, 403, "Forbidden", DenyHeaders);
            foreach (var segment in segments)
            {
                file = Path.Combine(file, segment);
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) return new(null, 403, "Forbidden", DenyHeaders);
            }
            Stream input;
            if (uri.Host == "cloudig.local" && uri.AbsolutePath.Equals("/index.html", StringComparison.OrdinalIgnoreCase))
            {
                // A previously open WebView2 profile may still hold the old
                // one-hour CSS/JS entries. The shell URL itself is stamped by
                // MainWindow; stamp every local stylesheet/module reference
                // in that fresh index too, so a rebuilt portable copy cannot
                // silently reuse the old renderer bundle.
                var html = File.ReadAllText(file, Encoding.UTF8);
                var assetQuery = string.IsNullOrWhiteSpace(uri.Query)
                    ? $"cloudig-build={File.GetLastWriteTimeUtc(file).Ticks.ToString(CultureInfo.InvariantCulture)}"
                    : uri.Query[1..];
                html = LocalAssetReference().Replace(html, match => $"{match.Groups["prefix"].Value}{match.Groups["path"].Value}?{assetQuery}{match.Groups["suffix"].Value}");
                input = new MemoryStream(Encoding.UTF8.GetBytes(html), writable: false);
            }
            else
            {
                input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 65536, FileOptions.SequentialScan);
            }
            var headers = baseHeaders + $"Content-Type: {Mime(Path.GetExtension(file).ToLowerInvariant())}\r\nContent-Length: {input.Length}\r\n";
            if (method == "HEAD") { input.Dispose(); return new(null, 200, "OK", headers); }
            var lease = new ReadLease(input, value => _open.TryRemove(value, out _));
            _open.TryAdd(lease, 0);
            return new(lease, 200, "OK", headers);
        }
        catch (FileNotFoundException) { return new(null, 404, "Not Found", baseHeaders); }
        catch (DirectoryNotFoundException) { return new(null, 404, "Not Found", baseHeaders); }
        catch (UnauthorizedAccessException) { return new(null, 403, "Forbidden", baseHeaders); }
        catch (IOException) { return new(null, 404, "Not Found", baseHeaders); }
    }
    private static string Mime(string extension) => extension switch
    {
        ".json" => "application/json; charset=utf-8", ".svg" => "image/svg+xml", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif", ".webp" => "image/webp", ".avif" => "image/avif", ".bmp" => "image/bmp", ".pdf" => "application/pdf", ".txt" => "text/plain; charset=utf-8",
        ".mp3" => "audio/mpeg", ".m4a" => "audio/mp4", ".wav" => "audio/wav", ".flac" => "audio/flac", ".ogg" or ".oga" or ".opus" => "audio/ogg",
        ".mp4" or ".m4v" => "video/mp4", ".webm" => "video/webm", ".weba" => "audio/webm", ".ogv" => "video/ogg", ".vtt" => "text/vtt; charset=utf-8",
        ".html" => "text/html; charset=utf-8", ".css" => "text/css; charset=utf-8", ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".woff" => "font/woff", ".woff2" => "font/woff2", ".ttf" => "font/ttf", ".otf" => "font/otf", ".ico" => "image/x-icon", ".wasm" => "application/wasm", _ => "application/octet-stream"
    };
    public void Dispose() { _disposed = true; foreach (var lease in _open.Keys) lease.Dispose(); _open.Clear(); }

    private sealed class ReadLease : Stream
    {
        private Stream? _input;
        private readonly long _length;
        private long _position;
        private readonly Action<ReadLease> _release;
        public ReadLease(Stream input, Action<ReadLease> release) { _input = input; _length = input.Length; _release = release; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _length;
        public override long Position { get => _position; set => throw new NotSupportedException(); }
        private int Complete(int count) { _position += count; if (_position >= _length) Dispose(); return count; }
        public override int Read(byte[] buffer, int offset, int count)
        { try { return Complete(_input?.Read(buffer, offset, count) ?? 0); } catch { Dispose(); throw; } }
        public override int Read(Span<byte> buffer)
        { try { return Complete(_input?.Read(buffer) ?? 0); } catch { Dispose(); throw; } }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { try { var input = _input; return Complete(input is null ? 0 : await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)); } catch { Dispose(); throw; } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        { if (disposing) { Interlocked.Exchange(ref _input, null)?.Dispose(); _release(this); } base.Dispose(disposing); }
    }
}
