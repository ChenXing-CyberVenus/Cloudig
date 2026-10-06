using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private string? _guideUiFingerprint;
    // Explicit, isolated documentation capture. Crops actual WebView pixels;
    // never redraws controls or changes production styles to fit a picture.
    private async Task CaptureFeatureGuideRegionAsync(VisualAuditOptions audit, string name, string selector, bool reveal = true)
    {
        if (reveal)
            await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),s=n?.closest('[data-scroll-region]');if(s&&s!==n){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top||r.bottom>v.bottom)s.scrollTop+=r.top-v.top-16;} })()
                """);
        await WebView.CoreWebView2.ExecuteScriptAsync("window.__guideImagesReady=false;Promise.all([...document.images].filter(i=>i.getBoundingClientRect().width).map(i=>i.decode().catch(()=>{}))).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>window.__guideImagesReady=true)))");
        for (var i = 0; i < 120 && await WebView.CoreWebView2.ExecuteScriptAsync("window.__guideImagesReady") != "true"; i++) await Task.Delay(50);
        var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
            (()=>{const ns=[...document.querySelectorAll({{JsonSerializer.Serialize(selector)}})].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(n).visibility!=='hidden'});if(!ns.length)return null;const rs=ns.map(n=>n.getBoundingClientRect());return {left:Math.max(0,Math.min(...rs.map(r=>r.left))-12),top:Math.max(0,Math.min(...rs.map(r=>r.top))-12),right:Math.min(innerWidth,Math.max(...rs.map(r=>r.right))+12),bottom:Math.min(innerHeight,Math.max(...rs.map(r=>r.bottom))+12),viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.dataset.theme,language:document.documentElement.lang};})()
            """);
        if (raw == "null") throw new InvalidDataException("Guide crop target absent: " + selector);
        using var bounds = JsonDocument.Parse(raw); var r = bounds.RootElement;
        using var frame = new MemoryStream();
        await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, frame);
        frame.Position = 0;
        var image = BitmapDecoder.Create(frame, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
        var sx = image.PixelWidth / r.GetProperty("viewport").GetProperty("width").GetDouble();
        var sy = image.PixelHeight / r.GetProperty("viewport").GetProperty("height").GetDouble();
        var x = (int)Math.Floor(r.GetProperty("left").GetDouble() * sx); var y = (int)Math.Floor(r.GetProperty("top").GetDouble() * sy);
        var width = Math.Min(image.PixelWidth, (int)Math.Ceiling(r.GetProperty("right").GetDouble() * sx)) - x;
        var height = Math.Min(image.PixelHeight, (int)Math.Ceiling(r.GetProperty("bottom").GetDouble() * sy)) - y;
        if (width < 8 || height < 8) throw new InvalidDataException("Guide crop is outside the viewport: " + name + " " + raw);
        var crop = new CroppedBitmap(image, new Int32Rect(x, y, width, height));
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(crop));
        var directory = Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "guide"); Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, name + ".png");
        using (var output = File.Create(file)) encoder.Save(output);
        if (_guideUiFingerprint is null)
        {
            var web = Path.Combine(_layout.BaseDirectory, "app", "web");
            var lines = new List<string>();
            foreach (var asset in Directory.EnumerateFiles(web, "*", SearchOption.AllDirectories).OrderBy(p => Path.GetRelativePath(web,p).Replace('\\','/'), StringComparer.Ordinal))
            {
                var relative = Path.GetRelativePath(web,asset).Replace('\\','/');
                if (relative.StartsWith("pages/document/",StringComparison.Ordinal)) continue;
                lines.Add(relative+"\0"+Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(asset))).ToLowerInvariant()+"\n");
            }
            _guideUiFingerprint=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat(lines)))).ToLowerInvariant();
        }
        await File.WriteAllTextAsync(Path.Combine(directory, name + ".json"), JsonSerializer.Serialize(new {
            kind = "native-webview-crop", selector, bounds = r.Clone(), pixels = new { width, height },
            ui_sha256 = _guideUiFingerprint,
            sha256 = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(file))).ToLowerInvariant(),
            executable_sha256 = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(Environment.ProcessPath!))).ToLowerInvariant()
        }));
    }

    private async Task VerifyFeatureGuideCaptureAsync(VisualAuditOptions audit)
    {
        async Task Wait(string expression)
        {
            for (var i = 0; i < 240; i++) { if (await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({expression})") == "true") return; await Task.Delay(50); }
            throw new TimeoutException("Guide did not reach " + expression);
        }
        async Task Pointer(string selector, bool click = true)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(selector)})?.scrollIntoView({{block:'nearest'}})");
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24);return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """);
            if (raw == "null") throw new InvalidDataException("Guide pointer target obstructed: " + selector);
            using var p = JsonDocument.Parse(raw); var x = p.RootElement.GetProperty("x").GetDouble(); var y = p.RootElement.GetProperty("y").GetDouble();
            foreach (var type in click ? new[] { "mouseMoved", "mousePressed", "mouseReleased" } : new[] { "mouseMoved" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(150);
        }
        Task Shot(string id, string selector, bool reveal = true) => CaptureFeatureGuideRegionAsync(audit, id, selector, reveal);
        var route = new Uri("https://cloudig.local/?" + audit.Query.TrimStart('?'));
        var query = System.Web.HttpUtility.ParseQueryString(route.Query);
        if(query["directory-fonts"]=="1")
        {
            async Task Field(string selector, int size, string shot)
            {
                await Wait($"document.querySelector({JsonSerializer.Serialize(selector)})?.getBoundingClientRect().height>0");
                var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),s=getComputedStyle(n);
                      return {size:s.fontSize,weight:s.fontWeight,family:s.fontFamily,body:getComputedStyle(document.body).fontFamily};})()
                    """);
                using var facts=JsonDocument.Parse(raw);var f=facts.RootElement;
                if(f.GetProperty("size").GetString()!=$"{size}px" || f.GetProperty("weight").GetString()!="400" || f.GetProperty("family").GetString()!=f.GetProperty("body").GetString())
                    throw new InvalidDataException("Directory input typography was ignored: "+raw);
                TraceVisualAudit("reader-directory-font-verified",raw);
                if(selector.Contains("editor"))
                {
                    var colors=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const expected=document.documentElement.dataset.theme==='star-night'?'rgb(255, 169, 46)':'rgb(165, 37, 37)';return ['.reader-directory-editor .eyebrow','.reader-directory-cancel'].every(s=>getComputedStyle(document.querySelector(s)).color===expected)})()");
                    if(colors!="true") throw new InvalidDataException("Directory text reused its dark button-fill color");
                }
                await Shot(Path.GetFileNameWithoutExtension(audit.OutputFile)+"-"+shot,selector.Contains("create")?".reader-directory-create-dialog":".reader-directory-dialog");
            }
            if(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'")=="true")
            {
                var raw=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('[data-reader-catalog-toggle=expand]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
                using var hover=JsonDocument.Parse(raw);
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new {type="mouseMoved",x=hover.RootElement.GetProperty("x").GetDouble(),y=hover.RootElement.GetProperty("y").GetDouble()}));
                await Task.Delay(150);
                await Pointer("[data-reader-catalog-toggle=expand]");
            }
            await Pointer(".reader-directory-region",false);
            await Pointer("[data-reader-directory-action=new]");
            await Field(".reader-directory-create-dialog input",16,"directory-create");
            await Pointer(".reader-directory-create-cancel");
            await Pointer(".reader-directory-region",false);
            await Pointer("[data-reader-directory-action=manage]");
            await Wait("document.querySelector('.reader-directory-list-pane > header button')");
            await Pointer(".reader-directory-list-pane > header button");
            await Field(".reader-directory-editor input",14,"directory-edit");
            await Pointer(".reader-directory-cancel");
            TraceVisualAudit("reader-directory-fonts-pointer-passed");
            return;
        }
        switch (query["route"])
        {
            case "welcome":
                await Shot("01-welcome", ".welcome-identities,.welcome-primary-actions", false);
                await Shot("09a-entry", ".welcome-identity-user");
                await Pointer(".welcome-identity-user"); await Wait("document.querySelector('[data-identity-dialog]')");
                await Shot("09a-identity-global", ".identity-editor-global");
                await Shot("09b-identity-platforms", ".identity-editor-platforms");
                await Pointer("[data-identity-cancel]"); break;
            case "archiver":
                if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('[data-archiver-workflow-close]')?.getBoundingClientRect().width)") == "true") await Pointer("[data-archiver-workflow-close]");
                await Shot("03-entry", "[data-archiver-parse-settings],[data-archiver-parse-all]", false);
                await Pointer("[data-archiver-parse-settings]"); await Wait("!document.querySelector('[data-archiver-parse-settings-popover]').hidden");
                await Shot("03-batch-settings", "[data-archiver-parse-settings-popover]");
                await Pointer("[data-parse-settings-cancel]");
                await Pointer("[data-archiver-parse-all]"); await Wait("document.querySelector('.cloudig-dialog')");
                await Shot("03b-batch-confirm", ".cloudig-dialog"); await Pointer(".cloudig-dialog footer .cloudig-button-outline");
                await Shot("04-entry", "[data-source-claude]");
                await Pointer("[data-source-claude]"); await Wait("document.querySelector('[data-claude-row]')");
                await Pointer("[data-claude-select-all]");
                await Shot("04-claude-json", "[data-claude-search],.archiver-claude-columns,[data-claude-row],[data-claude-one-click]", false);
                await Pointer("[data-claude-return]");
                await Shot("12-entry", "[data-archiver-shell-action=change-library]");
                await Shot("13-entry", "[data-route-target='system/log']");
                await Pointer("[data-route-target='system/log']"); await Wait("document.querySelector('[data-system-log-dialog]')");
                await Shot("13-system-log", ".system-log-header,.system-log-error-row,.system-log-file-heading", false); await Pointer("[data-system-log-close]"); break;
            case "reader":
                await Shot("05-reader-cover", ".reader-catalog", false);
                await Pointer(".reader-row-open"); await Wait("document.querySelector('[data-reader-conversation-scroll] .cloudig-message')");
                await Shot("06-conversation", "[data-reader-conversation-scroll]", false);
                await Shot("07-toolbar", ".reader-conversation-toolbar", false);
                await Shot("07-navigation", ".reader-conversation-navigation", false);
                await Shot("07-branches", "[data-branch-parent]");
                await Shot("14-entry", ".cloudig-message-identity");
                await Pointer(".cloudig-message-identity"); await Wait("document.querySelector('[data-identity-dialog]')");
                await Shot("14-rename-in-conversation", ".identity-editor-header,.identity-editor-conversation"); await Pointer("[data-identity-cancel]");
                await Pointer(".reader-conversation-title-content", false);
                await Shot("08-entry", "[data-action=edit-conversation]");
                await Pointer("[data-action=edit-conversation]"); await Wait("document.querySelector('[data-conversation-info-dialog]')");
                await Shot("08-conversation-info", ".conversation-info-header,.conversation-info-metadata,[data-conversation-name],[data-conversation-models]", false);
                await Shot("10-content-time-edit", ".conversation-info-time");
                await Shot("11-entry", "[data-conversation-time-open]");
                await Pointer("[data-conversation-info-cancel]");
                await Pointer("[data-route-target=reader-cover]"); break;
            case "time-cover":
                await Shot("11-time-terran", ".time-cover-terran .time-cover-bank-header,[data-time-terran-list] > *", false);
                await Shot("11-time-sovereign", ".time-cover-sovereign .time-cover-bank-header,[data-time-sovereign-list] > *", false);
                await Shot("11-time-create", ".time-cover-actions", false);
                await Pointer("[data-time-create=timeline]"); await Wait("document.querySelector('[data-time-editor-metadata]')");
                await Shot("11b-time-editor", "[data-time-editor-body] > .time-editor-section", false);
                await Pointer("[data-time-editor-cancel]"); break;
            default: throw new InvalidDataException("Unsupported guide capture route");
        }
        TraceVisualAudit("feature-guide-crops-pointer-passed");
    }
}
