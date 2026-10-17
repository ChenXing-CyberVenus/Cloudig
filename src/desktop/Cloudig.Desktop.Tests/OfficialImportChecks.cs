using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class OfficialImportChecks
{
    // End-to-end evidence for the exact native picker + packaged Engine path.
    // Keep the owned Library for subsequent Reader visual checks; no user root.
    public static async Task RunAsync(string node, string script, string source, string output)
    {
        var directory = Path.GetFullPath(output);
        var parent = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "artifacts", "v1-visual-audit"));
        if (Path.GetDirectoryName(directory) != parent || Directory.Exists(directory)) throw new InvalidOperationException("Official check needs a fresh exact audit directory.");
        Directory.CreateDirectory(directory);
        var library = Path.Combine(directory, "Library"); Directory.CreateDirectory(library);
        var before = await HashAsync(source);
        await using var engine = await EngineJsonlClient.StartAsync(Path.GetFullPath(node), Path.GetFullPath(script), library, Path.Combine(library, "cache"));
        static JsonElement Payload(object value) => JsonSerializer.SerializeToElement(value);
        await engine.SendAsync("library.create", Payload(new { }));
        var token = SourcePickerBoundary.CreateToken();
        var picked = await SourcePickerBoundary.StageAsync(engine.RuntimeRoot, source, token);
        var plan = await engine.SendAsync("source.assets.plan", Payload(new { picker = token }));
        if (plan.GetProperty("available").GetBoolean()) await SourcePickerBoundary.StageCompanionsAsync(engine.RuntimeRoot, source, token);
        var imported = await engine.SendAsync("source.import", Payload(new { pickers = new[] { token } }));
        if (imported.GetProperty("state").GetString() != "completed") throw new InvalidOperationException("Native import failed: " + imported);
        var listing = await engine.SendAsync("archiver.sources.query", Payload(new { offset = 0, limit = 200 }));
        var selected = listing.GetProperty("items")[0];
        var indexed = await engine.SendAsync("archiver.claude.index", Payload(new { source = selected.GetProperty("capability").GetString() }));
        var container = indexed.GetProperty("container").GetString();
        var rows = await engine.SendAsync("archiver.claude.records.query", Payload(new { container, offset = 0, limit = 200 }));
        var selectors = rows.GetProperty("items").EnumerateArray().Select(r => r.GetProperty("selector").GetString()).ToArray();
        if (selectors.Length == 0 || rows.GetProperty("total").GetInt32() != selectors.Length) throw new InvalidOperationException("Audit selection must cover every real record in its single page.");
        var preview = await engine.SendAsync("archiver.claude.extract.preview", Payload(new { container, selectors }));
        var parsed = await engine.SendAsync("archiver.claude.extract.commit", Payload(new { plans = new[] { preview.GetProperty("plan").GetString() } }));
        if (parsed.GetProperty("failed").GetInt32() != 0 || parsed.GetProperty("completed").GetInt32() != selectors.Length) throw new InvalidOperationException("Packaged parsing failed: " + parsed);
        var after = await engine.SendAsync("archiver.claude.records.query", Payload(new { container, offset = 0, limit = 200 }));
        if (after.GetProperty("items").EnumerateArray().Any(r => r.GetProperty("status").GetString() != "parsed")) throw new InvalidOperationException("Imported record status did not settle.");
        if (before != await HashAsync(source)) throw new InvalidOperationException("Original source changed.");
        var zipped = Path.GetExtension(source).Equals(".zip", StringComparison.OrdinalIgnoreCase);
        var outputs = parsed.GetProperty("items").EnumerateArray().Select(r => r.GetProperty("path").GetString()!).ToArray();
        var embeddedResources = 0;
        if (zipped)
        {
            var inbox = Directory.GetFileSystemEntries(Path.Combine(library, "Inbox"));
            if (inbox.Length != 1 || !File.Exists(inbox[0]) || await HashAsync(inbox[0]) != before) throw new InvalidOperationException("ZIP import must preserve exactly the original archive, without an extracted sidecar.");
            foreach (var relative in outputs)
            {
                using var document = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(library, relative)));
                var origin = document.RootElement.GetProperty("source");
                if (origin.GetProperty("format").GetString() != "zip-container" || origin.GetProperty("sha256").GetString() != before || !origin.GetProperty("locator").GetString()!.StartsWith("zip:")) throw new InvalidOperationException("Conversation lost its original ZIP provenance.");
                if (document.RootElement.TryGetProperty("resources", out var resources))
                    embeddedResources += resources.EnumerateArray().Count(r => r.GetProperty("availability").GetString() == "embedded");
            }
        }
        var evidence = new { source_sha256 = before, native_picker = true, packaged_engine = Path.GetFullPath(script),
            platform = selected.GetProperty("platform").GetString(), source_unchanged = true, records = selectors.Length,
            assets_planned = plan.TryGetProperty("files", out var count) ? count.GetInt32() : 0,
            original_zip_only = zipped, embedded_resources = embeddedResources, outputs };
        var report = Path.Combine(directory, "native-import-evidence.json");
        await File.WriteAllTextAsync(report, JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true }) + "\n");
        Console.WriteLine(JsonSerializer.Serialize(new { report, evidence.platform, evidence.records, evidence.assets_planned }));
    }
    private static async Task<string> HashAsync(string file)
    {
        await using var input = File.OpenRead(file);
        return Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant();
    }
}
