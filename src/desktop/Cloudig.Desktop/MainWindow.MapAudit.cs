using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifySavedMapAsync(VisualAuditOptions audit)
    {
        CoreWebView2Frame? mapFrame = null;
        var destroyed = false;
        void FrameCreated(object? sender, CoreWebView2FrameCreatedEventArgs args)
        {
            mapFrame = args.Frame;
            args.Frame.Destroyed += (_, _) => destroyed = true;
        }
        async Task Capture(string suffix)
        {
            await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        async Task Wait(string expression)
        {
            for (var i = 0; i < 800; i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-map-window[data-state=failed]'))") == "true") break;
                await Task.Delay(50);
            }
            await Capture("map-failed");
            throw new InvalidDataException("Saved map state failed: " + expression);
        }
        async Task Pointer(string selector, bool insideMap = false)
        {
            var query = JsonSerializer.Serialize(selector);
            if (!insideMap)
                await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const n=document.querySelector({{query}}),s=n?.closest('.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();s.scrollTop+=r.top-v.top-(v.height-r.height)/2;} })()
                    """);
            await Task.Delay(100);
            var script = $$"""
                (()=>{const n=document.querySelector({{query}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """;
            var raw = insideMap ? await mapFrame!.ExecuteScriptAsync(script) : await WebView.CoreWebView2.ExecuteScriptAsync(script);
            if (raw == "null") throw new InvalidDataException("Map control is obstructed: " + selector);
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            if (insideMap)
            {
                using var rect = JsonDocument.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('.cloudig-map-window iframe'),r=n.getBoundingClientRect();return{x:r.x,y:r.y};})()"));
                x += rect.RootElement.GetProperty("x").GetDouble(); y += rect.RootElement.GetProperty("y").GetDouble();
            }
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        }
        await Wait("Boolean(document.querySelector('.cloudig-box-map .cloudig-box-primary'))&&document.querySelector('.route-transition').hidden");
        if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-map-window'))") != "false")
            throw new InvalidDataException("Map started before a user click");
        WebView.CoreWebView2.FrameCreated += FrameCreated;
        try
        {
            await Pointer(".cloudig-box-map .cloudig-box-primary");
            await Wait("Boolean(document.querySelector('.cloudig-map-window[data-state=ready]'))");
            if (mapFrame is null) throw new InvalidDataException("Map runtime frame was not created");
            var facts = await mapFrame.ExecuteScriptAsync("({origin:location.origin,ready:document.documentElement.dataset.mapReady,theme:document.documentElement.dataset.theme,points:document.querySelectorAll('.cloudig-map-marker').length,attribution:document.querySelector('.maplibregl-ctrl-attrib')?.textContent})");
            using (var data = JsonDocument.Parse(facts))
                if (data.RootElement.GetProperty("origin").GetString() != "https://cloudig-map.local" || data.RootElement.GetProperty("ready").GetString() != "true" || data.RootElement.GetProperty("points").GetInt32() < 1 || !data.RootElement.GetProperty("attribution").GetString()!.Contains("OpenStreetMap", StringComparison.Ordinal))
                    throw new InvalidDataException("Actual MapLibre frame or attribution is incomplete: " + facts);
            await Pointer("#places button", true);
            await Pointer(".maplibregl-ctrl-zoom-in", true);
            await Task.Delay(650);
            if (await mapFrame.ExecuteScriptAsync("Boolean(document.querySelector('.maplibregl-popup-content strong'))") != "true")
                throw new InvalidDataException("Map place pointer did not open its saved detail");
            await Capture("map-open");
            await Pointer(".cloudig-map-window .cloudig-interactive-close");
            await Wait("!document.querySelector('.cloudig-map-window')");
            for (var i = 0; i < 100 && !destroyed; i++) await Task.Delay(20);
            if (!destroyed) throw new InvalidDataException("Closing map did not destroy the native frame");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".map.json"), facts);
            TraceVisualAudit("reader-saved-map-pointer-passed", "real saved record; click-only network map; place/zoom pointer; attribution; native frame destroyed on close");
        }
        finally { WebView.CoreWebView2.FrameCreated -= FrameCreated; }
    }
}
