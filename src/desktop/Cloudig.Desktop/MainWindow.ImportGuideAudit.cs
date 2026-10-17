using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task VerifyPlatformImportGuideAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Check(string script)
        {
            for (var n = 0; n < 100; n++) { if (await Read(script) == "true") return; await Task.Delay(50); }
            throw new InvalidDataException("Platform guide: " + script);
        }
        async Task Point(string selector)
        {
            var quoted = JsonSerializer.Serialize(selector);
            await Read($$"""document.querySelector({{quoted}})?.scrollIntoView({block:'center',behavior:'instant'})""");
            await Task.Delay(100);
            var raw = await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()""");
            if (raw == "null") throw new InvalidDataException("Guide control covered: " + selector);
            using var point = JsonDocument.Parse(raw); var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(160);
        }
        async Task Capture(string suffix)
        {
            await using var output = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
        }
        await Check("document.querySelectorAll('[data-json-help]').length===6&&!document.querySelector('button button')&&!document.querySelector('[data-json-help=codex]')");
        var original = WebView.Source;
        var expected = new Dictionary<string, (string url, int figures)> {
            ["deepseek"] = ("https://chat.deepseek.com/", 4), ["qwen"] = ("https://chat.qwen.ai/", 2),
            ["mistral"] = ("https://chat.mistral.ai/", 3), ["grok"] = ("https://grok.com/", 5), ["claude"] = ("https://claude.ai/", 9), ["chatgpt"] = ("https://privacy.openai.com/", 4)
        };
        var facts = new List<object>();
        foreach (var entry in expected)
        {
            await Point($"[data-json-help='{entry.Key}']");
            await Check($"document.querySelector('[data-import-guide]')?.dataset.importGuide==='{entry.Key}'");
            await Check($"document.querySelectorAll('.archiver-guide-image img').length==={entry.Value.figures}&&[...document.querySelectorAll('.archiver-guide-image img')].every(n=>n.complete&&n.naturalWidth>0)");
            await Check("(()=>{const n=document.querySelector('[data-import-guide]'),r=n.getBoundingClientRect(),s=document.querySelector('[data-guide-scroll]');return r.top>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth&&n.scrollWidth<=n.clientWidth+1&&s.scrollWidth<=s.clientWidth+1&&getComputedStyle(s).fontSize==='16px'&&[...s.querySelectorAll('img')].every(i=>{const b=i.getBoundingClientRect();return b.width<=i.naturalWidth+.5&&Math.abs(b.height-b.width*i.naturalHeight/i.naturalWidth)<1;});})()");
            await Capture("guide-" + entry.Key);
            var requested = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            void External(object? sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; if (e.IsUserInitiated) requested.TrySetResult(e.Uri); }
            WebView.CoreWebView2.NewWindowRequested -= OnNewWindowRequested; WebView.CoreWebView2.NewWindowRequested += External;
            try { await Point("[data-guide-website]"); if (await requested.Task.WaitAsync(TimeSpan.FromSeconds(5)) != entry.Value.url || WebView.Source != original) throw new InvalidDataException("Guide link did not stay external"); }
            finally { WebView.CoreWebView2.NewWindowRequested -= External; WebView.CoreWebView2.NewWindowRequested += OnNewWindowRequested; }
            await Point("[data-guide-zoom]");
            await Check("document.querySelector('[data-guide-lightbox]')?.open&&document.querySelector('[data-guide-lightbox]')===document.querySelector(':modal')");
            if (entry.Key == "claude") await Capture("guide-zoom");
            foreach (var type in new[] { "keyDown", "keyUp" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key = "Escape", code = "Escape", windowsVirtualKeyCode = 27 }));
            await Check("!document.querySelector('[data-guide-lightbox]')&&document.activeElement.matches('[data-guide-zoom]')");
            if (entry.Key == "claude")
            {
                var initial = await Read("JSON.stringify({top:document.querySelector('.archiver-guide-heading').getBoundingClientRect().top,scroll:document.querySelector('[data-guide-scroll]').scrollTop})");
                var geometry = await Read("(()=>{const s=document.querySelector('[data-guide-scroll]'),r=s.getBoundingClientRect();return {x:r.right-4,y:r.top+25,bottom:r.bottom-25};})()");
                using var g = JsonDocument.Parse(geometry); var x = g.RootElement.GetProperty("x").GetDouble(); var y = g.RootElement.GetProperty("y").GetDouble(); var bottom = g.RootElement.GetProperty("bottom").GetDouble();
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
                await Task.Delay(200);
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 }));
                for (var i = 1; i <= 6; i++) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y = y + (bottom - y) * i / 6, button = "left", buttons = 1 }));
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseReleased", x, y = bottom, button = "left", buttons = 0, clickCount = 1 }));
                await Task.Delay(200);
                await Check("document.querySelector('[data-guide-scroll]').scrollTop>100");
                var after = await Read("JSON.stringify({top:document.querySelector('.archiver-guide-heading').getBoundingClientRect().top,scroll:document.querySelector('[data-guide-scroll]').scrollTop})");
                var initialData = JsonDocument.Parse(JsonSerializer.Deserialize<string>(initial)!); var afterData = JsonDocument.Parse(JsonSerializer.Deserialize<string>(after)!);
                if (initialData.RootElement.GetProperty("top").GetDouble() != afterData.RootElement.GetProperty("top").GetDouble()) throw new InvalidDataException("Guide header scrolled away");
                await Capture("guide-scrolled");
                await Point("[data-guide-platform=qwen]"); await Check("document.querySelector('[data-import-guide]').dataset.importGuide==='qwen'");
                await Point("[data-guide-platform=claude]"); await Check("document.querySelector('[data-guide-scroll]').scrollTop>100");
            }
            facts.Add(new { platform = entry.Key, figures = entry.Value.figures, external = entry.Value.url });
            await Point("[data-guide-back]");
            await Check($"!document.querySelector('[data-import-guide]')&&document.activeElement.dataset.jsonHelp==='{entry.Key}'");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".guide.json"), JsonSerializer.Serialize(facts));
        TraceVisualAudit("platform-import-guide-pointer-passed", "6 platforms, 27 images, external links, modal Escape, fixed header, scrollbar drag, return focus");
    }
}
