using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class DownloadChecks
{
    private sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> send) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) => send(request,token);
    }
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static async Task LiveAsync(string root) {
        root=Path.GetFullPath(root);Require(root.StartsWith(Path.GetFullPath("tests/private")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)&&!Directory.Exists(root),"Use a new private root");
        var client=new ExampleDownloadClient();
        foreach(var format in new[]{"html","json"}) {
            var result=await client.DownloadAsync(Path.GetFullPath("artifacts/v1-desktop/app/app/web/pages/document/content/examples.json"),root,"example-22b6862f799872aeff0b",format,null,default);
            Console.WriteLine(JsonSerializer.Serialize(result));
        }
    }
    public static async Task RunAsync(string parent) {
        parent = Path.GetFullPath(parent); if (!parent.StartsWith(Path.GetFullPath("tests/private") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Use a project-private test root.");
        var root = Path.Combine(parent, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root); var passed = false;
        try {
            var bytes = "Saved example file\n"u8.ToArray(); var hash = Convert.ToHexString(SHA256.HashData(bytes)); var requests = 0;string? publicCatalog=null;
            using var http = new HttpClient(new Handler((request,_) => { requests++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = request.RequestUri!.AbsoluteUri==ExampleDownloadClient.PublishedCatalog?new StringContent(publicCatalog!):new ByteArrayContent(bytes) }); }));
            var client = new VerifiedDownloadClient(http); var samples = new List<DownloadProgress>();
            var result = await client.SaveAsync(new("https://chenxing-cybervenus.github.io/Cloudig/examples/a.html"), bytes.Length, hash, root, "a.html", samples.Add, default);
            Require(!result.Existing && File.ReadAllBytes(result.Path).SequenceEqual(bytes), "Saved bytes differ"); Require(samples[0].Bytes == 0 && samples[^1].Bytes == bytes.Length, "Progress endpoints missing");
            var again = await client.SaveAsync(new("https://chenxing-cybervenus.github.io/Cloudig/examples/a.html"), bytes.Length, hash, root, "a.html", null, default); Require(again.Existing && requests == 1, "Repeated download should reuse matching bytes");
            File.WriteAllText(Path.Combine(root,"kept.html"),"user content");
            try { await client.SaveAsync(new("https://chenxing-cybervenus.github.io/Cloudig/examples/a.html"), bytes.Length, hash, root, "kept.html", null, default); throw new Exception("Changed file was overwritten"); } catch(IOException) { }
            Require(File.ReadAllText(Path.Combine(root,"kept.html")) == "user content", "User file changed");
            try { await client.SaveAsync(new("https://chenxing-cybervenus.github.io/Cloudig/examples/a.html"), bytes.Length, new string('0',64), root, "bad.html", null, default); throw new Exception("Bad SHA accepted"); } catch(InvalidDataException) { }
            Require(!File.Exists(Path.Combine(root,"bad.html")) && !Directory.EnumerateFiles(root,"*.part").Any(), "Failed bytes retained");
            var cancel = new CancellationTokenSource();
            try { await client.SaveAsync(new("https://chenxing-cybervenus.github.io/Cloudig/examples/a.html"), bytes.Length, hash, root, "cancel.html", _=>cancel.Cancel(), cancel.Token); throw new Exception("Cancellation ignored"); } catch(OperationCanceledException) { }
            Require(!File.Exists(Path.Combine(root,"cancel.html")) && !Directory.EnumerateFiles(root,"*.part").Any(), "Cancelled bytes retained");
            var gate=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using(var parallelHttp=new HttpClient(new Handler(async(request,_)=>{if(request.RequestUri!.AbsolutePath.EndsWith("slow"))await gate.Task;return new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)};}))) {
                var parallel=new VerifiedDownloadClient(parallelHttp);var staging=Path.Combine(root,"shared-downloads");
                var slow=parallel.SaveAsync(new("https://chenxing-cybervenus.github.io/slow"),bytes.Length,hash,root,"slow.html",null,default,staging);
                await parallel.SaveAsync(new("https://chenxing-cybervenus.github.io/fast"),bytes.Length,hash,root,"fast.html",null,default,staging);
                gate.SetResult();await slow;Require(!Directory.EnumerateFiles(staging).Any(),"Parallel parts not retired");
            }
            using var redirect = new HttpClient(new Handler((_,_)=>{var r=new HttpResponseMessage(HttpStatusCode.Redirect);r.Headers.Location=new Uri("https://untrusted.test/file");return Task.FromResult(r);}));
            try { await new VerifiedDownloadClient(redirect).SaveAsync(new("https://github.com/ChenXing-CyberVenus/Cloudig/releases/download/v1.0.2/a.exe"), bytes.Length, hash, root, "escape.exe", null, default); throw new Exception("Foreign redirect accepted"); } catch(IOException) { }
            var catalog = Path.Combine(root,"catalog.json");
            File.WriteAllText(catalog,JsonSerializer.Serialize(new{examples=new[]{new{id="example-01234567890123456789",html=new{path="html/Example.html",bytes=bytes.Length,sha256=hash}}}}));
            publicCatalog=File.ReadAllText(catalog);
            // A software build's catalog can be older than the live website.
            File.WriteAllText(catalog,publicCatalog.Replace(hash,new string('1',64)));
            var example = await new ExampleDownloadClient(http).DownloadAsync(catalog,root,"example-01234567890123456789","html",null,default);
            Require(example.Path == Path.Combine(root,"docs","examples","html","Example.html"), "Example did not use Library docs");
            var release = JsonSerializer.Serialize(new { tag_name="v9.1.2",draft=false,prerelease=false,published_at="2026-09-25T01:00:00Z",assets=new[]{new{name="Cloudig-9.1.2-Setup.exe",size=bytes.Length,digest="sha256:"+hash,browser_download_url="https://github.com/ChenXing-CyberVenus/Cloudig/releases/download/v9.1.2/Cloudig-9.1.2-Setup.exe"}}});
            using var releaseHttp = new HttpClient(new Handler((_,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(release)})));
            var update = await new ReleaseUpdateClient(releaseHttp).CheckAsync("1.0.2"); Require(update.Status == "available" && update.Installer?.Version == "9.1.2", "Signed download metadata unavailable");
            await File.WriteAllBytesAsync(Path.Combine(root,"unsigned.exe"),bytes);
            try { await PortableUpdateClient.VerifySignatureAsync(Path.Combine(root,"unsigned.exe"),PortableUpdateClient.PublisherThumbprint,default); throw new Exception("Unsigned update accepted"); } catch(InvalidDataException) { }
            passed = true; Console.WriteLine("PASS: download bytes/progress/reuse/conflict/hash/cancel/redirect/docs/release/unsigned rejection");
        } finally { if (passed) { VerifiedDownloadClient.PlainPath(root); Directory.Delete(root,true); } }
    }
}
