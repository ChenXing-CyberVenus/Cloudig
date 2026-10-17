using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class UpdateCertificateChecks
{
    public static async Task CheckAssemblyAsync(string assemblyFile,string signedFile) {
        var context=new System.Runtime.Loader.AssemblyLoadContext("packaged-certificate-check",isCollectible:true);
        try {
            var assembly=context.LoadFromAssemblyPath(Path.GetFullPath(assemblyFile));
            var type=assembly.GetType("Cloudig.Desktop.Core.PortableUpdateClient",throwOnError:true)!;
            Require(type.GetField("PublisherThumbprint")==null,"Packaged updater still pins one certificate");
            var method=type.GetMethod("VerifySignatureAsync",[typeof(string),typeof(CancellationToken)])??throw new Exception("Packaged updater has the old signature policy");
            await (Task)method.Invoke(null,[Path.GetFullPath(signedFile),CancellationToken.None])!;
            Console.WriteLine(JsonSerializer.Serialize(new{passed=true,assembly=Path.GetFullPath(assemblyFile),signed_file=Path.GetFullPath(signedFile),no_fixed_signer=true}));
        } finally {context.Unload();}
    }
    private sealed class FileHttp(string file) : HttpMessageHandler {
        public int Requests { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) {
            Requests++;return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StreamContent(File.OpenRead(file))});
        }
    }
    private static void Require(bool value,string message) { if(!value)throw new Exception(message); }
    private static async Task Reject<T>(Func<Task> action,string message) where T:Exception {
        try { await action(); } catch(T) { return; } throw new Exception(message);
    }
    private static ReleaseInstaller Descriptor(string file) => new("1.0.6",$"{ReleaseUpdateClient.RepositoryUrl}/releases/download/v1.0.6/Cloudig-1.0.6-Setup.exe","Cloudig-1.0.6-Setup.exe",new FileInfo(file).Length,Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));

    public static async Task RunAsync(string root,string previousSignedFile,string renewedSignedFile) {
        root=Path.GetFullPath(root);Require(root.StartsWith(Path.GetFullPath("tests/private")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"Use an isolated test root");Require(!Directory.Exists(root),"Test root exists");
        Directory.CreateDirectory(root);await File.WriteAllTextAsync(Path.Combine(root,"Cloudig.exe"),"test-root-marker");
        var passed=new List<string>();
        foreach(var signed in new[]{previousSignedFile,renewedSignedFile}) {
            await PortableUpdateClient.VerifySignatureAsync(Path.GetFullPath(signed),default);
            using var http=new HttpClient(new FileHttp(Path.GetFullPath(signed)));
            var prepared=await new PortableUpdateClient(http).PrepareAsync(Descriptor(signed),root,root,null,default);
            var json=await File.ReadAllTextAsync(prepared.RequestFile);
            Require(!json.Contains("Thumbprint",StringComparison.OrdinalIgnoreCase),"Request must not bind a certificate");
            PortableUpdateClient.Discard(prepared);Require(!Directory.Exists(Path.Combine(root,"cache","Update")),"Discard retained update bytes");
            passed.Add("real_valid_signature_and_prepare:"+Path.GetFileName(signed));
        }
        var unsigned=Path.Combine(root,"unsigned.exe");await File.WriteAllTextAsync(unsigned,"Not an Authenticode signed PE");
        await Reject<InvalidDataException>(()=>PortableUpdateClient.VerifySignatureAsync(unsigned,default),"Unsigned file accepted");passed.Add("reject_unsigned");
        var damaged=Path.Combine(root,"damaged.exe");var damagedBytes=await File.ReadAllBytesAsync(renewedSignedFile);damagedBytes[256]^=1;await File.WriteAllBytesAsync(damaged,damagedBytes);
        await Reject<InvalidDataException>(()=>PortableUpdateClient.VerifySignatureAsync(damaged,default),"Damaged signature accepted");passed.Add("reject_damaged_signature");
        using var handler=new FileHttp(Path.GetFullPath(renewedSignedFile));using var clientHttp=new HttpClient(handler);var client=new PortableUpdateClient(clientHttp);var valid=Descriptor(renewedSignedFile);
        foreach(var invalid in new[]{valid with{Url=valid.Url.Replace("ChenXing-CyberVenus/Cloudig","someone/else")},valid with{Url=valid.Url+"?redirect=elsewhere"},valid with{Name="another.exe"},valid with{Sha256="not-a-hash"},valid with{Version="../other"}}) {
            await Reject<InvalidDataException>(()=>client.PrepareAsync(invalid,root,root,null,default),"Invalid official descriptor accepted");
        }
        Require(handler.Requests==0,"Invalid descriptor caused a download");passed.Add("reject_five_invalid_descriptors_before_io");
        await Reject<InvalidDataException>(()=>client.PrepareAsync(valid with{Sha256=new string('0',64)},root,root,null,default),"Mismatched bytes accepted");passed.Add("reject_sha256_mismatch");
        Require(!File.Exists(Path.Combine(root,"cache","Update","request.json")),"Failed hash produced install request");
        using(var unsignedHttp=new HttpClient(new FileHttp(unsigned)))await Reject<InvalidDataException>(()=>new PortableUpdateClient(unsignedHttp).PrepareAsync(Descriptor(unsigned),root,root,null,default),"Unsigned download became an update");
        Require(!File.Exists(Path.Combine(root,"cache","Update","Cloudig-Update.exe")),"Failed signature download not retired");passed.Add("unsigned_download_no_request_or_retained_bytes");
        using(var cancellation=new CancellationTokenSource()){cancellation.Cancel();await Reject<OperationCanceledException>(()=>client.PrepareAsync(valid,root,root,null,cancellation.Token),"Cancelled update accepted");}passed.Add("cancel_before_io");
        using var helperResource=typeof(PortableUpdateClient).Assembly.GetManifestResourceStream("Cloudig.PortableUpdate.ps1")!;using var reader=new StreamReader(helperResource);var helper=await reader.ReadToEndAsync();
        Require(!helper.Contains("Thumbprint",StringComparison.OrdinalIgnoreCase)&&helper.Contains("$signature.SignerCertificate")&&helper.Contains("$signature.TimeStamperCertificate")&&helper.Contains("$request.Sha256"),"Helper lost signature/time/hash gates or retained pin");passed.Add("embedded_helper_has_no_certificate_pin");
        await File.WriteAllTextAsync(Path.Combine(root,"result.json"),JsonSerializer.Serialize(new{passed=true,checks=passed}));Console.WriteLine(JsonSerializer.Serialize(new{passed=true,checks=passed.Count}));
    }
}
