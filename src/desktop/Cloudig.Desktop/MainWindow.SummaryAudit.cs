using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifySummarySequencesAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Check(string script)
        {
            for (var n = 0; n < 200; n++) { if (await Read(script) == "true") return; await Task.Delay(50); }
            throw new InvalidDataException("Summary sequence: " + script);
        }
        async Task Point(string selector)
        {
            var quoted = JsonSerializer.Serialize(selector);
            // The Reader uses smooth user scrolling. Pointer evidence must
            // wait for its exact target instead of sampling an in-flight rect.
            var pointJson = "null";
            for (var attempt = 0; attempt < 12 && pointJson == "null"; attempt++)
            {
                // Captured images above the target can finish decoding after
                // page-ready and move it. Re-resolve, never click stale pixels.
                await Read($$"""(()=>{const n=document.querySelector({{quoted}}),s=n?.closest('.reader-conversation-scroll');if(s&&n){const a=n.getBoundingClientRect(),b=s.getBoundingClientRect();s.scrollTo({top:s.scrollTop+a.top-b.top-40,behavior:'instant'});} })()""");
                await Task.Delay(250);
                pointJson = await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+Math.min(60,r.width/2),y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()""");
            }
            using var point = JsonDocument.Parse(pointJson);
            if (point.RootElement.ValueKind == JsonValueKind.Null)
            {
                var miss = await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(!n)return {missing:true};const r=n.getBoundingClientRect(),x=r.left+Math.min(60,r.width/2),y=r.top+r.height/2;return {rect:r.toJSON(),cover:document.elementFromPoint(x,y)?.outerHTML.slice(0,400)};})()""");
                await using var preview = File.Create(Path.ChangeExtension(audit.OutputFile, ".summary-obstructed.png"));
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, preview);
                throw new InvalidDataException("Summary control is covered: " + selector + " " + miss);
            }
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", clickCount = 1 }));
            await Task.Delay(150);
        }
        await Check("document.querySelector('.route-transition').hidden&&Boolean(document.querySelector('.cloudig-summary-sequence'))");
        var ancestors = int.Parse(await Read("(()=>{const g=document.querySelector('.cloudig-summary-sequence');g.dataset.summaryAudit='';const a=[];for(let p=g.parentElement.closest('details');p;p=p.parentElement.closest('details'))a.unshift(p);a.forEach((p,i)=>p.dataset.summaryAncestor=String(i));return a.length;})()"));
        for (var n = 0; n < ancestors; n++)
            if (await Read($"document.querySelector('[data-summary-ancestor=\"{n}\"]').open") != "true") await Point($"[data-summary-ancestor='{n}'] > summary");
        if (await Read("document.querySelector('[data-summary-audit]').open") != "true") await Point("[data-summary-audit] > summary");
        await Check("[...document.querySelector('[data-summary-audit]').querySelectorAll('.cloudig-summary-entry')].every(n=>n.textContent.trim()||n.querySelector('img,svg,math'))");
        var facts = await Read("(()=>{const g=document.querySelector('[data-summary-audit]'),list=document.querySelector('.cloudig-message-list'),rail=getComputedStyle(list,'::before'),axis=list.getBoundingClientRect().left+parseFloat(rail.left)+parseFloat(rail.width)/2,s=getComputedStyle(g,'::before'),dot=g.getBoundingClientRect().left+parseFloat(s.left)+parseFloat(s.width)/2;return {open:g.open,entries:g.querySelectorAll('.cloudig-summary-entry').length,individualToggles:g.querySelectorAll('.cloudig-summary-entry > details').length,allReadable:[...g.querySelectorAll('.cloudig-summary-entry')].every(n=>n.getBoundingClientRect().height>0),overflow:g.scrollWidth-g.clientWidth,axisError:Math.abs(dot-axis),color:getComputedStyle(g.querySelector('.cloudig-fold-body')).color,bodyColor:getComputedStyle(list).color,anchors:[...g.querySelectorAll('[id]')].map(n=>n.id),crossMessage:g.classList.contains('cloudig-summary-message-fold')};})()");
        using (var result = JsonDocument.Parse(facts))
        {
            var value = result.RootElement;
            if (!value.GetProperty("open").GetBoolean() || value.GetProperty("entries").GetInt32() < 2 || value.GetProperty("individualToggles").GetInt32() != 0 || !value.GetProperty("allReadable").GetBoolean() || value.GetProperty("overflow").GetDouble() > 1 || value.GetProperty("axisError").GetDouble() > .2 || value.GetProperty("color").GetString() == value.GetProperty("bodyColor").GetString())
                throw new InvalidDataException("Summary layout mismatch: " + facts);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".summaries.json"), facts);
        await using (var output = File.Create(Path.ChangeExtension(audit.OutputFile, ".summaries-expanded.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
        await Point("[data-summary-audit] > summary");
        await Check("!document.querySelector('[data-summary-audit]').open");
        await Point("[data-summary-audit] > summary");
        await Check("document.querySelector('[data-summary-audit]').open");
        TraceVisualAudit("reader-summary-sequence-pointer-passed", facts);
        await VerifyReaderBranchRoundtripAsync(audit);
    }
}
