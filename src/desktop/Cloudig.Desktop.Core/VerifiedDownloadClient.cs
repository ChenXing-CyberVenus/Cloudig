using System.Net;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public sealed record DownloadProgress(long Bytes, long Total);
public sealed record VerifiedDownloadResult(string Path, bool Existing);

/// <summary>Downloads only caller-validated public objects. Never overwrites a
/// different local file; the temporary sibling belongs to this one request.</summary>
public sealed class VerifiedDownloadClient(HttpClient? http = null)
{
    public const long MaximumBytes = 2L * 1024 * 1024 * 1024;
    public const int BufferBytes = 128 * 1024;
    public const int MaximumRedirects = 5;
    public const int TimeoutMinutes = 30;
    private static readonly HttpClient Default = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private readonly HttpClient _http = http ?? Default;
    public static void PlainPath(string path)
    {
        var cursor = System.IO.Path.GetFullPath(path);
        while (!string.IsNullOrEmpty(cursor)) {
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked download paths are not supported.");
            var parent = System.IO.Path.GetDirectoryName(cursor); if (parent == cursor) break; cursor = parent;
        }
    }
    public static bool PublicDownloadUri(Uri uri) => uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0 &&
        (uri.Host == "chenxing-cybervenus.github.io" || uri.Host == "github.com" || uri.Host.EndsWith(".githubusercontent.com", StringComparison.Ordinal));

    public async Task<VerifiedDownloadResult> SaveAsync(Uri uri, long bytes, string hash, string folder, string filename, Action<DownloadProgress>? progress, CancellationToken cancellationToken, string? stagingFolder = null)
    {
        if (!PublicDownloadUri(uri) || bytes is < 1 or > MaximumBytes || !Regex.IsMatch(hash, "^[a-fA-F0-9]{64}$") || filename != System.IO.Path.GetFileName(filename) || filename.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0 || filename.EndsWith('.') || filename.EndsWith(' ')) throw new InvalidDataException("Invalid download manifest.");
        folder = System.IO.Path.GetFullPath(folder); PlainPath(folder); Directory.CreateDirectory(folder); PlainPath(folder);
        var target = System.IO.Path.Combine(folder, filename); PlainPath(target);
        if (File.Exists(target)) {
            await using var existing = File.OpenRead(target);
            if (existing.Length == bytes && Convert.ToHexString(await SHA256.HashDataAsync(existing, cancellationToken)).Equals(hash, StringComparison.OrdinalIgnoreCase)) { progress?.Invoke(new(bytes, bytes)); return new(target, true); }
            throw new IOException("A different local file already exists. It was not overwritten.");
        }
        var staging = System.IO.Path.GetFullPath(stagingFolder ?? folder); PlainPath(staging); Directory.CreateDirectory(staging); PlainPath(staging);
        var temporary = System.IO.Path.Combine(staging, ".cloudig-download-" + Guid.NewGuid().ToString("N") + ".part");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(TimeSpan.FromMinutes(TimeoutMinutes)); var token = timeout.Token;
        try {
            HttpResponseMessage? response = null;
            for (var redirect = 0; redirect <= MaximumRedirects; redirect++) {
                using var request = new HttpRequestMessage(HttpMethod.Get, uri); request.Headers.UserAgent.ParseAdd("Cloudig/1.0");
                response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308)) break;
                var location = response.Headers.Location; response.Dispose(); response = null;
                if (location is null || redirect == MaximumRedirects) throw new IOException("Download redirect could not be resolved.");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location); if (!PublicDownloadUri(uri)) throw new IOException("Download redirected outside its public delivery hosts.");
            }
            using (response) {
                if (response is null || !response.IsSuccessStatusCode) throw new IOException("The download server is unavailable.");
                if (response.Content.Headers.ContentLength is { } length && length != bytes) throw new InvalidDataException("Download length does not match the manifest.");
                await using var input = await response.Content.ReadAsStreamAsync(token);
                using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); long total = 0; var buffer = new byte[BufferBytes];
                progress?.Invoke(new(0, bytes)); var lastReport = Environment.TickCount64;
                await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferBytes, FileOptions.Asynchronous)) {
                    int count; while ((count = await input.ReadAsync(buffer, token)) > 0) {
                        total += count; if (total > bytes) throw new InvalidDataException("Download exceeded the manifest length.");
                        digest.AppendData(buffer, 0, count); await output.WriteAsync(buffer.AsMemory(0, count), token);
                        if (Environment.TickCount64 - lastReport >= 100) { progress?.Invoke(new(total, bytes)); lastReport = Environment.TickCount64; }
                    }
                    await output.FlushAsync(token); output.Flush(true);
                }
                if (total != bytes || !Convert.ToHexString(digest.GetHashAndReset()).Equals(hash, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Download verification failed; the local file was not installed.");
            }
            token.ThrowIfCancellationRequested(); PlainPath(folder); PlainPath(target); File.Move(temporary, target, false); progress?.Invoke(new(bytes, bytes)); return new(target, false);
        }
        finally {
            if (File.Exists(temporary)) { PlainPath(temporary); File.Delete(temporary); }
            // Keep the single shared staging directory: another download may
            // be awaiting response headers and has not created its part yet.
        }
    }
}
