using System.Reflection;
using System.Text.Json;

namespace Cloudig.Desktop.Core;

public static class CloudigCachePolicy
{
    private static readonly JsonDocument Policy = JsonDocument.Parse(
        Assembly.GetExecutingAssembly().GetManifestResourceStream("Cloudig.CachePolicy.json")
        ?? throw new InvalidDataException("Cloudig cache policy is missing."));
    public static long DiskCacheBytes => Policy.RootElement.GetProperty("webview_disk_cache_bytes").GetInt64();
    public static long MediaCacheBytes => Policy.RootElement.GetProperty("webview_media_cache_bytes").GetInt64();
}
