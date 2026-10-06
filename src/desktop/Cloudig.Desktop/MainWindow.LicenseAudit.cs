using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyLicenseDocumentAsync(VisualAuditOptions audit)
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
            for (var i = 0; i < 180; i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(50);
            }
            await Capture("timeout"); throw new TimeoutException("License document did not become ready");
        }
        async Task Pointer(string selector, bool click = true)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const s=n.closest('.standard-nav-panel nav,.standard-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8)s.scrollTop+=r.top-v.top-8;else if(r.bottom>v.bottom-8)s.scrollTop+=r.bottom-v.bottom+8;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24);return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") { await Capture("obstructed"); throw new InvalidDataException($"License pointer target obstructed: {selector}"); }
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            if (click) foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(100);
        }
        var sidebars = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{window.__licenseHostOriginal=document.querySelector('.reader-main,.archiver-center').firstElementChild;return [...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});})()");
        await Pointer("[data-doc-topic=license]");
        await Wait("Boolean(document.querySelector('.license-document[data-document-ready=true]')&&[...document.querySelectorAll('.license-document img')].every(i=>i.complete&&i.naturalWidth))");
        const string artwork = "(()=>{const hero=document.querySelector('.license-hero'),r=hero.getBoundingClientRect(),images=[...hero.querySelectorAll('img')].filter(i=>i.getBoundingClientRect().width>0);if(images.length!==1)return false;const i=images[0],b=i.getBoundingClientRect();return i.complete&&i.naturalWidth>0&&i.src.endsWith('license-frontispiece-'+document.documentElement.dataset.theme+'.png')&&Math.abs(b.width-r.width)<1&&Math.abs(b.width/b.height-i.naturalWidth/i.naturalHeight)<.01;})()";
        await Check(artwork, "License illustration is missing, cropped, stretched or has the wrong theme");
        await Check("(()=>{const h=document.querySelector('.license-frontispiece'),f=h.querySelector('.license-hero'),b=h.querySelector('.license-byline'),r=h.getBoundingClientRect(),i=f.getBoundingClientRect();return h.parentElement.classList.contains('standard-scroll')&&h.nextElementSibling.classList.contains('license-reading')&&b.nextElementSibling===f&&Math.abs(r.left-i.left)<1&&Math.abs(r.width-i.width)<1&&b.getBoundingClientRect().bottom<i.top&&getComputedStyle(f.querySelector('img')).borderRadius==='0px';})()", "License frontispiece does not share the Standard/History title-first, full-width layout");
        await Check("(()=>{const e=document.querySelector('.license-document'),r=e.getBoundingClientRect(),h=e.parentElement.getBoundingClientRect(),s=e.querySelector('.standard-scroll'),p=e.querySelector('.license-original'),b=e.querySelector('.standard-bar'),bar=b.getBoundingClientRect();return !p.hidden&&p.querySelectorAll('h3,h4').length===8&&p.querySelectorAll('ol li').length===3&&getComputedStyle(p).fontSize==='16px'&&s.scrollWidth<=s.clientWidth+1&&Math.abs(r.x-h.x)<1&&Math.abs(r.width-h.width)<1&&[...b.querySelectorAll('button')].every(n=>{const x=n.getBoundingClientRect();return x.left>=bar.left&&x.right<=bar.right+1})&&!document.querySelector('.license-components pre');})()", "License body, controls or central geometry failed");
        await Capture("opening");
        var language = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.license-original').lang");
        await Pointer("[data-license-language]");
        await Check($"document.querySelector('.license-original').lang!=={language}", "Local language control failed");
        await Pointer("[data-license-language]");
        await Check($"document.querySelector('.license-original').lang==={language}", "Language did not return");
        // Capture the actual pointer-triggered Clipboard API payload only in
        // this isolated audit; leave the user's Windows clipboard untouched.
        await WebView.CoreWebView2.ExecuteScriptAsync("window.__licenseClipboardOriginal=navigator.clipboard.writeText;navigator.clipboard.writeText=async text=>{window.__licenseCopied=text;};fetch('/pages/document/content/license.json').then(r=>r.json()).then(d=>window.__licenseCopyExpected=d.full_text)");
        await Wait("typeof window.__licenseCopyExpected==='string'");
        try
        {
            await Pointer("[data-license-copy]");
            await Check("window.__licenseCopied===window.__licenseCopyExpected&&document.querySelector('.license-status').dataset.error==='false'", "Full bilingual copy payload failed");
            await WebView.CoreWebView2.ExecuteScriptAsync("navigator.clipboard.writeText=async()=>{throw new Error('audit denial');}");
            await Pointer("[data-license-copy]");
            await Check("document.querySelector('.license-status').dataset.error==='true'&&!document.querySelector('[data-license-copy]').disabled", "Copy denial failed to provide a retryable inline message");
        }
        finally { await WebView.CoreWebView2.ExecuteScriptAsync("navigator.clipboard.writeText=window.__licenseClipboardOriginal"); }
        await Pointer("[data-standard-menu=core]");
        await Check("document.querySelector('.license-original').hidden&&document.querySelector('[data-license-core] img').src.endsWith('InfoValue-Core-Grey.svg')", "Core did not collapse as one complete text");
        await Pointer("[data-standard-menu=all]");
        await Check("(()=>{const p=document.querySelector('.standard-nav-panel'),r=p.getBoundingClientRect(),h=document.querySelector('.license-document').getBoundingClientRect();return !p.hidden&&r.left>=h.left&&r.right<=h.right+1&&r.bottom<=h.bottom+1&&p.querySelectorAll('nav a').length===11;})()", "License contents escaped the host");
        await Pointer(".standard-nav-panel a[href='#license-commercial']");
        await Check("!document.querySelector('.license-original').hidden&&document.activeElement.id==='license-commercial'", "TOC did not reveal the complete Core text");
        await Capture("conditions");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#license-notices']");
        await Pointer(".license-notice-original > summary");
        await Check("document.querySelector('.license-notice-original').open&&document.querySelector('.license-notice-original').textContent.includes('third-party')", "Original NOTICE missing");
        await Pointer("[data-license-components]");
        await Wait("document.querySelectorAll('.license-component').length>3");
        await Pointer(".license-component > summary");
        await Wait("Boolean(document.querySelector('.license-component[open] pre'))");
        await Check("document.querySelector('.license-component[open] pre').textContent.includes('Node.js')", "Component original license is missing");
        await Capture("third-party");
        var theme = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme");
        await Pointer("[data-action=toggle-theme]"); await Wait($"document.documentElement.dataset.theme!=={theme}");
        await Check(artwork, "License illustration did not follow the changed theme");
        await Check("Boolean(document.querySelector('.license-component[open] pre'))", "Theme switch reset disclosure");
        await Pointer("[data-action=toggle-theme]"); await Wait($"document.documentElement.dataset.theme==={theme}");
        await Check(artwork, "License illustration did not return to the original theme");
        var pointRaw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.standard-scroll').getBoundingClientRect();return {x:r.right-4,y:r.top+60};})()");
        using (var point = JsonDocument.Parse(pointRaw))
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble() }));
        await Check("(()=>{const s=document.querySelector('.standard-scroll'),night=document.documentElement.dataset.theme==='star-night';return getComputedStyle(s,'::-webkit-scrollbar').width==='8px'&&s.classList.contains('cloudig-scroll-operating')&&getComputedStyle(s,'::-webkit-scrollbar-thumb').backgroundColor===(night?'rgb(255, 169, 46)':'rgb(214, 140, 128)');})()", "License bypassed shared scrollbar behavior");
        await Check($$"""
            JSON.stringify([...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))===JSON.stringify({{sidebars}})
            """, "License changed the sidebars");
        await Pointer("[data-doc-topic=json]");
        await Wait("Boolean(document.querySelector('[data-document=standard]'))");
        await Check("document.querySelectorAll('.standard-document').length===1", "License to Standard left duplicate surfaces");
        await Pointer("[data-doc-topic=roadmap]");
        await Wait("Boolean(document.querySelector('[data-document=history]'))");
        await Pointer("[data-doc-topic=license]");
        await Wait("Boolean(document.querySelector('.license-original'))");
        await Pointer(".standard-return");
        await Check("!document.querySelector('.standard-document')&&document.querySelector('.reader-main,.archiver-center').firstElementChild===window.__licenseHostOriginal", "License return did not restore original central content");
        await Pointer("[data-doc-topic=license]");
        await Wait("Boolean(document.querySelector('.license-document[data-document-ready=true]'))");
        TraceVisualAudit("license-document-pointer-roundtrip-passed", "complete bilingual original; whole-Core folding; TOC; local language; captured Clipboard API payload and denial without altering Windows clipboard; bundled third-party originals; themes; shared scrollbars; three-document navigation; original host return");
    }
}
