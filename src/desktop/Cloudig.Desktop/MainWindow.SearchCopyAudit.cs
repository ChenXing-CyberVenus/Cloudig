using System.IO;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifySearchCopyAsync(VisualAuditOptions audit)
    {
        using var input = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "search-audit-input.json")));
        var spec = input.RootElement; var query = spec.GetProperty("query").GetString()!;
        var expectations = spec.GetProperty("expected").GetProperty(audit.Query.Contains("language=en", StringComparison.Ordinal) ? "en" : "zh-CN");
        var anchor = spec.GetProperty("anchor").GetString()!;
        var previousClipboard = Clipboard.GetDataObject(); string? lastCopied = null;
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Capture(string suffix) {
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", "{\"expression\":\"new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))\",\"awaitPromise\":true}");
            var geometry = await Read("[...document.querySelectorAll('.cloudig-content-search,.cloudig-markdown-dialog')].map(n=>({class:n.className,scroll:n.scrollTop,client:n.clientHeight,total:n.scrollHeight,children:[...n.children].map(c=>({tag:c.tagName,class:c.className,top:c.getBoundingClientRect().top,height:c.getBoundingClientRect().height,scroll:c.scrollTop,opacity:getComputedStyle(c).opacity,visibility:getComputedStyle(c).visibility}))}))");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, suffix + ".layout.json"), geometry);
            await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        async Task Check(string expression)
        {
            for (var i = 0; i < 240; i++) { if (await Read(expression) == "true") return; await Task.Delay(50); }
            await Capture("search-failed"); throw new InvalidDataException("Search/copy audit failed: " + expression);
        }
        async Task Point(string selector, bool click = true)
        {
            var quoted = JsonSerializer.Serialize(selector);
            await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(n&&!n.closest('.cloudig-search-actions'))n.scrollIntoView({block:'nearest',inline:'nearest'});})()""");
            await Task.Delay(90);
            using var pos = JsonDocument.Parse(await Read($$"""(()=>{const n=document.querySelector({{quoted}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+Math.min(r.width/2,100),y=r.top+Math.min(r.height/2,20);return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"""));
            if (pos.RootElement.ValueKind == JsonValueKind.Null) { await Capture("search-covered"); throw new InvalidDataException("Search/copy target is covered: " + selector); }
            var x = pos.RootElement.GetProperty("x").GetDouble(); var y = pos.RootElement.GetProperty("y").GetDouble();
            foreach (var type in click ? new[] { "mouseMoved", "mousePressed", "mouseReleased" } : new[] { "mouseMoved" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(60);
        }
        async Task Text(string selector, string text)
        {
            await Point(selector);
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyDown\",\"key\":\"a\",\"code\":\"KeyA\",\"windowsVirtualKeyCode\":65,\"modifiers\":2}");
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyUp\",\"key\":\"a\",\"code\":\"KeyA\",\"windowsVirtualKeyCode\":65,\"modifiers\":2}");
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text }));
        }
        async Task ExpectClipboard(string kind)
        {
            await Check("[...document.querySelectorAll('.cloudig-markdown-feedback')].at(-1)?.dataset.busy==='false'");
            var expected = expectations.GetProperty(kind); string observed = ""; long size = 0;
            // A prior success toast may still be fading while the next click is
            // dispatched. Observe the new clipboard bytes, not the old toast.
            for (var i = 0; i < 80; i++)
            {
                var text = Clipboard.GetText(); var bytes = Encoding.UTF8.GetBytes(text); size = bytes.LongLength;
                observed = Convert.ToHexString(SHA256.HashData(bytes));
                if (size == expected.GetProperty("bytes").GetInt64() && observed.Equals(expected.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase)) { lastCopied = text; TraceVisualAudit("markdown-clipboard-exact", $"{kind};bytes={size};sha={observed}"); return; }
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Actual Windows clipboard differs: {kind};bytes={size};sha={observed};expected={expected}");
        }
        var capturedMarkdown = false;
        async Task OpenMarkdown()
        {
            await Point(".reader-conversation-title", false);
            await Point("[data-action=export-markdown]");
            await Check("Boolean(document.querySelector('.cloudig-markdown-dialog'))&&document.querySelector('.route-host').inert");
            if (!capturedMarkdown) { await Capture("markdown-options"); capturedMarkdown = true; }
        }
        try
        {
            await Check("document.querySelector('.route-transition').hidden");
            var entry = audit.Query.Contains("route=archiver", StringComparison.Ordinal) ? "[data-archive-search]" : "[data-reader-search-input]";
            if (entry.Contains("archive", StringComparison.Ordinal))
            {
                await Point("[data-archive-directory]");
                await Check("document.querySelector('.archiver-filter-choices input[value=all]').type==='radio'&&document.querySelector('.archiver-filter-choices input[value=archived]').type==='checkbox'");
                await Point(".archiver-filter-choices label:nth-child(2) span");
                await Point(".archiver-filter-choices input[value=archived] + span");
                await Check("!document.querySelector('.archiver-filter-choices input[value=all]').checked&&document.querySelectorAll('.archiver-filter-choices input:checked').length===2");
                await Capture("archive-directory");
                await Point(".archiver-filter-choices input[value=all] + span");
                await Check("document.querySelectorAll('.archiver-filter-choices input:checked').length===1");
                await Point(".archiver-filter-popover footer button:last-child");
            }
            if (entry.Contains("reader", StringComparison.Ordinal) && await Read("document.querySelector('[data-page=reader]')?.dataset.catalogCollapsed==='true'") == "true")
            {
                // The accepted collapsed catalog reveals its handle on hover.
                // Enter the live hover zone before requiring the button itself
                // to be hit-testable, just as a pointer user does.
                await Point(".reader-catalog-toggle-zone", false);
                await Point("[data-reader-catalog-toggle=expand]");
                await Check("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='false'");
            }
            await Check($$"""document.querySelector({{JsonSerializer.Serialize(entry)}}).placeholder===(document.documentElement.lang==='en'?'Title or content':'搜索标题或正文')""");
            await Check($$"""(()=>{const n=document.querySelector({{JsonSerializer.Serialize(entry)}}),s=getComputedStyle(n),c=document.createElement('canvas').getContext('2d');c.font=s.font;return c.measureText(n.placeholder).width<=n.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)+1;})()""");
            await Capture("search-placeholder");
            await Text(entry, query);
            await Check("Boolean(document.querySelector('.cloudig-search-actions:not([hidden]) [data-search-content]'))");
            await Check("[...document.querySelectorAll('.cloudig-search-actions button')].every(n=>n.scrollWidth<=n.clientWidth+1)");
            await Check("(()=>{const a=document.querySelector('[data-search-title]').getBoundingClientRect(),b=document.querySelector('[data-search-content]').getBoundingClientRect();return Math.abs(a.width-b.width)<1&&Math.abs(a.height-b.height)<1;})()");
            var alignment = await Read("[...document.querySelectorAll('.cloudig-search-actions button')].map(b=>{const r=b.getBoundingClientRect(),g=b.querySelector('.cloudig-search-action-content').getBoundingClientRect(),s=getComputedStyle(b),svg=b.querySelector('svg'),p=svg.querySelector('path'),box=p.getBBox(),stroke=parseFloat(getComputedStyle(p).strokeWidth)/2,m=svg.getScreenCTM(),l=new DOMPoint(box.x-stroke,box.y).matrixTransform(m).x,label=b.querySelector('.cloudig-search-action-label'),range=document.createRange();range.selectNodeContents(label);const t=range.getBoundingClientRect();return {label:label.textContent,button_width:r.width,padding_left:s.paddingLeft,padding_right:s.paddingRight,group_left:g.left-r.left,group_right:r.right-g.right,visible_left:l-r.left,visible_right:r.right-t.right};})");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, "search-alignment.json"), alignment);
            using (var measured = JsonDocument.Parse(alignment))
                foreach (var b in measured.RootElement.EnumerateArray())
                    if (Math.Abs(b.GetProperty("group_left").GetDouble() - b.GetProperty("group_right").GetDouble()) > 1 || Math.Abs(b.GetProperty("visible_left").GetDouble() - b.GetProperty("visible_right").GetDouble()) > 1)
                        throw new InvalidDataException("Search action content is not centered: " + b);
            await Capture("search-entry");
            // A prior title query must not constrain the subsequent content search.
            await Point(".cloudig-search-actions:not([hidden]) [data-search-title]"); await Task.Delay(180);
            await Point(entry); await Point(".cloudig-search-actions:not([hidden]) [data-search-content]");
            await Check("document.querySelector('.cloudig-content-search')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.cloudig-search-result').length===1");
            await Check("document.querySelector('.route-host').inert&&document.querySelector('.cloudig-content-categories input[value=user]').checked&&document.querySelector('.cloudig-content-categories input[value=assistant]').checked&&!document.querySelector('.cloudig-content-categories input[value=process]').checked");
            await Check("(()=>{const n=document.querySelector('.cloudig-content-search'),r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&n.scrollWidth<=n.clientWidth+1;})()");
            await Capture("search-results");
            await Check("document.querySelectorAll('.cloudig-search-result mark.cloudig-search-match').length>0");
            if (audit.Query.Contains("search-entry-only=1", StringComparison.Ordinal))
            {
                await Point("[data-search-close]");
                await Check("!document.querySelector('.cloudig-content-search')&&!document.querySelector('.route-host').inert");
                TraceVisualAudit("search-entry-pointer-passed", "placeholder fits; equal buttons; visible group centered; actual title/content actions and close; clipboard journey not requested");
                return;
            }
            await Point(".cloudig-content-search-filters details:first-child summary");
            await Check("document.querySelectorAll('.cloudig-content-scope-choices input').length===4");
            await Check("document.querySelector('.cloudig-content-scope-choices input[value=all]').type==='radio'&&document.querySelector('.cloudig-content-scope-choices input[value=archived]').type==='checkbox'");
            await Point(".cloudig-content-scope-choices input[value=all] + span");
            await Check("document.querySelectorAll('.cloudig-content-scope-choices input:checked').length===1");
            await Point(".cloudig-content-scope-choices input[value=archived] + span");
            await Check("!document.querySelector('.cloudig-content-scope-choices input[value=all]').checked");
            await Capture("search-directory");
            await Point(".cloudig-content-search-filters details:first-child summary");
            await Point(".cloudig-content-search-form button[type=submit]");
            await Check("document.querySelector('.cloudig-content-search')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.cloudig-search-result')");
            await Point(".cloudig-content-search-filters details:first-child summary");
            await Point(".cloudig-content-scope-choices label:nth-child(2) span");
            await Point(".cloudig-content-scope-choices label:nth-child(3) span");
            await Check("document.querySelectorAll('.cloudig-content-scope-choices input:checked').length===3");
            await Point(".cloudig-content-search-filters details:first-child summary");
            await Point(".cloudig-content-search-form button[type=submit]");
            await Check("document.querySelector('.cloudig-content-search')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.cloudig-search-result').length===1");
            await Point(".cloudig-search-result-toggle");
            await Check($$"""Boolean(document.querySelector('.cloudig-search-message-preview #{{anchor}}'))&&!document.querySelector('.cloudig-search-message-preview[data-loading]')""");
            await Check("CSS.highlights.get('cloudig-search-hit')?.size>0");
            await Capture("search-preview");
            await Point(".cloudig-search-result > .cloudig-button");
            await Check($$"""!document.querySelector('.cloudig-content-search')&&!document.querySelector('.route-host').inert&&Boolean(document.querySelector('.reader-conversation-main #{{anchor}} .reader-message-copy'))""");
            await Check($$"""(()=>{const n=document.getElementById({{JsonSerializer.Serialize(anchor)}}),r=n.getBoundingClientRect(),v=document.querySelector('.reader-conversation-scroll').getBoundingClientRect();return r.top<v.bottom&&r.bottom>v.top;})()""");
            await Point("#" + anchor, false); await Point("#" + anchor + " .reader-message-copy"); await ExpectClipboard("single");
            await OpenMarkdown();
            await Point(".cloudig-markdown-dialog input[value=partial] + span");
            await Check("document.querySelectorAll('.cloudig-markdown-messages input').length>1");
            await Check("(()=>{const n=document.querySelector('.cloudig-markdown-messages .cloudig-choice>span');return n.previousElementSibling.type==='checkbox'&&getComputedStyle(n,'::before').borderRadius==='3px';})()");
            foreach (var id in spec.GetProperty("selected").EnumerateArray()) await Point(".cloudig-markdown-messages input[value=" + JsonSerializer.Serialize(id.GetString()) + "] + span");
            await Check("(()=>{const d=document.querySelector('.cloudig-markdown-dialog'),r=d.getBoundingClientRect();return d.scrollTop===0&&d.querySelector('h2').getBoundingClientRect().top>=r.top&&d.querySelector('footer').getBoundingClientRect().bottom<=r.bottom;})()");
            await Capture("markdown-partial");
            await Point(".cloudig-markdown-dialog footer button:nth-child(2)"); await ExpectClipboard("partial");
            await OpenMarkdown(); await Point(".cloudig-markdown-dialog footer button:nth-child(2)"); await ExpectClipboard("whole");
            await OpenMarkdown(); await Point(".cloudig-markdown-dialog input[value=with_process] + span");
            await Point(".cloudig-markdown-dialog footer button:nth-child(2)"); await ExpectClipboard("process");
            await OpenMarkdown(); await Point(".cloudig-markdown-dialog footer button:last-child");
            await Check("!document.querySelector('.cloudig-markdown-dialog')&&Boolean(document.querySelector('.cloudig-dialog'))");
            var exports = Directory.GetFiles(Path.Combine(_libraryRoot!, "Exports"), "*.md");
            if (exports.Length == 0) throw new InvalidDataException("Markdown export did not create a file.");
            var file = exports.OrderBy(File.GetLastWriteTimeUtc).Last(); var exported = await File.ReadAllBytesAsync(file);
            if (!Convert.ToHexString(SHA256.HashData(exported)).Equals(expectations.GetProperty("whole").GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Export differs from current displayed branch.");
            await Capture("markdown-export");
            TraceVisualAudit("search-copy-pointer-passed", "real source Tree; title query independent; user/AI defaults; directory union/archive; rich hit preview; off-path message navigation; actual Windows clipboard single/partial/whole/process exact SHA; file export current branch; original clipboard restored if unchanged");
        }
        finally
        {
            // Do not replace a clipboard value the user changed during the audit.
            if (lastCopied is not null && Clipboard.ContainsText() && Clipboard.GetText() == lastCopied)
            {
                if (previousClipboard is null) Clipboard.Clear(); else Clipboard.SetDataObject(previousClipboard, true);
            }
        }
    }
}
