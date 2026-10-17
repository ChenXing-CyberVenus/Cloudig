using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyDocumentRefinementsAsync(VisualAuditOptions audit)
    {
        async Task Capture(string suffix) { await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream); }
        async Task Check(string expression, string message) { if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return; await Capture("failed"); throw new InvalidDataException(message); }
        async Task Wait(string expression) { for (var i=0;i<180;i++) { if (await WebView.CoreWebView2.ExecuteScriptAsync(expression)=="true") return; await Task.Delay(50); } throw new TimeoutException(expression); }
        async Task Scroll(string selector)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),s=n.closest('.standard-scroll');s.scrollTop+=n.getBoundingClientRect().top-s.getBoundingClientRect().top-24;})()
                """);
            await Task.Delay(70);
        }
        async Task Pointer(string selector)
        {
            await Wait("document.querySelector('.route-transition').hidden");
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const s=n.closest('.standard-nav-panel nav,.standard-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8||r.bottom>v.bottom-8)s.scrollTop+=r.top-v.top-24;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,22);return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if(raw=="null") {await Capture("obstructed");throw new InvalidDataException("Document pointer obstructed: "+selector);}
            using var point=JsonDocument.Parse(raw);var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseMoved",x,y}));
            foreach(var type in new[]{"mousePressed","mouseReleased"}) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
            await Task.Delay(80);
        }
        await Check("[...document.querySelector('[data-doc-topic=bookmark]').closest('ul').querySelectorAll('[data-doc-topic]')].map(n=>n.dataset.docTopic).join(',')==='bookmark,archive,platforms,json,roadmap,license'", "Documentation sidebar order changed");
        await Pointer("[data-doc-topic=bookmark]");
        await Wait("Boolean(document.querySelector('[data-platform-directory]'))");
        await Check("!document.querySelector('[data-platform-directory]').open&&document.querySelector('[data-platform-directory] tbody').children.length===12", "Official directory must start collapsed without losing entries");
        await Scroll("[data-platform-directory]");
        await Capture("directory-closed");
        await Pointer("[data-platform-directory] > summary");
        await Check("document.querySelector('[data-platform-directory]').open&&document.querySelector('.standard-scroll').scrollWidth<=document.querySelector('.standard-scroll').clientWidth+1", "Official directory did not unfold in its own themed container");
        await Capture("directory-open");
        var language=await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang");
        await Pointer("[data-action=toggle-language]"); await Wait($"document.documentElement.lang!=={language}");
        await Check("document.querySelector('[data-platform-directory]').open", "Language switch lost directory disclosure state");
        await Pointer("[data-action=toggle-language]"); await Wait($"document.documentElement.lang==={language}");
        await Pointer("[data-platform-directory] > summary");
        await Check("document.querySelector('#bookmark-section-1').dataset.infovalue==='core'&&document.querySelector('#bookmark-section-1 h2 img').src.endsWith('InfoValue-Core.svg')", "Shortest guide must carry Core value and icon");
        await Pointer("[data-standard-menu=important]");
        await Check("!document.querySelector('#bookmark-section-1-body').hidden", "Important folding must not hide the Core guide");
        await Pointer("[data-standard-menu=core]");
        await Check("document.querySelector('#bookmark-section-1-body').hidden", "Core folding must include the shortest guide");
        await Pointer("[data-standard-menu=core]");
        await Scroll("#bookmark-section-1"); await Capture("quick-start-core");
        await Pointer("[data-doc-topic=json]"); await Wait("Boolean(document.querySelector('[data-standard-layout=sovereign]'))");
        await Check("document.querySelectorAll('[data-standard-flow=nodes]>br').length===2", "Node, mapping and ordinal statements must start on separate lines");
        await Check("(()=>{const d=document.querySelector('.standard-document'),s=d.querySelector('[data-standard-layout=sovereign]');return !d.querySelector('.standard-reading-hint')&&[...s.children].map(n=>n.tagName).join(',')==='UL,P,UL,P,P'&&[...s.querySelectorAll('ul')].every(n=>n.children.length===2)&&s.querySelectorAll('li>strong').length===4&&s.querySelector('.standard-time-boundary>strong>br')&&d.querySelector('[data-standard-flow=nodes]>br')&&d.querySelector('[data-standard-flow=identity]>br')&&d.querySelectorAll('[data-standard-flow=identity]>strong').length===5&&d.querySelector('[data-standard-flow=presets]>strong')&&!/[:：]$/.test(d.querySelector('[data-standard-flow=presets]').textContent)&&getComputedStyle(d.querySelector('.standard-prose')).fontSize==='16px';})()", "Requested Standard paragraphs, lists or emphasis regressed");
        foreach(var item in new[]{("[data-standard-flow=nodes]","nodes"),("[data-standard-flow=presets]","presets"),("[data-standard-layout=sovereign]","sovereign"),("[data-standard-flow=identity]","identity")})
        {
            await Scroll(item.Item1); await Capture(item.Item2);
        }
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#standard-5']");
        await Check("!document.querySelector('#standard-5>.standard-section-body').hidden&&document.querySelector('.standard-scroll').scrollWidth<=document.querySelector('.standard-scroll').clientWidth+1", "TOC or local scroll ownership changed");
        await Pointer(".standard-return"); await Check("!document.querySelector('.standard-document')", "Document return failed");
        await Pointer("[data-doc-topic=json]"); await Wait("Boolean(document.querySelector('[data-standard-layout=sovereign]'))");
        await Scroll("[data-standard-layout=sovereign]");
        TraceVisualAudit("document-refinements-pointer-passed","official directory collapse and language persistence; Standard line breaks, paired lists, emphasis, unchanged 16px copy; TOC and central return");
    }
}
