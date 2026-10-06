using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class PortableUpdateChecks
{
    private sealed class SignedFileHttp(string file) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(File.OpenRead(file)) });
    }
    private static ProcessStartInfo Start(string file, params string[] arguments) {
        var start = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true };
        foreach(var argument in arguments) start.ArgumentList.Add(argument); return start;
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task<string> Hash(string file) { await using var stream = File.OpenRead(file); return Convert.ToHexString(await SHA256.HashDataAsync(stream)); }
    public static async Task WorkerAsync(string root, string installer) {
        var program = Path.Combine(root,"Cloudig");
        using var http = new HttpClient(new SignedFileHttp(installer));
        var client = new PortableUpdateClient(http);
        var release = new ReleaseInstaller("1.0.1", "https://github.com/ChenXing-CyberVenus/Cloudig/releases/download/v1.0.1/Cloudig-1.0.1-Setup.exe", Path.GetFileName(installer),new FileInfo(installer).Length,await Hash(installer));
        var progress = new List<DownloadProgress>();
        var first = await client.PrepareAsync(release,program,program,progress.Add,default);
        using (var lease = new FileStream(first.RequestFile,FileMode.Open,FileAccess.Read,FileShare.Read)) {
            try { await client.PrepareAsync(release,program,program,null,default); throw new Exception("An active helper's request was retired"); } catch(IOException) { }
        }
        // Retire only our abandoned preparation, then prepare the same signed
        // installer again. The real helper must wait for this worker to exit.
        var prepared = await client.PrepareAsync(release,program,program,progress.Add,default);
        Require(progress.Any(p=>p.Bytes==0)&&progress.Any(p=>p.Bytes==release.Bytes),"Missing download progress");
        var start = PortableUpdateClient.HelperStartInfo(prepared);
        start.RedirectStandardOutput=true; start.RedirectStandardError=true;
        start.Environment["TEMP"]=Path.Combine(root,"temp"); start.Environment["TMP"]=Path.Combine(root,"temp");
        start.Environment["CLOUDIG_TEST_RESTART_AUDIT"] = JsonSerializer.Serialize(new[]{"--visual-audit-output",Path.Combine(root,"restarted.png"),"--visual-audit-query","screenshot=1&fixture=real&route=welcome&theme=dawn&language=en&phase=motion-freeze","--visual-audit-width","1280","--visual-audit-height","720"});
        using var helper=Process.Start(start)??throw new Exception("Helper did not launch");
        await Task.Delay(800); Require(!helper.HasExited,"Helper did not wait for the live owner");
        Console.WriteLine(JsonSerializer.Serialize(new{helper_pid=helper.Id,request=prepared.RequestFile}));
    }
    public static async Task RunAsync(string parent) {
        parent=Path.GetFullPath(parent); Require(parent.StartsWith(Path.GetFullPath("tests/private")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"Use an isolated project-private path");
        Require(!Directory.Exists(parent),"The test root must be new");
        Directory.CreateDirectory(parent);Directory.CreateDirectory(Path.Combine(parent,"temp"));
        var program=Path.Combine(parent,"Cloudig");
        var oldInstaller=Path.GetFullPath("releases/1.0.0/Cloudig-1.0.0-Setup.exe");
        var installer=Path.GetFullPath("releases/1.0.1/Cloudig-1.0.1-Setup.exe");
        await PortableUpdateClient.VerifySignatureAsync(oldInstaller,PortableUpdateClient.PublisherThumbprint,default);
        await PortableUpdateClient.VerifySignatureAsync(installer,PortableUpdateClient.PublisherThumbprint,default);
        var setup=Start(oldInstaller,"/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-","/TASKS=","/DIR="+program,"/LOG="+Path.Combine(parent,"baseline-install.log"));
        setup.Environment["TEMP"]=Path.Combine(parent,"temp");setup.Environment["TMP"]=Path.Combine(parent,"temp");
        using(var process=Process.Start(setup)??throw new Exception("Baseline installer did not start")) { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3)); Require(process.ExitCode==0,"Baseline installation failed"); }
        Require(FileVersionInfo.GetVersionInfo(Path.Combine(program,"Cloudig.exe")).ProductVersion?.Split('+')[0]=="1.0.0","Wrong baseline version");
        await using (var engine=await EngineJsonlClient.StartAsync(Path.Combine(program,"app","runtime","node","node.exe"),Path.Combine(program,"app","engine","engine.mjs"),program,Path.Combine(program,"cache")))
            await engine.SendAsync("library.create",JsonSerializer.SerializeToElement(new{}));
        var keep=new Dictionary<string,string>();
        keep[Path.Combine(program,"CloudigLibrary.json")]=await Hash(Path.Combine(program,"CloudigLibrary.json"));
        foreach(var folder in new[]{"Inbox","Conversations","Marks","Times","Identities/Images","Exports","docs/user"}) {
            var directory=Path.Combine(program,folder);Directory.CreateDirectory(directory);var file=Path.Combine(directory,"audit-user-file.txt");await File.WriteAllTextAsync(file,"User data must survive: "+folder);keep[file]=await Hash(file);
        }
        var own=Environment.ProcessPath!;var args=new List<string>();if(Path.GetFileNameWithoutExtension(own).Equals("dotnet",StringComparison.OrdinalIgnoreCase))args.Add(typeof(PortableUpdateChecks).Assembly.Location);
        args.AddRange(["--portable-update-worker",parent,installer]);var worker=Start(own,args.ToArray());worker.RedirectStandardOutput=true;worker.RedirectStandardError=true;
        using(var process=Process.Start(worker)??throw new Exception("Worker did not start")) {
            var output=process.StandardOutput.ReadToEndAsync();var error=process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3));Require(process.ExitCode==0,"Worker: "+await error);await File.WriteAllTextAsync(Path.Combine(parent,"worker.json"),await output);
            using var report=JsonDocument.Parse(await output);
            try { using var helper=Process.GetProcessById(report.RootElement.GetProperty("helper_pid").GetInt32());await helper.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3));Require(helper.ExitCode==0,"Signed installer helper failed"); } catch(ArgumentException) { }
        }
        for(var n=0;n<90&&!File.Exists(Path.Combine(parent,"restarted.png"));n++) {
            if(File.Exists(Path.Combine(parent,"restarted.error.txt")))throw new Exception(await File.ReadAllTextAsync(Path.Combine(parent,"restarted.error.txt")));
            await Task.Delay(1000);
        }
        Require(File.Exists(Path.Combine(parent,"restarted.png")),"Updated application did not complete its real welcome journey");
        Require(FileVersionInfo.GetVersionInfo(Path.Combine(program,"Cloudig.exe")).ProductVersion?.Split('+')[0]=="1.0.1","Updated version is wrong");
        await PortableUpdateClient.VerifySignatureAsync(Path.Combine(program,"Cloudig.exe"),PortableUpdateClient.PublisherThumbprint,default);
        foreach(var entry in keep)Require(await Hash(entry.Key)==entry.Value,"User data changed: "+entry.Key);
        Require(!Directory.Exists(Path.Combine(program,"cache","Update")),"Completed installer/request were not retired");
        await File.WriteAllTextAsync(Path.Combine(parent,"result.json"),JsonSerializer.Serialize(new{passed=true,from="1.0.0",to="1.0.1",signed_installers=true,owner_wait=true,active_request_preserved=true,restarted=true,preserved_files=keep.Count,update_cache_removed=true}));
        Console.WriteLine("PASS: actual signed 1.0.0→1.0.1 installation, exact owner exit, restart, user files unchanged, update cache removed; fixture remains for audited cleanup.");
    }
}
