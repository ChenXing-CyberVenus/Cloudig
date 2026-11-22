using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Uses the actual packaged Reader, runtime resources and native pointer.
    // The caller provides an isolated real Library; no user data is changed.
    private async Task VerifyNativeDiagramsAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Capture(string suffix)
        {
            await using var file = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        }
        async Task Wait(string expression)
        {
            for (var n = 0; n < 300; n++) { if (await Read(expression) == "true") return; await Task.Delay(75); }
            await Capture("diagram-failed"); throw new InvalidDataException("Native diagrams: " + expression);
        }
        async Task Pointer(string selector)
        {
            var raw = await Read($$"""(()=>{const n=[...document.querySelectorAll({{JsonSerializer.Serialize(selector)}})].find(n=>n.getBoundingClientRect().width>0);if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()""");
            using var p = JsonDocument.Parse(raw);
            if (p.RootElement.ValueKind == JsonValueKind.Null) throw new InvalidDataException("Native diagram pointer obstructed: " + selector);
            var x = p.RootElement.GetProperty("x").GetDouble(); var y = p.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = type == "mouseMoved" ? "none" : "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = type == "mouseMoved" ? 0 : 1 }));
            await Task.Delay(150);
        }
        await Wait("document.querySelectorAll('.cloudig-diagram-display[data-native-theme]').length>0");
        var originalTheme = await Read("document.documentElement.dataset.theme");
        var total = int.Parse(await Read("document.querySelectorAll('.cloudig-diagram-display[data-native-theme]').length"));
        var rows = new List<JsonElement>();
        for (var pass = 0; pass < 2; pass++)
        {
            await Wait("[...document.querySelectorAll('.cloudig-diagram-display[data-native-theme]')].every(n=>n.dataset.nativeTheme===(document.documentElement.dataset.theme==='dawn'?'light':'dark')&&n.querySelector('img')?.complete&&n.querySelector('img')?.naturalWidth>0)");
            for (var index = 0; index < total; index++)
            {
                await Read($$"""(()=>{const d=document.querySelectorAll('.cloudig-diagram-display[data-native-theme]')[{{index}}],s=d.closest('[data-reader-conversation-scroll]');s.scrollTop+=d.getBoundingClientRect().top-s.getBoundingClientRect().top-70;return true;})()""");
                await Task.Delay(150); await Capture($"diagram-{pass}-{index + 1}");
            }
            var raw = await Read("[...document.querySelectorAll('.cloudig-diagram-display[data-native-theme]')].map(n=>{const i=n.querySelector('img');return{theme:n.dataset.nativeTheme,resource:n.dataset.nativeResource,src:i.src,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height}})");
            using (var p = JsonDocument.Parse(raw)) rows.Add(p.RootElement.Clone());
            if (pass == 0) { await Pointer("[data-action=toggle-theme]"); await Wait($"document.documentElement.dataset.theme!=={originalTheme}"); }
        }
        await Pointer("[data-action=toggle-theme]");
        await Wait($"document.documentElement.dataset.theme==={originalTheme}");
        await Wait("[...document.querySelectorAll('.cloudig-diagram-display[data-native-theme]')].every(n=>n.dataset.nativeTheme===(document.documentElement.dataset.theme==='dawn'?'light':'dark'))");
        for (var i = 0; i < total; i++) if (rows[0][i].GetProperty("resource").GetString() == rows[1][i].GetProperty("resource").GetString()) throw new InvalidDataException("Native theme did not switch resource");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".native-diagrams.json"), JsonSerializer.Serialize(rows));
        TraceVisualAudit("native-diagrams-passed", $"{{\"diagrams\":{total},\"themes\":2,\"native_pointer_roundtrip\":true}}");
    }
}
