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
            var script = $$"""
                (()=>{const n=document.querySelector({{query}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """;
            // Adjacent saved images/DIL may finish layout after the first
            // scroll. Wait for a stable real hit; never bypass it via click().
            var raw="null";var previous="";var stable=0;
            for(var attempt=0;attempt<40;attempt++)
            {
                if(!insideMap)await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    document.querySelector({{query}})?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})
                    """);
                await Task.Delay(120);
                raw=insideMap?await mapFrame!.ExecuteScriptAsync(script):await WebView.CoreWebView2.ExecuteScriptAsync(script);
                stable=raw!="null"&&raw==previous?stable+1:0;
                if(stable>=5)break;
                previous=raw;
            }
            if (raw == "null") {await Capture("map-obstructed");throw new InvalidDataException("Map control is obstructed: " + selector);}
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
        async Task WaitForMapDraw()
        {
            for(var i=0;i<600;i++)
            {
                if(await mapFrame!.ExecuteScriptAsync("document.documentElement.dataset.mapSettled==='true'")=="true")return;
                await Task.Delay(50);
            }
            await Capture("map-unsettled");
            throw new InvalidDataException("Map tiles/labels did not finish drawing after camera movement");
        }
        await Wait("Boolean(document.querySelector('.cloudig-box-map .cloudig-box-primary'))&&document.querySelector('.route-transition').hidden");
        if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-map-window'))") != "false")
            throw new InvalidDataException("Map started before a user click");
        WebView.CoreWebView2.FrameCreated += FrameCreated;
        try
        {
            await WebView.CoreWebView2.ExecuteScriptAsync("document.addEventListener('click',e=>{document.documentElement.dataset.mapAuditClick=e.target?.outerHTML?.slice(0,400)||'unknown';},{once:true,capture:true})");
            await Pointer(".cloudig-box-map .cloudig-box-primary");
            TraceVisualAudit("reader-map-entry-pointer",await WebView.CoreWebView2.ExecuteScriptAsync("({click:document.documentElement.dataset.mapAuditClick||'none',entry:document.querySelector('.cloudig-box-map .cloudig-box-primary')?.getBoundingClientRect().toJSON(),dialog:!!document.querySelector('.cloudig-map-window')})"));
            await Wait("Boolean(document.querySelector('.cloudig-map-window[data-state=ready]'))");
            if (mapFrame is null) throw new InvalidDataException("Map runtime frame was not created");
            var facts = await mapFrame.ExecuteScriptAsync("({origin:location.origin,ready:document.documentElement.dataset.mapReady,palette:document.documentElement.dataset.mapPalette,poiLayers:Number(document.documentElement.dataset.mapPoiLayers),theme:document.documentElement.dataset.theme,points:document.querySelectorAll('.cloudig-map-marker').length,attribution:document.querySelector('.maplibregl-ctrl-attrib')?.textContent})");
            using (var data = JsonDocument.Parse(facts))
            {
                if (data.RootElement.GetProperty("origin").GetString() != "https://cloudig-map.local" || data.RootElement.GetProperty("ready").GetString() != "true" || data.RootElement.GetProperty("points").GetInt32() < 1 || !data.RootElement.GetProperty("attribution").GetString()!.Contains("OpenStreetMap", StringComparison.Ordinal))
                    throw new InvalidDataException("Actual MapLibre frame or attribution is incomplete: " + facts);
                if(data.RootElement.GetProperty("palette").GetString()!=(data.RootElement.GetProperty("theme").GetString()=="star-night"?"star-night-complete-3":"provider-liberty")||data.RootElement.GetProperty("poiLayers").GetInt32()<1)throw new InvalidDataException("Map theme or landmark layers are incomplete: "+facts);
            }
            await WaitForMapDraw();
            await Capture("map-overview");
            if(await mapFrame.ExecuteScriptAsync("getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib')).backgroundColor===getComputedStyle(document.body).backgroundColor")!="true")throw new InvalidDataException("Map attribution retained an unthemed bright background");
            await Pointer("#places button", true);
            await Pointer(".maplibregl-ctrl-zoom-in", true);
            await WaitForMapDraw();
            if (await mapFrame.ExecuteScriptAsync("Boolean(document.querySelector('.maplibregl-popup-content strong'))") != "true")
                throw new InvalidDataException("Map place pointer did not open its saved detail");
            await Capture("map-open");
            // The theme includes zoom-dependent road names and building detail.
            // Inspect both street detail and a wider view, not only first paint.
            await Pointer(".maplibregl-ctrl-zoom-in", true);
            await WaitForMapDraw();
            await Capture("map-street");
            for(var step=0;step<2;step++)await Pointer(".maplibregl-ctrl-zoom-in",true);
            await WaitForMapDraw();
            await Pointer(".maplibregl-popup-close-button",true);
            await Capture("map-landmarks");
            for(var step=0;step<5;step++)await Pointer(".maplibregl-ctrl-zoom-out",true);
            await WaitForMapDraw();
            await Capture("map-region");
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
