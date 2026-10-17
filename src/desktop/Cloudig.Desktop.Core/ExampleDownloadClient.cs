using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Desktop.Core;

public sealed class ExampleDownloadClient(HttpClient? http = null)
{
    public const int MaximumCatalogBytes = 2 * 1024 * 1024;
    public const int CatalogTimeoutSeconds = 12;
    public const string PublishedCatalog = "https://chenxing-cybervenus.github.io/Cloudig/pages/document/content/examples.json";
    private static readonly HttpClient Default = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private readonly HttpClient _http = http ?? Default;
    private readonly VerifiedDownloadClient _downloads = new(http);
    public async Task<JsonElement> PublishedFileAsync(string catalogFile, string example, string format, CancellationToken token)
    {
        if (!Regex.IsMatch(example, "^example-[a-f0-9]{20}$") || format is not ("html" or "json")) throw new InvalidDataException("Unknown example download.");
        if (new FileInfo(catalogFile).Length > MaximumCatalogBytes) throw new InvalidDataException("Example catalog exceeds its bound.");
        using var catalog = JsonDocument.Parse(await File.ReadAllBytesAsync(catalogFile, token));
        var entry = catalog.RootElement.GetProperty("examples").EnumerateArray().FirstOrDefault(e => e.GetProperty("id").GetString() == example);
        if (entry.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Unknown public example.");
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);timeout.CancelAfter(TimeSpan.FromSeconds(CatalogTimeoutSeconds));
        using var response=await _http.GetAsync(PublishedCatalog,HttpCompletionOption.ResponseHeadersRead,timeout.Token);response.EnsureSuccessStatusCode();
        if(response.Content.Headers.ContentLength>MaximumCatalogBytes)throw new InvalidDataException("Public example catalog exceeds its bound.");
        await using var input=await response.Content.ReadAsStreamAsync(timeout.Token);using var memory=new MemoryStream();var buffer=new byte[8192];int count;
        while((count=await input.ReadAsync(buffer,timeout.Token))>0){if(memory.Length+count>MaximumCatalogBytes)throw new InvalidDataException("Public example catalog exceeds its bound.");memory.Write(buffer,0,count);}
        using var published=JsonDocument.Parse(memory.ToArray());
        var current=published.RootElement.GetProperty("examples").EnumerateArray().SingleOrDefault(e=>e.GetProperty("id").GetString()==example);
        if(current.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("This example has not been published yet.");
        var field=format=="html"?"html":"record";var file=current.GetProperty(field);
        if(file.GetProperty("path").GetString()!=entry.GetProperty(field).GetProperty("path").GetString())throw new InvalidDataException("The published example changed its canonical path.");
        return file.Clone();
    }
    public async Task<VerifiedDownloadResult> DownloadAsync(string catalogFile, string libraryRoot, string example, string format, Action<DownloadProgress>? progress, CancellationToken token)
    {
        var file = await PublishedFileAsync(catalogFile,example,format,token);
        var relative = file.GetProperty("path").GetString()!;
        var segment = format == "html" ? "html" : "records";
        if (!relative.StartsWith(segment + "/", StringComparison.Ordinal) || relative.Split('/').Length != 2 || relative.Contains('\\') || !relative.EndsWith(format == "html" ? ".html" : ".json", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Example path escaped its catalog folder.");
        var folder = Path.Combine(Path.GetFullPath(libraryRoot), "docs", "examples", segment);
        var url = new Uri("https://chenxing-cybervenus.github.io/Cloudig/examples/" + string.Join('/', relative.Split('/').Select(Uri.EscapeDataString)));
        return await _downloads.SaveAsync(url, file.GetProperty("bytes").GetInt64(), file.GetProperty("sha256").GetString()!, folder, relative.Split('/')[1], progress, token, Path.Combine(libraryRoot, "cache", "Downloads"));
    }
}
