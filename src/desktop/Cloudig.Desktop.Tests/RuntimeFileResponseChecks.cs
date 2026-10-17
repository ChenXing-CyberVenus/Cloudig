using System.Text;
using Cloudig.Desktop.Core;

internal static class RuntimeFileResponseChecks
{
    public static async Task RunAsync(string scope)
    {
        var rules = LocalFileResponses.BrowserArguments;
        if (rules.Contains('*') || rules.Contains("proxy", StringComparison.OrdinalIgnoreCase) || rules.Contains("ignore-certificate", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Offline origin rules must not broaden network/security settings.");
        foreach (var host in new[] { "cloudig.local", "cloudig-runtime.local", "cloudig-work.invalid", "cloudig-map.local" })
            if (!rules.Contains($"MAP {host} 127.0.0.1", StringComparison.Ordinal)) throw new InvalidOperationException("Offline origin needs explicit local resolution.");
        var root = Path.Combine(scope, "runtime-response", new string('d', 90));
        var relative = $"v_{new string('v', 43)}/pages/p_{new string('p', 43)}.json";
        var file = Path.Combine(root, relative); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        if (file.Length <= 260) throw new InvalidOperationException("The actual test path must exceed MAX_PATH");
        var bytes = Encoding.UTF8.GetBytes("{\"text\":\"完整读取，不能挪到C盘\"}"); await File.WriteAllBytesAsync(file, bytes);
        using var server = new LocalFileResponses(root, root);
        var url = "https://cloudig-runtime.local/" + relative;
        var response = server.Open(url, "GET");
        if (response.Status != 200 || response.Content is null || !response.Headers.Contains("application/json")) throw new InvalidOperationException("Long-path content unavailable");
        using var output = new MemoryStream(); await response.Content.CopyToAsync(output);
        if (!output.ToArray().SequenceEqual(bytes)) throw new InvalidOperationException("Runtime file bytes changed");
        using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) { } // EOF released its file handle.
        await File.WriteAllTextAsync(Path.Combine(root, "index.html"), "<link rel=\"stylesheet\" href=\"/shell.css\"><script src=\"/shell.js\"></script>");
        var index = server.Open("https://cloudig.local/index.html?cloudig-build=42", "GET");
        if (index.Status != 200 || index.Content is null) throw new InvalidOperationException("Local shell index unavailable");
        using (var indexReader = new StreamReader(index.Content, Encoding.UTF8))
        {
            var rewritten = await indexReader.ReadToEndAsync();
            if (!rewritten.Contains("/shell.css?cloudig-build=42", StringComparison.Ordinal) || !rewritten.Contains("/shell.js?cloudig-build=42", StringComparison.Ordinal)) throw new InvalidOperationException("Local shell assets were not cache-busted");
        }
        var stylesheet = Path.Combine(root, "主题样式.css"); await File.WriteAllTextAsync(stylesheet, "body{color:red}");
        var style = server.Open("https://cloudig.local/" + Uri.EscapeDataString("主题样式.css"), "GET");
        if (style.Status != 200 || !style.Headers.Contains("text/css") || !style.Headers.Contains("Cache-Control: no-store") || style.Headers.Contains("Access-Control-Allow-Origin")) throw new InvalidOperationException("Local application content lost its MIME/origin boundary or became cacheable");
        style.Content!.Dispose();
        Directory.CreateDirectory(Path.Combine(root, "runtime"));
        await File.WriteAllTextAsync(Path.Combine(root, "runtime", "interactive-frame.html"), "<!doctype html>");
        var work = server.Open("https://cloudig-work.invalid/runtime/interactive-frame.html", "GET");
        if (work.Status != 200 || !work.Headers.Contains("sandbox allow-scripts allow-same-origin")) throw new InvalidOperationException("Work origin lost its sandbox policy");
        work.Content!.Dispose();
        foreach (var name in new[] { "map-frame.html", "map-frame.js", "map-frame.css", "map-worker.js" })
        {
            await File.WriteAllTextAsync(Path.Combine(root, "runtime", name), "map-runtime");
            var map = server.Open("https://cloudig-map.local/runtime/" + name, "GET");
            if (map.Status != 200 || name.EndsWith(".html") && !map.Headers.Contains("sandbox allow-scripts allow-same-origin")) throw new InvalidOperationException("Dedicated map runtime was not served locally");
            map.Content!.Dispose();
            if (server.Open("https://cloudig-work.invalid/runtime/" + name, "GET").Status != 403) throw new InvalidOperationException("Untrusted works acquired the map runtime origin");
        }
        foreach (var denied in new[] { "index.html", relative, "主题样式.css" })
        {
            if (server.Open("https://cloudig-work.invalid/" + denied, "GET").Status != 403) throw new InvalidOperationException("Work origin exposed an application/runtime file");
            if (server.Open("https://cloudig-map.local/" + denied, "GET").Status != 403) throw new InvalidOperationException("Map origin exposed an application/runtime file");
        }
        foreach (var (extension, mime) in new[] { ("mp3", "audio/mpeg"), ("mp4", "video/mp4"), ("webm", "video/webm"), ("wav", "audio/wav"), ("avif", "image/avif"), ("vtt", "text/vtt") })
        {
            var media = $"v_{new string('v', 43)}/assets/r_{new string('r', 43)}.{extension}";
            var mediaFile = Path.Combine(root, media); Directory.CreateDirectory(Path.GetDirectoryName(mediaFile)!); await File.WriteAllBytesAsync(mediaFile, [1, 2, 3]);
            var served = server.Open("https://cloudig-runtime.local/" + media, "HEAD");
            if (served.Status != 200 || !served.Headers.Contains("Content-Type: " + mime)) throw new InvalidOperationException("The file responder lost a media MIME type: " + extension);
        }
        if (server.Open(url, "HEAD").Content is not null || server.Open(url, "POST").Status != 405) throw new InvalidOperationException("Unexpected runtime method handling");
        foreach (var bad in new[] { "https://example.com/" + relative, "https://cloudig-runtime.local/manifest.json", "https://cloudig-runtime.local/../CloudigLibrary.json", "https://cloudig-runtime.local/" + relative.Replace("pages/", "pages/%2F") })
            if (server.Open(bad, "GET").Status != 403) throw new InvalidOperationException("A non-capability URL was served");
        var cancelled = server.Open(url, "GET");
        try { await cancelled.Content!.ReadExactlyAsync(new byte[4], new CancellationToken(true)); throw new InvalidOperationException("The cancelled read should fail"); }
        catch (OperationCanceledException) { }
        using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) { }
        var pending = server.Open(url, "GET"); server.Dispose();
        using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) { }
        if (pending.Content!.ReadByte() != -1) throw new InvalidOperationException("Disposal did not revoke an unfinished response");
    }
}
