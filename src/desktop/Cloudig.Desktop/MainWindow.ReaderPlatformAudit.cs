using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyReaderPlatformSelectionAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string js)=>await WebView.CoreWebView2.ExecuteScriptAsync(js);
        async Task Wait(string js)
        {
            for(var i=0;i<150;i++){if(await Read(js)=="true")return;await Task.Delay(50);}
            throw new InvalidDataException("Reader platform selection: "+js);
        }
        async Task Click(string selector)
        {
            using var data=JsonDocument.Parse(await Read($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const r=n.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()
                """));
            if(data.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Platform control is obstructed: "+selector);
            var x=data.RootElement.GetProperty("x").GetDouble();var y=data.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseMoved",x,y}));
            await Wait($$"""(()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});return n.contains(document.elementFromPoint({{x}},{{y}}))})()""");
            foreach(var type in new[]{"mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",clickCount=1}));
        }
        async Task Capture(string state){await Task.Delay(180);await using var file=File.Create(Path.ChangeExtension(audit.OutputFile,$".platform-{state}.png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);}
        const string all="[data-reader-platform-all]",toggle="[data-reader-platform-toggle]";
        string Platform(string id)=>$"[data-reader-platforms] [data-platform='{id}']";
        async Task Check(string[] platforms,bool hasRows)
        {
            var expected=JsonSerializer.Serialize(platforms.OrderBy(x=>x));
            await Wait($$"""
                (()=>{const expected={{expected}},buttons=[...document.querySelectorAll('[data-reader-platforms] [data-platform]')];return JSON.stringify(buttons.filter(n=>n.getAttribute('aria-pressed')==='true').map(n=>n.dataset.platform).sort())===JSON.stringify((expected.length?expected:buttons.map(n=>n.dataset.platform)).sort())&&document.querySelector('[data-reader-platform-all]').getAttribute('aria-pressed')==={{JsonSerializer.Serialize(platforms.Length==0?"true":"false")}}&&Boolean(document.querySelector('[data-reader-list] .reader-row-open'))==={{(hasRows?"true":"false")}}})()
                """);
        }
        if(await Read("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'")=="true")await Click("[data-reader-catalog-toggle=expand]");
        await Check([],true);await Capture("all");
        await Click(Platform("chatgpt"));await Check(["chatgpt"],true);
        await Click(Platform("claude"));await Check(["chatgpt","claude"],true);await Capture("multiple");
        await Click(Platform("chatgpt"));await Check(["claude"],false);
        await Click(Platform("claude"));await Check([],true);
        await Click(Platform("codex"));await Check(["codex"],false);
        await Click(toggle);await Check(["codex"],false);await Capture("collapsed");
        await Click(all);await Check([],true);
        await Wait("document.querySelector('[data-page=reader]').dataset.platformFilterCollapsed==='true'");
        await Click(toggle);await Check([],true);
        await Wait("(()=>{const expected=document.documentElement.dataset.theme==='star-night'?'rgb(81, 37, 165)':'rgb(165, 37, 37)';return [...document.querySelectorAll('[data-reader-platforms] button')].every(n=>getComputedStyle(n,'::before').borderTopColor===expected)})()");
        var geometry=await Read("""
            (()=>{const a=document.querySelector('[data-reader-platform-all]'),t=document.querySelector('[data-reader-platform-toggle]'),ar=a.getBoundingClientRect(),tr=t.getBoundingClientRect(),r=a.parentElement.getBoundingClientRect(),icons=[...document.querySelectorAll('[data-reader-platforms] button')].map(n=>n.getBoundingClientRect());return {label:a.textContent,allLeft:ar.left,allRight:ar.right,toggleLeft:tr.left,toggleRight:tr.right,railLeft:r.left,railRight:r.right,toggleCenterError:Math.abs((tr.left+tr.right-r.left-r.right)/2),icons:icons.length,accessible:!a.closest('[aria-hidden=true]'),background:getComputedStyle(a).backgroundColor,color:getComputedStyle(a).color}})()
            """);
        using(var g=JsonDocument.Parse(geometry)){var v=g.RootElement;if(!v.GetProperty("accessible").GetBoolean()||v.GetProperty("allRight").GetDouble()>=v.GetProperty("toggleLeft").GetDouble()||v.GetProperty("allLeft").GetDouble()<v.GetProperty("railLeft").GetDouble()||v.GetProperty("toggleCenterError").GetDouble()>1)throw new InvalidDataException("Platform rail layout: "+geometry);}
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".platform-selection.json"),geometry);
        TraceVisualAudit("reader-platform-selection-passed");
    }
}
