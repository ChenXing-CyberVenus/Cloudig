using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task VerifyFeaturesDocumentAsync(VisualAuditOptions audit)
    {
        async Task Wait(string expression) { for(var i=0;i<200;i++){if(await WebView.CoreWebView2.ExecuteScriptAsync(expression)=="true")return;await Task.Delay(50);}throw new TimeoutException("Feature guide: "+expression); }
        async Task Check(string expression,string message){if(await WebView.CoreWebView2.ExecuteScriptAsync(expression)!="true")throw new InvalidDataException(message);}
        async Task Capture(string id){await using var s=File.Create(Path.ChangeExtension(audit.OutputFile,id+".png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,s);}
        async Task Pointer(string selector){
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const s=n.closest('.standard-nav-panel nav,.standard-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top||r.bottom>v.bottom)s.scrollTop+=r.top-v.top-8;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(24,r.height/2);return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if(raw=="null")throw new InvalidDataException("Feature guide pointer covered: "+selector);using var p=JsonDocument.Parse(raw);var x=p.RootElement.GetProperty("x").GetDouble();var y=p.RootElement.GetProperty("y").GetDouble();
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));await Task.Delay(100);
        }
        const string ready="Boolean(document.querySelector('.feature-document[data-document-ready=true]'))";
        const string images="[...document.querySelectorAll('.feature-crop img')].filter(i=>{const r=i.getBoundingClientRect(),v=i.closest('.standard-scroll').getBoundingClientRect();return r.width&&r.bottom>v.top&&r.top<v.bottom}).every(i=>i.complete&&i.naturalWidth>0)";
        const string geometry="(()=>{const d=document.querySelector('.feature-document'),s=d.querySelector('.standard-scroll'),b=d.querySelector('.standard-bar');return s.scrollWidth<=s.clientWidth+1&&Math.abs(s.getBoundingClientRect().top-b.getBoundingClientRect().bottom)<2&&[...d.querySelectorAll('td,p')].filter(n=>n.closest('.feature-prose')&&!n.closest('figcaption')).every(n=>getComputedStyle(n).fontSize==='16px')})()";
        const string usefulZoom="[...document.querySelectorAll('[data-feature-figure]')].every(f=>{const b=f.querySelector('.feature-zoom');if(!b)return true;if(f.classList.contains('feature-enlarged'))return !b.hidden;const useful=[...f.querySelectorAll('.feature-crop img')].some(i=>{const r=i.getBoundingClientRect();return i.complete&&i.naturalWidth>0&&r.width>0&&r.height>0&&Math.max(i.naturalWidth/r.width,i.naturalHeight/r.height)>=1.12&&Math.max(i.naturalWidth-r.width,i.naturalHeight-r.height)>=24;});return b.hidden===!useful;})";
        const string sidebarGeometry="JSON.stringify([...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))";
        var fromWelcome=audit.Query.Contains("route=welcome",StringComparison.Ordinal);
        var before=await WebView.CoreWebView2.ExecuteScriptAsync(sidebarGeometry);
        await Pointer(fromWelcome?"[data-action=open-docs]":"[data-doc-topic=archive]");await Wait(ready);await Wait(images);
        if(fromWelcome){await Check("Boolean(document.querySelector('[data-page=archiver] .feature-document'))&&!document.querySelector('[data-page=reader]')","Welcome documentation must open inside Archiver");before=await WebView.CoreWebView2.ExecuteScriptAsync(sidebarGeometry);}
        await Check(geometry,"Feature guide overflow, fixed bar or body typography failed");await Capture("opening");
        await Wait(usefulZoom);await Check("document.querySelector('[data-feature-figure=\"01-welcome\"] .feature-zoom').hidden","Unscaled welcome crop still has a meaningless zoom button");
        if(audit.Width>1440){
            var smaller=audit with {Width=1440,Height=900};
            await MatchVisualAuditViewportAsync(smaller);await WaitForVisualAuditReadyAsync(smaller);await Wait(usefulZoom);
            await MatchVisualAuditViewportAsync(audit);await WaitForVisualAuditReadyAsync(audit);await Wait(usefulZoom);
        }
        await Check("document.querySelectorAll('[data-feature-figure]').length===17&&document.querySelectorAll('.feature-region-map').length===1","Feature guide omitted figure slots");
        await Pointer("[data-standard-menu=important]");await Check("[...document.querySelectorAll('[data-feature-section][data-infovalue=important]')].every(n=>n.querySelector(':scope>.standard-section-body').hidden)","Feature category did not fold");
        await Pointer("[data-standard-menu=all]");await Pointer(".standard-nav-panel a[href='#features-6-1']");await Wait(images);await Check("document.activeElement.id==='features-6-1'&&!document.activeElement.closest('[hidden]')","TOC failed to reveal a folded parent");await Check(geometry,"Time instructions overflowed");await Capture("content-time");
        await Wait(usefulZoom);await Pointer("[data-feature-figure='10-content-time-edit'] .feature-zoom");await Check("Boolean(document.querySelector('[data-feature-figure=\"10-content-time-edit\"].feature-enlarged'))","Inline crop enlargement failed");await Wait(usefulZoom);await Check(geometry,"Enlarged screenshot escaped the document");await Capture("enlarged-detail");await Pointer("[data-feature-figure='10-content-time-edit'] .feature-zoom");await Wait(usefulZoom);
        await Pointer("[data-standard-menu=all]");await Pointer(".standard-nav-panel a[href='#features-3-4']");await Wait(images);await Capture("parse-settings");
        await Pointer("[data-action=toggle-theme]");await Wait(images);await Wait(usefulZoom);await Check(geometry,"Theme switch changed document layout");await Capture("opposite-theme");await Pointer("[data-action=toggle-theme]");await Wait(images);await Wait(usefulZoom);
        var originalLanguage=await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang");
        await Pointer("[data-action=toggle-language]");await Wait($"document.documentElement.lang!=={originalLanguage}");await Wait(images);await Wait(usefulZoom);await Capture("opposite-language");
        await Pointer("[data-action=toggle-language]");await Wait($"document.documentElement.lang==={originalLanguage}");await Wait(images);await Wait(usefulZoom);
        await Pointer(".standard-return");await Check("!document.querySelector('.feature-document')","Return did not restore center");
        if(fromWelcome)await Check("Boolean(document.querySelector('[data-page=archiver] .archiver-center'))","Closing Welcome documentation must keep Archiver");
        await Check($"JSON.stringify([...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}}))==={before}","Document changed the host sidebars");
        TraceVisualAudit("features-document-pointer-roundtrip-passed");
    }
}
