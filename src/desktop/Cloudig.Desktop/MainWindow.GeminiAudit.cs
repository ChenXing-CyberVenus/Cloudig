using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Runs only in an owned visual-audit Library, after complete pagination.
    private async Task VerifyGeminiReviewAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Capture(string name)
        {
            await using var file = File.Create(Path.ChangeExtension(audit.OutputFile, name + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        }
        async Task Wait(string expression)
        {
            for (var n = 0; n < 400; n++) { if (await Read(expression) == "true") return; await Task.Delay(75); }
            await Capture("gemini-failed"); throw new InvalidDataException("Gemini review: " + expression);
        }
        async Task Pointer(string selector)
        {
            var quoted = JsonSerializer.Serialize(selector);
            await Read($$"""(()=>{const n=document.querySelector({{quoted}}),s=n?.closest('.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();s.scrollTop+=r.top-v.top-(v.height-r.height)/2;} })()""");
            await Task.Delay(150);
            using var point = JsonDocument.Parse(await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"""));
            if (point.RootElement.ValueKind == JsonValueKind.Null) { await Capture("gemini-obstructed"); throw new InvalidDataException("Gemini pointer obstructed: " + selector); }
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = type == "mouseMoved" ? "none" : "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = type == "mouseMoved" ? 0 : 1 }));
            await Task.Delay(150);
        }
        var hasCitations = await Read("Boolean(document.querySelector('.cloudig-document-citation-toggle'))") == "true";
        var hasTask = await Read("Boolean(document.querySelector('.cloudig-schedule-task'))") == "true";
        if (!hasCitations && !hasTask) throw new InvalidDataException("Gemini review needs real citations or a task sample");
        if (hasCitations)
        {
            await Read("(()=>{const g=[...document.querySelectorAll('.cloudig-document-citation')].find(g=>g.querySelectorAll(':scope > .cloudig-document-sources > .cloudig-document-source').length>1);g?.setAttribute('data-gemini-review','citation');})()");
            const string toggle = "[data-gemini-review=citation] > .cloudig-document-citation-toggle";
            await Pointer(toggle);
            await Wait("document.querySelector('[data-gemini-review=citation] > button')?.getAttribute('aria-expanded')==='true'&&[...document.querySelectorAll('[data-gemini-review=citation] > .cloudig-document-sources > .cloudig-document-source')].every(n=>n.getBoundingClientRect().height>0)");
            await Capture("gemini-citations-open");
            await Pointer(toggle); await Wait("document.querySelector('[data-gemini-review=citation] > .cloudig-document-sources')?.hidden===true");
            await Capture("gemini-citations-closed");
        }
        if (hasTask)
        {
            // Select a real top-level process. Expansion materializes its lazy
            // children; do not inspect an absent body and call it preserved.
            await Read("(()=>{const d=[...document.querySelectorAll('details.cloudig-process,details.cloudig-process-group')].find(d=>!d.parentElement.closest('details'));d?.setAttribute('data-gemini-review','process');})()");
            await Pointer("[data-gemini-review=process] > summary");
            await Wait("document.querySelector('[data-gemini-review=process]')?.open===true");
            await Capture("gemini-process-open");
            await Pointer("[data-gemini-review=process] > summary");
            await Wait("document.querySelector('[data-gemini-review=process]')?.open===false");
            await Pointer(".cloudig-schedule-task > summary");
            await Wait("document.querySelector('.cloudig-schedule-task')?.open===true&&Boolean(document.querySelector('.cloudig-schedule-meta dd'))");
            await Capture("gemini-schedule"); await Pointer(".cloudig-schedule-task > summary");
            await Read("(()=>{const b=[...document.querySelectorAll('.cloudig-resource-preview')].find(b=>/\\.docx/i.test(b.getAttribute('aria-label')??''));b?.setAttribute('data-gemini-review','document');})()");
            await Pointer("[data-gemini-review=document]");
            const string modal = ".cloudig-interactive-window:not(.cloudig-interactive-box)";
            await Wait($"document.querySelector('{modal}')?.dataset.state==='ready'");
            CoreWebView2Frame? documentFrame = null;
            for (var n = 0; n < 400; n++)
            {
                foreach (var frame in _savedWorkAuditFrames.Where(f => !_destroyedSavedWorkAuditFrames.Contains(f)).Reverse())
                    if (await frame.ExecuteScriptAsync("Boolean(document.querySelector('.office-docx-wrapper')?.textContent.trim().length>50)") == "true") { documentFrame = frame; break; }
                if (documentFrame is not null) break; await Task.Delay(75);
            }
            if (documentFrame is null) { await Capture("gemini-document-failed"); throw new InvalidDataException("Gemini cloud DOCX did not render actual text"); }
            await Capture("gemini-cloud-document"); await Pointer(modal + " .cloudig-interactive-close");
            await Wait($"!document.querySelector('{modal}')");
        }
        var facts = await Read("({citations:document.querySelectorAll('.cloudig-document-citation-toggle').length,members:document.querySelectorAll('[data-cloudig-reference]').length,tasks:[...document.querySelectorAll('.cloudig-schedule-task')].map(n=>({status:n.dataset.taskStatus,text:n.textContent})),errors:Number(document.documentElement.dataset.runtimeErrors??0)})");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".gemini-review.json"), facts);
        using var parsed = JsonDocument.Parse(facts);
        if (parsed.RootElement.GetProperty("errors").GetInt32() != 0) throw new InvalidDataException(facts);
        TraceVisualAudit("gemini-review-passed", facts);
    }
}
