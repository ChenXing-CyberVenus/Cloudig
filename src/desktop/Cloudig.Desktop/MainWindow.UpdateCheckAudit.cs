using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using Cloudig.Desktop.Core;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    // Only the explicit fixed-EXE audit injects HTTP responses. The UI, bridge,
    // version lookup, hit testing and native external request remain production.
    private sealed class UpdateAuditHttp : HttpMessageHandler
    {
        public string Scenario = "no_release";
        public bool Cancelled;
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            Calls++;
            if(Scenario=="waiting") { try { await Task.Delay(Timeout.Infinite,token); } catch(OperationCanceledException) { Cancelled=true;throw; } }
            if(Scenario=="unavailable")return new(HttpStatusCode.ServiceUnavailable);
            if(Scenario=="no_release")return new(request.RequestUri!.AbsoluteUri==ReleaseUpdateClient.LatestApi?HttpStatusCode.NotFound:HttpStatusCode.OK);
            return new(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new { tag_name="v99.0.0",draft=false,prerelease=false,published_at="2026-09-25T00:00:00Z",assets=new[]{new{name="Cloudig-99.0.0-Setup.exe",size=1024,digest="sha256:"+new string('0',64),browser_download_url=ReleaseUpdateClient.RepositoryUrl+"/releases/download/v99.0.0/Cloudig-99.0.0-Setup.exe"}}}))};
        }
    }

    private async Task VerifyUpdateCheckAsync(VisualAuditOptions audit)
    {
        async Task Wait(string expression){for(var i=0;i<200;i++){if(await WebView.CoreWebView2.ExecuteScriptAsync(expression)=="true")return;await Task.Delay(50);}throw new TimeoutException("Update check: "+expression);}
        async Task Pointer(string selector){
            // The document-ready signal may precede the startup curtain's fade.
            // Wait for a genuine pointer hit; never click through an overlay.
            await Wait($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n?.getBoundingClientRect();return Boolean(r?.width&&r.height&&n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))})()
                """);
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n?.getBoundingClientRect();if(!r||!r.width||!r.height)return null;const x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """);
            if(raw=="null")throw new InvalidDataException("Update pointer covered: "+selector);
            using var p=JsonDocument.Parse(raw);var x=p.RootElement.GetProperty("x").GetDouble();var y=p.RootElement.GetProperty("y").GetDouble();
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
        }
        async Task Capture(string id){await using var output=File.Create(Path.ChangeExtension(audit.OutputFile,id+".png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,output);}
        var production=_releaseUpdates;
        using var handler=new UpdateAuditHttp();using var http=new HttpClient(handler);_releaseUpdates=new ReleaseUpdateClient(http);
        var original=WebView.Source;
        try
        {
            handler.Scenario="available";var startupBefore=handler.Calls;
            var startup=await QueryUpdateAsync(true,default);var duplicate=await QueryUpdateAsync(true,default);
            if(startup.GetProperty("status").GetString()!="available"||duplicate.GetProperty("status").GetString()!="already_checked"||handler.Calls!=startupBefore+1)throw new InvalidDataException("Startup update must query exactly once per process");
            await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (async()=>{const {checkStartupUpdate}=await import('./update-check.js');await checkStartupUpdate({host:document.body,language:document.documentElement.lang,check:async()=>({{startup.GetRawText()}}),open:()=>document.querySelector('[data-action=check-update]').click()})})()
                """);
            await Wait("Boolean(document.querySelector('.cloudig-update-notice'))");await Capture("startup-notice");
            await Pointer(".cloudig-update-notice .cloudig-button");await Wait("Boolean(document.querySelector('[data-update-status=available]'))&&!document.querySelector('[data-update-install]').hidden");await Capture("install-offer");await Pointer("[data-update-close]");
            handler.Scenario="no_release";
            await Pointer("[data-action=check-update]");await Wait("Boolean(document.querySelector('[data-update-status=no_release]'))");
            const string geometry="(()=>{const d=document.querySelector('.cloudig-update-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&document.querySelector('[data-action=check-update]').closest('[inert]')!==null&&[...d.querySelectorAll('footer .cloudig-button')].filter(b=>!b.hidden).every(b=>{const range=document.createRange();range.selectNodeContents(b);const t=range.getBoundingClientRect(),q=b.getBoundingClientRect();return t.left>=q.left-1&&t.right<=q.right+1&&t.top>=q.top-1&&t.bottom<=q.bottom+1})})()";
            await Wait(geometry);await Capture("no-release");
            handler.Scenario="available";await Pointer("[data-update-retry]");await Wait("Boolean(document.querySelector('[data-update-status=available]'))");await Wait(geometry);await Capture("available");
            var external=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            void CaptureExternal(object? sender,CoreWebView2NewWindowRequestedEventArgs e){e.Handled=true;if(e.IsUserInitiated)external.TrySetResult(e.Uri);else external.TrySetException(new InvalidDataException("Update link not user initiated"));}
            WebView.CoreWebView2.NewWindowRequested-=OnNewWindowRequested;WebView.CoreWebView2.NewWindowRequested+=CaptureExternal;
            try{await Pointer("[data-update-release]");if(await external.Task.WaitAsync(TimeSpan.FromSeconds(5))!=ReleaseUpdateClient.RepositoryUrl+"/releases")throw new InvalidDataException("Wrong release destination");}
            finally{WebView.CoreWebView2.NewWindowRequested-=CaptureExternal;WebView.CoreWebView2.NewWindowRequested+=OnNewWindowRequested;}
            handler.Scenario="unavailable";await Pointer("[data-update-retry]");await Wait("Boolean(document.querySelector('[data-update-status=unavailable]'))");await Wait(geometry);
            await Pointer("[data-update-close]");await Wait("!document.querySelector('.cloudig-update-dialog')&&!document.querySelector('[data-action=check-update]').closest('[inert]')");
            handler.Scenario="waiting";await Pointer("[data-action=check-update]");await Wait("Boolean(document.querySelector('[data-update-status=checking]'))");await Capture("checking");await Task.Delay(100);
            foreach(var type in new[]{"keyDown","keyUp"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type,key="Escape",code="Escape",windowsVirtualKeyCode=27}));
            await Wait("!document.querySelector('.cloudig-update-dialog')&&document.activeElement.matches('[data-action=check-update]')");
            for(var i=0;i<100&&!handler.Cancelled;i++)await Task.Delay(20);
            if(!handler.Cancelled||WebView.Source!=original)throw new InvalidDataException("Update cancellation or host preservation failed");
            if(!audit.Query.Contains("route=welcome",StringComparison.Ordinal))await VerifyAuthorContactAsync();
            TraceVisualAudit("update-check-pointer-roundtrip-passed","mock-http;startup-once;notice-real-pointer;install-offer;no-release;available;unavailable;cancelled;release-external;native-pointer;no-browser-launch");
        }
        finally{_releaseUpdates=production;}
    }
}
