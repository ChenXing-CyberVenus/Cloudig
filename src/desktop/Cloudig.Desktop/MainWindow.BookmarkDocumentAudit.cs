using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private readonly List<string> _bookmarkDocumentExternalRequests = new();

    private async Task VerifyBookmarkDocumentAsync(VisualAuditOptions audit)
    {
        async Task Capture(string suffix)
        {
            await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        async Task Check(string expression, string message)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
            await Capture("failed"); throw new InvalidDataException(message);
        }
        async Task Wait(string expression)
        {
            for (var i = 0; i < 240; i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(50);
            }
            await Capture("timeout"); throw new TimeoutException("Bookmark document or real Reader did not become ready: " + expression);
        }
        async Task Pointer(string selector, bool click = true)
        {
            await Wait("document.querySelector('.route-transition').hidden");
            await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),s=n?.closest('.standard-nav-panel nav,.standard-scroll,.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8||r.bottom>v.bottom-8)s.scrollTop+=r.top-v.top-(v.height-r.height)/2;} })()
                """);
            // Real resource images can settle after the Reader header becomes ready.
            await Task.Delay(150);
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const s=n.closest('.standard-nav-panel nav,.standard-scroll,.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8)s.scrollTop+=r.top-v.top-8;else if(r.bottom>v.bottom-8)s.scrollTop+=r.bottom-v.bottom+8;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,22);return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") { await Capture("obstructed"); throw new InvalidDataException("Bookmark document pointer obstructed: " + selector); }
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            if (click) foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(100);
        }
        var host = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page]').dataset.page");
        await Pointer("[data-doc-topic=bookmark]");
        await Wait("Boolean(document.querySelector('[data-document=bookmark] .bookmark-document[data-document-ready=true]'))");
        await Check("(()=>{const e=document.querySelector('.bookmark-document'),s=e.querySelector('.standard-scroll'),b=e.querySelector('.standard-bar').getBoundingClientRect();return e.querySelectorAll('.standard-prose img[src*=bookmark-guide]').length===6&&getComputedStyle(e.querySelector('.standard-prose')).fontSize==='16px'&&s.scrollWidth<=s.clientWidth+1&&[...e.querySelectorAll('.standard-bar button')].every(n=>{const r=n.getBoundingClientRect();return r.left>=b.left-1&&r.right<=b.right+1})&&!e.querySelector('iframe');})()", "Guide text size, screenshots or central geometry failed");
        await Capture("guide-opening");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#bookmark-section-3']");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.bookmark-document img[loading]').forEach(i=>i.loading='eager')");
        await Wait("[...document.querySelectorAll('.bookmark-document img')].every(i=>i.complete&&i.naturalWidth)");
        await Capture("guide-screenshots");
        await Pointer("[data-doc-topic=platforms]");
        await Wait("document.querySelectorAll('[data-example-platform]').length===12");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#platform-catalog']");
        await Check("document.querySelector('.standard-scroll').scrollWidth<=document.querySelector('.standard-scroll').clientWidth+1", "Example catalogue overflow");
        await Capture("catalogue");
        await Pointer("[data-example-platform=claude]");
        await Pointer("[data-example-scenario=Cowork]");
        await Check("document.querySelector('[data-example-profile=tree]').disabled", "Cowork incorrectly offers a Tree example");
        await Pointer("[data-example-profile=full]");
        await Check("!document.querySelector('[data-example-chrome],[data-example-reader]')&&[...document.querySelectorAll('.example-downloads small')].every(n=>/\\d.*(?:B|KiB|MiB)/.test(n.textContent))&&document.querySelectorAll('.example-downloads small').length===2", "Desktop examples must offer online view and two sized downloads, not a missing local demo");
        var selectedExample = JsonSerializer.Deserialize<string>(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-example-id]').dataset.exampleId"))!;
        var language = JsonSerializer.Deserialize<string>(await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang"))!;
        var theme = JsonSerializer.Deserialize<string>(await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme"))!;
        foreach (var action in new[] { (Selector: "[data-example-online]", Kind: "view") })
        {
            var before = _bookmarkDocumentExternalRequests.Count;
            await Pointer(action.Selector);
            for (var n = 0; n < 100 && _bookmarkDocumentExternalRequests.Count == before; n++) await Task.Delay(20);
            if (_bookmarkDocumentExternalRequests.Count != before + 1) throw new InvalidDataException("Example did not reach the native external-browser boundary");
            var url = new Uri(_bookmarkDocumentExternalRequests[^1]);
            var query = System.Web.HttpUtility.ParseQueryString(url.Query);
            if (url.Scheme != "https" || url.Host != "chenxing-cybervenus.github.io" || url.AbsolutePath != "/Cloudig/" || url.Fragment != $"#platforms/{selectedExample}/{action.Kind}" || query["lang"] != (language == "en" ? "en" : "zh-CN") || query["theme"] != theme)
                throw new InvalidDataException("Example external URL lost its selection/language/theme: " + url);
            await Wait("/(已在浏览器打开|Opened in your browser)/.test(document.querySelector('.example-status').textContent)");
            await Check($$"""document.querySelector('[data-page]').dataset.page==={{host}}&&document.querySelector('[data-example-id]').dataset.exampleId==={{JsonSerializer.Serialize(selectedExample)}}&&!document.querySelector('[data-example-return]')""", "Opening an external example changed the host or selection");
        }
        // Real downloads stay inside this audit's disposable Library. Hashes
        // come from the shipped public manifest, not the UI completion label.
        using (var catalog = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(_layout.WebRoot, "pages", "document", "content", "examples.json"))))
        {
            var selected = catalog.RootElement.GetProperty("examples").EnumerateArray().Single(e => e.GetProperty("id").GetString() == selectedExample);
            foreach (var action in new[] { (Selector: "[data-example-html-download]", Field: "html"), (Selector: "[data-example-record]", Field: "record") }) {
                var before = _bookmarkDocumentExternalRequests.Count;
                await Pointer(action.Selector);
                for (var n = 0; n < 1200; n++) {
                    if (await WebView.CoreWebView2.ExecuteScriptAsync("/(未能完成|Could not complete)/.test(document.querySelector('.example-status').textContent)") == "true") { await Capture("download-failed"); throw new InvalidDataException("Example download failed: " + await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-dialog-layer')?.textContent||document.querySelector('.example-status').textContent")); }
                    if (await WebView.CoreWebView2.ExecuteScriptAsync("/(已保存至|已存在完整文件|Saved to|Already saved)/.test(document.querySelector('.example-status').textContent)") == "true") break;
                    await Task.Delay(100);
                }
                var file = await new Cloudig.Desktop.Core.ExampleDownloadClient().PublishedFileAsync(Path.Combine(_layout.WebRoot,"pages","document","content","examples.json"),selectedExample,action.Field=="html"?"html":"json",default);
                var target = Path.Combine(_libraryRoot!, "docs", "examples", file.GetProperty("path").GetString()!.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(target) || new FileInfo(target).Length != file.GetProperty("bytes").GetInt64()) throw new InvalidDataException("Example download did not reach Library docs");
                await using var bytes = File.OpenRead(target); var sha = Convert.ToHexString(await System.Security.Cryptography.SHA256.HashDataAsync(bytes));
                if (!sha.Equals(file.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase) || _bookmarkDocumentExternalRequests.Count != before) throw new InvalidDataException("Example download hash/browser isolation failed");
            }
        }
        await Capture("online-actions");
        await Pointer("[data-example-platform=chatgpt]");
        await Pointer("[data-example-profile=tree]");
        await Check("document.querySelector('[data-example-profile=tree]').getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-example-profile=tree]').disabled", "The online catalogue lost Tree selection");
        await Pointer("[data-standard-menu=general]");
        await Check("document.querySelector('#platform-catalog-body').hidden", "Information value folding is decorative only");
        await Pointer("[data-standard-menu=all]"); await Pointer(".standard-nav-panel a[href='#platform-catalog']");
        await Check("!document.querySelector('#platform-catalog-body').hidden", "TOC did not reveal folded examples");
        await Pointer(".standard-return");
        await Check("!document.querySelector('.standard-document')", "Document did not return to the actual host");
        await Pointer("[data-doc-topic=platforms]"); await Wait("Boolean(document.querySelector('[data-document=platforms]'))");
        await Pointer("[data-standard-menu=all]"); await Pointer(".standard-nav-panel a[href='#platform-catalog']");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".example-links.json"), JsonSerializer.Serialize(_bookmarkDocumentExternalRequests));
        TraceVisualAudit("bookmark-document-pointer-roundtrip-passed", "six original screenshots; online view native external boundary; two real verified downloads into isolated Library docs; 12 platforms; host/selection; TOC/folding/return");
    }
}
