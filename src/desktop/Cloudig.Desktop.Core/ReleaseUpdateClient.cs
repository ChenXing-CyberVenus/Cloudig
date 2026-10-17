using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public sealed record ReleaseInstaller(string Version, string Url, string Name, long Bytes, string Sha256);
public sealed record ReleaseUpdateResult(string Status, string? CurrentVersion, string? LatestVersion = null, ReleaseInstaller? Installer = null);

/// <summary>Read-only public-release lookup. Installation remains an explicit user action.</summary>
public sealed class ReleaseUpdateClient
{
    public const string RepositoryUrl = "https://github.com/ChenXing-CyberVenus/Cloudig";
    public const string RepositoryApi = "https://api.github.com/repos/ChenXing-CyberVenus/Cloudig";
    public const string LatestApi = RepositoryApi + "/releases/latest";
    public const int TimeoutSeconds = 12;
    public const int MaximumResponseBytes = 262_144;
    public const int MaximumVersionCharacters = 128;
    public const int MaximumJsonDepth = 32;
    private const int ReadChunkBytes = 4096;
    private static readonly HttpClient DefaultHttp = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly Regex VersionPattern = new(@"^[vV]?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$", RegexOptions.CultureInvariant);
    private readonly HttpClient _http;

    public ReleaseUpdateClient(HttpClient? http = null) => _http = http ?? DefaultHttp;

    private sealed record ProductVersion(int Major, int Minor, int Patch, bool Prerelease, string Display);
    private static ProductVersion? ParseVersion(string? value)
    {
        if (value is null || value.Length > MaximumVersionCharacters) return null;
        var match = VersionPattern.Match(value);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var major) || !int.TryParse(match.Groups[2].Value, out var minor)
            || !int.TryParse(match.Groups[3].Success ? match.Groups[3].Value : "0", out var patch)) return null;
        return new(major, minor, patch, match.Groups[4].Success, value.Split('+')[0]);
    }

    public static string CompareStableRelease(string current, string latest)
    {
        var local = ParseVersion(current); var remote = ParseVersion(latest);
        if (local is null || remote is null || remote.Prerelease) return "invalid_version";
        var comparison = local.Major.CompareTo(remote.Major);
        if (comparison == 0) comparison = local.Minor.CompareTo(remote.Minor);
        if (comparison == 0) comparison = local.Patch.CompareTo(remote.Patch);
        if (comparison == 0 && local.Prerelease) comparison = -1;
        return comparison < 0 ? "available" : comparison == 0 ? "current" : "ahead";
    }

    private async Task<HttpResponseMessage> GetAsync(string url, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("Cloudig/1.0");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", "2026-03-10");
        return await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
    }

    private static string FailedStatus(HttpStatusCode status) => status is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests ? "rate_limited" : "unavailable";

    public async Task<ReleaseUpdateResult> CheckAsync(string? currentVersion, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var current = ParseVersion(currentVersion);
        if (current is null) return new("invalid_version", null);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(TimeoutSeconds));
        try
        {
            using var response = await GetAsync(LatestApi, timeout.Token);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                // A missing/inaccessible repository must not masquerade as "no releases".
                using var repository = await GetAsync(RepositoryApi, timeout.Token);
                return new(repository.IsSuccessStatusCode ? "no_release" : FailedStatus(repository.StatusCode), current.Display);
            }
            if (!response.IsSuccessStatusCode) return new(FailedStatus(response.StatusCode), current.Display);
            if (response.Content.Headers.ContentLength > MaximumResponseBytes) return new("invalid_response", current.Display);
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var bytes = new MemoryStream();
            var buffer = new byte[ReadChunkBytes];
            int count;
            while ((count = await input.ReadAsync(buffer, timeout.Token)) != 0)
            {
                if (bytes.Length + count > MaximumResponseBytes) return new("invalid_response", current.Display);
                bytes.Write(buffer, 0, count);
            }
            using var json = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = MaximumJsonDepth });
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("draft", out var draft) || draft.ValueKind != JsonValueKind.False
                || !root.TryGetProperty("prerelease", out var prerelease) || prerelease.ValueKind != JsonValueKind.False
                || !root.TryGetProperty("tag_name", out var tag) || tag.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("published_at", out var published) || published.ValueKind != JsonValueKind.String || !DateTimeOffset.TryParse(published.GetString(), out _))
                return new("invalid_response", current.Display);
            var latest = ParseVersion(tag.GetString());
            if (latest is null || latest.Prerelease) return new("invalid_version", current.Display);
            var status = CompareStableRelease(currentVersion!, tag.GetString()!);
            ReleaseInstaller? installer = null;
            if (status == "available" && root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array) {
                var version = $"{latest.Major}.{latest.Minor}.{latest.Patch}";
                foreach (var asset in assets.EnumerateArray()) {
                    if (asset.ValueKind != JsonValueKind.Object || !asset.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || name.GetString() != $"Cloudig-{version}-Setup.exe" || !asset.TryGetProperty("size", out var size) || size.ValueKind != JsonValueKind.Number || !size.TryGetInt64(out var length) || length is < 1 or > VerifiedDownloadClient.MaximumBytes
                        || !asset.TryGetProperty("digest", out var digest) || digest.ValueKind != JsonValueKind.String || !Regex.IsMatch(digest.GetString()!, "^sha256:[a-fA-F0-9]{64}$")
                        || !asset.TryGetProperty("browser_download_url", out var address) || address.ValueKind != JsonValueKind.String) continue;
                    if (!Uri.TryCreate(address.GetString(), UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "github.com" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.AbsolutePath != $"/ChenXing-CyberVenus/Cloudig/releases/download/{tag.GetString()}/{name.GetString()}") continue;
                    installer = new(version, uri.AbsoluteUri, name.GetString()!, length, digest.GetString()![7..]); break;
                }
            }
            return new(status, current.Display, latest.Display, installer);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return new("timeout", current.Display); }
        catch (HttpRequestException) { return new("unavailable", current.Display); }
        catch (IOException) { return new("unavailable", current.Display); }
        catch (JsonException) { return new("invalid_response", current.Display); }
    }
}
