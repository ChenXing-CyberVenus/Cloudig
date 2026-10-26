using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class OptionalWorkComponentChecks
{
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request, token); }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    public static async Task RunAsync(string parent)
    {
        parent = Path.GetFullPath(parent);
        Require(parent.StartsWith(Path.GetFullPath("tests/private") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Use a project-private parent.");
        var root = Path.Combine(parent, "component-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root); var passed = false;
        try
        {
            var bytes = "public library\n"u8.ToArray(); var hash = Convert.ToHexString(SHA256.HashData(bytes));
            string Catalog(string digest = "") => JsonSerializer.Serialize(new { components = new[] { new { id = "test-1.0.0", files = new[] { new { file = "nested/library.js", url = "https://cdn.jsdelivr.net/npm/test@1.0.0/library.js", mime = "text/javascript", bytes = bytes.Length, sha256 = digest.Length > 0 ? digest : hash } } } } });
            var address = "https://cloudig.local/runtime/optional/test-1.0.0/nested/library.js";
            var requests = 0;
            using var http = new HttpClient(new Handler((_, _) => { Interlocked.Increment(ref requests); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }); }));
            var app = Path.Combine(root, "app"); var cache = Path.Combine(root, "cache");
            await using (var component = new OptionalWorkComponents(app, cache, http, Catalog()))
            {
                var first = component.OpenAsync(address, "GET"); var second = component.OpenAsync(address, "GET");
                foreach (var response in await Task.WhenAll(first, second)) { Require(response.Status == 200, "Component did not load"); using var stream = response.Content!; using var copy = new MemoryStream(); await stream.CopyToAsync(copy); Require(copy.ToArray().SequenceEqual(bytes), "Component bytes differ"); }
                Require(requests == 1, "Parallel loads downloaded twice");
                Require((await component.OpenAsync(address.Replace("test-1.0.0", "not-in-catalog"), "GET")).Status == 404, "Unknown component accepted");
                Require((await component.OpenAsync(address, "POST")).Status == 405, "Write request accepted");
            }
            Require(File.ReadAllBytes(Path.Combine(app, "optional-components/test-1.0.0/nested/library.js")).SequenceEqual(bytes), "Not stored in app");
            Require(!Directory.EnumerateFiles(cache, "*", SearchOption.AllDirectories).Any(), "Temporary bytes retained");
            var moved = Path.Combine(root, "moved/app"); Directory.CreateDirectory(Path.GetDirectoryName(moved)!); Directory.Move(app, moved);
            await using (var reopened = new OptionalWorkComponents(moved, cache, http, Catalog())) { var response = await reopened.OpenAsync(address, "GET"); response.Content?.Dispose(); Require(response.Status == 200 && requests == 1, "Restart/move did not reuse verified component"); }
            await using (var wrong = new OptionalWorkComponents(Path.Combine(root, "bad/app"), cache, http, Catalog(new string('0', 64)))) Require((await wrong.OpenAsync(address, "GET")).Status == 503, "Bad digest installed");
            Require(!Directory.EnumerateFiles(Path.Combine(root, "bad"), "*", SearchOption.AllDirectories).Any(), "Bad component bytes retained");
            Require(!VerifiedDownloadClient.PublicDownloadUri(new("https://cdn.jsdelivr.net/file")), "Updater permissions broadened");
            Require(!OptionalWorkComponents.Handles("https://cloudig-work.invalid/runtime/optional/test-1.0.0/nested/library.js"), "Work origin received native component service");
            using var redirect = new HttpClient(new Handler((_, _) => { var response = new HttpResponseMessage(HttpStatusCode.Redirect); response.Headers.Location = new("https://untrusted.test/library.js"); return Task.FromResult(response); }));
            await using (var blocked = new OptionalWorkComponents(Path.Combine(root, "blocked/app"), cache, redirect, Catalog())) Require((await blocked.OpenAsync(address, "GET")).Status == 503, "Foreign redirect accepted");
            using var waiting = new HttpClient(new Handler(async (_, token) => { await Task.Delay(Timeout.Infinite, token); return new(HttpStatusCode.OK); }));
            var canceled = new OptionalWorkComponents(Path.Combine(root, "cancel/app"), cache, waiting, Catalog()); var pending = canceled.OpenAsync(address, "GET"); await canceled.DisposeAsync(); Require((await pending).Status == 503, "Shutdown did not cancel download");
            passed = true; Console.WriteLine("PASS optional components: app/restart/move/parallel/hash/catalog/redirect/cancel/cache/update boundary");
        }
        finally { if (passed) { VerifiedDownloadClient.PlainPath(root); Directory.Delete(root, recursive: true); } }
    }
}
