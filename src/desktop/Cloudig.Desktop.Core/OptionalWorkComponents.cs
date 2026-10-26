using System.Collections.Concurrent;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

/// <summary>Immutable optional PROGRAM files, not a persistent cache. Only the
/// compiled public catalog is downloadable; requests never supply a URL/path.
/// Installed files travel in app; incomplete bytes belong to this run's cache.</summary>
public sealed class OptionalWorkComponents : IAsyncDisposable
{
    public const string Route = "/runtime/optional/";
    private const string Headers = "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n";
    private sealed record Entry(string Component, string File, Uri Url, long Bytes, string Sha256, string Mime);
    private readonly string _app, _staging;
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<string>>> _loads = new(StringComparer.Ordinal);
    private readonly VerifiedDownloadClient _download;
    private readonly CancellationTokenSource _stop = new();
    private bool _closed;

    public OptionalWorkComponents(string app, string cache, HttpClient? http = null, string? catalogJson = null)
    {
        _app = Path.GetFullPath(app);
        _staging = Path.Combine(Path.GetFullPath(cache), "WorkComponents", Guid.NewGuid().ToString("N"));
        _download = new VerifiedDownloadClient(http, PublicComponentUri);
        using var stream = catalogJson is null ? typeof(OptionalWorkComponents).Assembly.GetManifestResourceStream("Cloudig.OptionalWorkComponents.json") : null;
        using var catalog = catalogJson is null ? JsonDocument.Parse(stream ?? throw new InvalidDataException("Missing component catalog.")) : JsonDocument.Parse(catalogJson);
        foreach (var component in catalog.RootElement.GetProperty("components").EnumerateArray())
        {
            if (component.TryGetProperty("delivery", out var delivery) && delivery.GetString() == "bundled") continue;
            var id = component.GetProperty("id").GetString()!;
            foreach (var file in component.GetProperty("files").EnumerateArray())
            {
                var name = file.GetProperty("file").GetString()!;
                if (!PlainSegments(id) || id.Contains('/') || !PlainSegments(name)) throw new InvalidDataException("Invalid component catalog path.");
                var entry = new Entry(id, name, new Uri(file.GetProperty("url").GetString()!), file.GetProperty("bytes").GetInt64(), file.GetProperty("sha256").GetString()!, file.GetProperty("mime").GetString()!);
                if (!PublicComponentUri(entry.Url) || entry.Mime.Contains('\r') || entry.Mime.Contains('\n')) throw new InvalidDataException("Invalid component catalog source.");
                _entries.Add(Route + id + "/" + name, entry);
            }
        }
    }
    private static bool PlainSegments(string value) => value.Length > 0 && value.Split('/').All(part => part is not ("" or "." or "..") && part.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !part.EndsWith('.') && !part.EndsWith(' '));
    internal static bool PublicComponentUri(Uri uri) => uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0 && uri.Host is
        "cdn.jsdelivr.net" or "cdn.tailwindcss.com" or "cdnjs.cloudflare.com" or "raw.githubusercontent.com" or "fonts.gstatic.com" or "www.apache.org" or "tfhub.dev" or "www.kaggle.com" or "storage.googleapis.com";
    public static bool Handles(string address) => Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0 && uri.Host == "cloudig.local" && uri.AbsolutePath.StartsWith(Route, StringComparison.Ordinal);

    public async Task<LocalFileResponse> OpenAsync(string address, string method)
    {
        if (_closed) return new(null, 503, "Component service closed", Headers);
        if (!Handles(address) || !_entries.TryGetValue(Uri.UnescapeDataString(new Uri(address).AbsolutePath), out var entry)) return new(null, 404, "Not Found", Headers);
        if (method is not ("GET" or "HEAD")) return new(null, 405, "Method Not Allowed", Headers);
        var key = new Uri(address).AbsolutePath;
        var load = _loads.GetOrAdd(key, _ => new Lazy<Task<string>>(() => InstallAsync(entry)));
        try
        {
            var target = await load.Value;
            VerifiedDownloadClient.PlainPath(target);
            var headers = Headers + $"Content-Type: {entry.Mime}\r\nContent-Length: {entry.Bytes}\r\n";
            return new(method == "HEAD" ? null : new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete), 200, "OK", headers);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or HttpRequestException or OperationCanceledException or UnauthorizedAccessException)
        {
            _loads.TryRemove(new KeyValuePair<string, Lazy<Task<string>>>(key, load));
            return new(null, 503, "Optional component unavailable", Headers);
        }
    }
    private async Task<string> InstallAsync(Entry entry)
    {
        // This is beside web/engine, not in the user's cache or business records.
        var target = Path.Combine(_app, "optional-components", entry.Component, entry.File.Replace('/', Path.DirectorySeparatorChar));
        var result = await _download.SaveAsync(entry.Url, entry.Bytes, entry.Sha256, Path.GetDirectoryName(target)!, Path.GetFileName(target), null, _stop.Token, _staging);
        return result.Path;
    }
    public async ValueTask DisposeAsync()
    {
        if (_closed) return; _closed = true;
        _stop.Cancel();
        foreach (var task in _loads.Values.Where(item => item.IsValueCreated)) { try { await task.Value; } catch (Exception) { /* cancellation/failure already surfaced to the caller */ } }
        if (Directory.Exists(_staging)) { VerifiedDownloadClient.PlainPath(_staging); Directory.Delete(_staging, recursive: false); }
        _stop.Dispose();
    }
}
