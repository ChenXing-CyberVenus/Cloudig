using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private readonly List<string> _readingSavedResources = [];

    private async Task VerifyReadingFixesAsync(VisualAuditOptions audit)
    {
        async Task Capture(string suffix)
        {
            await using var output = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
        }
        var geometry = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const quotes=[...document.querySelectorAll('.cloudig-rich blockquote')];
              if(!quotes.length)throw new Error('Quote fixture missing');
              const facts=quotes.map(q=>({first:getComputedStyle(q.firstElementChild).marginTop,last:getComputedStyle(q.lastElementChild).marginBottom}));
              if(facts.some(f=>f.first!=='0px'||f.last!=='0px'))throw new Error('Quote keeps an extra edge paragraph margin');
              const font=getComputedStyle(document.querySelector('.cloudig-conversation-renderer')).fontSize;
              if(font!=='16px')throw new Error('Reader body type changed');
              quotes[0].scrollIntoView({block:'center',behavior:'instant'});
              return {font,quotes:facts,width:innerWidth,height:innerHeight};})()
            """);
        if (Math.Abs(WebView.ZoomFactor - 1) > .00001) throw new InvalidDataException("Window magnifies body text.");
        await Task.Delay(120); await Capture("quotes");
        var countRaw = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-message-user .cloudig-resource-save').length");
        if (!int.TryParse(countRaw, out var count) || count < 2) throw new InvalidDataException("User file/image save actions missing.");
        for (var index = 0; index < count; index++)
        {
            var selector = $"document.querySelectorAll('.cloudig-message-user .cloudig-resource-save')[{index}]";
            await WebView.CoreWebView2.ExecuteScriptAsync($"{selector}.scrollIntoView({{block:'center',behavior:'instant'}})");
            await Task.Delay(120);
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n={{selector}},r=n.getBoundingClientRect(),p=n.closest('.cloudig-attachment,.cloudig-image').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  if(n.disabled||!n.textContent.trim()||r.left<p.left-1||r.right>p.right+1||!n.contains(document.elementFromPoint(x,y)))throw new Error('Save action is hidden, clipped or covered');return {x,y};})()
                """);
            await Capture("attachment-" + index);
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = type == "mouseMoved" ? "none" : "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = type == "mouseMoved" ? 0 : 1 }));
            for (var n = 0; n < 200 && _readingSavedResources.Count <= index; n++) await Task.Delay(50);
            if (_readingSavedResources.Count <= index) throw new InvalidDataException("Save action did not reach the real resource writer.");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".reading-fixes.json"), JsonSerializer.Serialize(new { geometry = JsonSerializer.Deserialize<JsonElement>(geometry), zoom = WebView.ZoomFactor, saved = _readingSavedResources }));
        TraceVisualAudit("reading-fixes-passed", "quotes;16px body;user-file-and-image;pointer;real IPC;isolated destination instead of native dialog");
    }
}
