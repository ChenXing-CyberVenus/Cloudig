using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Runs only under the explicit isolated visual-audit flag. Pointer events
    // hit the actual WebView surface; production has no timers or test hooks.
    private async Task VerifyStandardDocumentAsync(VisualAuditOptions audit)
    {
        async Task CheckAsync(string expression, string message)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) != "true")
            {
                await CaptureAsync("failed");
                throw new InvalidDataException(message);
            }
        }
        async Task WaitAsync(string expression)
        {
            for (var attempt = 0; attempt < 160; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(50);
            }
            throw new TimeoutException("Standard document did not become ready.");
        }
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const b=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!b)return null;const s=b.closest('.standard-nav-panel nav,.standard-scroll');if(s){const r=b.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top)s.scrollTop+=r.top-v.top;else if(r.bottom>v.bottom)s.scrollTop+=r.bottom-v.bottom;}const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width&&r.height&&b.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") throw new InvalidDataException($"Document control obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble();
            var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(130);
        }
        async Task CaptureAsync(string suffix)
        {
            await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        async Task HoverAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24);return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") throw new InvalidDataException($"Document hover control obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble() }));
            await Task.Delay(130);
        }
        async Task KeyAsync(string key, int code)
        {
            foreach (var type in new[] { "keyDown", "keyUp" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key, code = key, windowsVirtualKeyCode = code }));
        }
        const string ready = "Boolean(document.querySelector('[data-document-ready=true]') && [...document.querySelectorAll('.standard-document img')].every(i=>i.complete&&i.naturalWidth>0))";
        var baseline = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const e=document.querySelector('.reader-main,.archiver-center');window.__standardOriginal=e.firstElementChild;return [...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});})()");
        await ClickAsync("[data-doc-topic=json]");
        await WaitAsync(ready);
        var publicationLanguage = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang") == "\"en\"" ? "en" : "zh-CN";
        using var publication = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(_layout.WebRoot, "pages", "document", "content", $"standard-{publicationLanguage}.json")));
        var expectedTables = System.Text.RegularExpressions.Regex.Matches(publication.RootElement.GetProperty("html").GetString()!, @"<table\b").Count;
        var barTop = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.standard-bar').getBoundingClientRect().top");
        var typography = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const n=document.querySelector('.standard-document'),r=n.getBoundingClientRect(),s=n.querySelector('.standard-scroll'),a=[...n.querySelectorAll('.standard-art img')].find(i=>getComputedStyle(i).display!=='none').getBoundingClientRect(),b=n.querySelector('.standard-return'),p=n.querySelector('.standard-prose'),t=p.querySelector('table'),k=n.querySelector('.standard-footnote-copy'),reading=n.querySelector('.standard-reading'),concept=p.querySelector('.standard-concept-heading');return {image_left:a.left-r.left,image_right:r.right-a.right,gutter:s.offsetWidth-s.clientWidth,body:parseFloat(getComputedStyle(p).fontSize),table:parseFloat(getComputedStyle(t).fontSize),note:parseFloat(getComputedStyle(k).fontSize),font:getComputedStyle(p).fontFamily,title_font:getComputedStyle(n.querySelector('h1')).fontFamily,return_background:getComputedStyle(b,'::before').backgroundColor,return_color:getComputedStyle(b).color,paper:getComputedStyle(n).backgroundColor,surface_gradient:getComputedStyle(n).backgroundImage,reading_paint:getComputedStyle(reading).backgroundColor,reading_layer:getComputedStyle(reading,'::before').content,paragraph_gap:parseFloat(getComputedStyle(p.querySelector('p')).marginTop),list_gap:parseFloat(getComputedStyle(p.querySelector('li:not(.standard-footnote)')).marginTop),concept_count:p.querySelectorAll('.standard-concept-heading').length,concept_gap:parseFloat(getComputedStyle(concept).marginTop),concept_rule:parseFloat(getComputedStyle(concept).borderTopWidth),emphasis:p.querySelectorAll('.standard-emphasis-accent').length};})()
            """);
        TraceVisualAudit("standard-typography", typography);
        await CheckAsync($$"""
            (()=>{const v={{typography}},night=document.documentElement.dataset.theme==='star-night',archiver=Boolean(document.querySelector('.archiver-center.standard-document-host'));return Math.abs(v.image_left-v.image_right)<1&&v.image_left<=9&&v.image_right<=9&&v.body===16&&v.table===16&&v.note===14&&v.font===v.title_font&&v.emphasis>=6&&v.paragraph_gap===28&&v.list_gap===14&&v.concept_count===6&&v.concept_gap===44&&v.concept_rule>0&&v.concept_rule<=1.01&&v.reading_layer==='none'&&v.reading_paint==='rgba(0, 0, 0, 0)'&&v.return_background===(night?'rgb(81, 37, 165)':'rgb(165, 37, 37)')&&v.return_color===(night?'rgb(255, 169, 46)':'rgb(255, 255, 255)')&&(night||(archiver?v.surface_gradient.includes('linear-gradient'):v.paper==='rgb(219, 194, 165)'));})()
            """, "Image centering, readable type, emphasis or Cloudig theme failed.");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll');s.scrollTop+=document.querySelector('.standard-prose').getBoundingClientRect().top-s.getBoundingClientRect().top;})()");
        await CaptureAsync("principles");
        await ClickAsync("a[href='#standard-note-3']");
        await CheckAsync("document.activeElement.id==='standard-note-3'&&document.querySelectorAll('.standard-footnote').length===3", "Footnote did not navigate to its section note.");
        await CaptureAsync("footnote");
        await ClickAsync("#standard-note-3 [role=doc-backlink]");
        await CheckAsync("document.activeElement.id==='standard-note-ref-3-1'&&document.activeElement.tabIndex===0&&getComputedStyle(document.activeElement.parentElement).verticalAlign==='super'", "Footnote did not return to its keyboard-accessible superscript reference.");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll');s.scrollTop+=document.querySelectorAll('.standard-concept-heading')[3].getBoundingClientRect().top-s.getBoundingClientRect().top;})()");
        await CaptureAsync("concepts");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.standard-scroll').scrollTop=0");
        await CheckAsync("document.querySelector('.standard-document-host').firstElementChild===window.__standardOriginal", "Document replaced original page nodes.");
        await CheckAsync($$"""
            JSON.stringify([...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})) === JSON.stringify({{baseline}})
            """, "Document moved the existing sidebars.");
        await CheckAsync($$"""(()=>{const n=document.querySelector('.standard-document'),r=n.getBoundingClientRect(),h=n.parentElement.getBoundingClientRect(),s=n.querySelector('.standard-scroll');return Math.abs(r.x-h.x)<1&&Math.abs(r.width-h.width)<1&&r.bottom<=innerHeight+1&&s.scrollHeight>s.clientHeight&&s.scrollWidth<=s.clientWidth+1&&document.querySelectorAll('.standard-prose table').length==={{expectedTables}};})()""", "Document geometry or complete content failed.");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const h=[...document.querySelectorAll('.standard-prose h4')].find(n=>n.textContent.startsWith('Box')),s=document.querySelector('.standard-scroll');if(h)s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-8;})()");
        await CaptureAsync("box-window-fields");
        await ClickAsync(".standard-value-toggle");
        await CheckAsync("(()=>{const b=document.querySelector('.standard-value-toggle');return b.getAttribute('aria-expanded')==='false'&&b.querySelector('img').src.endsWith('-Grey.svg')&&b.closest('section').querySelector('.standard-section-body').hidden;})()", "Heading did not fold to the grey variant.");
        await CaptureAsync("folded");
        await ClickAsync(".standard-value-toggle");
        await CheckAsync("document.querySelector('.standard-value-toggle').getAttribute('aria-expanded')==='true'", "Heading did not reopen.");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.standard-scroll').scrollTop=4000");
        TraceVisualAudit("standard-fixed-bar", await WebView.CoreWebView2.ExecuteScriptAsync($$"""
            (()=>{const bar=document.querySelector('.standard-bar');return {initial_top:{{barTop}},bar:bar.getBoundingClientRect().toJSON(),controls:[...bar.querySelectorAll('[data-standard-menu],.standard-return')].map(b=>({label:b.textContent,rect:b.getBoundingClientRect().toJSON()}))};})()
            """));
        await CheckAsync($$"""
            (()=>{const bar=document.querySelector('.standard-bar'),r=bar.getBoundingClientRect();return Math.abs(r.top-{{barTop}})<1&&[...bar.querySelectorAll('[data-standard-menu],.standard-return')].every(b=>{const x=b.getBoundingClientRect();return x.width>0&&x.left>=r.left&&x.right<=r.right+1&&x.top>=r.top&&x.bottom<=r.bottom+1;});})()
            """, "Fixed document navigation moved or overflowed.");
        await HoverAsync("[data-standard-menu=core]");
        await CheckAsync("(()=>{const p=document.querySelector('.standard-nav-panel'),r=p.getBoundingClientRect(),d=document.querySelector('.standard-document').getBoundingClientRect(),links=[...p.querySelectorAll('nav a')];return !p.hidden&&links.length===28&&links.every(a=>a.dataset.infovalue==='core')&&r.left>=d.left&&r.right<=d.right+1&&r.bottom<=d.bottom+1;})()", "Core hover contents is incorrect or escapes the document.");
        await HoverAsync(".standard-nav-panel nav a:first-child");
        await CheckAsync("!document.querySelector('.standard-nav-panel').hidden", "Hover contents disappeared between trigger and menu.");
        await CaptureAsync("fixed-navigation");
        await ClickAsync("[data-standard-menu=core]");
        await CheckAsync("document.querySelector('[data-standard-menu=core]').getAttribute('aria-pressed')==='false'&&document.querySelector('[data-standard-menu=core] img').src.endsWith('-Grey.svg')", "Core category did not collapse with a grey indicator.");
        await ClickAsync(".standard-nav-panel a[href='#standard-3']");
        await CheckAsync("!document.querySelector('#standard-3 > .standard-section-body').hidden&&!document.querySelector('#standard-2 > .standard-section-body').hidden&&document.querySelector('#standard-1 > .standard-section-body').hidden&&document.querySelector('[data-standard-menu=core]').getAttribute('aria-pressed')==='mixed'", "Category navigation did not reveal only the required ancestor path.");
        await ClickAsync("[data-standard-menu=core]");
        await CheckAsync("document.querySelector('[data-standard-menu=core]').getAttribute('aria-pressed')==='true'", "Core category did not fully reopen.");
        await ClickAsync("[data-standard-menu=fold]");
        await CheckAsync("[...document.querySelectorAll('.standard-prose details[data-infovalue=fold]')].every(d=>d.open)&&document.querySelector('[data-standard-menu=fold]').getAttribute('aria-pressed')==='true'", "Fold category omitted disclosure notes.");
        await ClickAsync("[data-standard-menu=fold]");
        await ClickAsync(".standard-toc-toggle");
        await CheckAsync("document.querySelectorAll('.standard-nav-panel nav a').length===document.querySelectorAll('.standard-prose [data-infovalue]').length", "Full contents omitted sections or notes.");
        await ClickAsync(".standard-nav-panel nav a:nth-child(30)");
        await CheckAsync("document.querySelector('.standard-scroll').scrollTop>300", "Contents did not navigate inside the document.");
        await CaptureAsync("chapter");
        await ClickAsync(".standard-toc-toggle");
        await KeyAsync("ArrowDown", 40);
        await CheckAsync("document.activeElement.matches('.standard-nav-panel nav a')", "Keyboard cannot enter the document contents.");
        await KeyAsync("Escape", 27);
        await CheckAsync("document.querySelector('.standard-nav-panel').hidden&&document.activeElement.matches('.standard-toc-toggle')", "Escape did not close contents and restore its trigger.");
        await ClickAsync(".standard-return");
        await CheckAsync("!document.querySelector('.standard-document')&&!document.querySelector('.standard-document-host')&&document.querySelector('.reader-main,.archiver-center').firstElementChild===window.__standardOriginal", "Return did not restore the original central page.");
        await ClickAsync("[data-doc-topic=json]");
        await WaitAsync(ready);
        await ClickAsync("[data-standard-menu=fold]");
        var theme = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme");
        await ClickAsync("[data-action=toggle-theme]");
        await WaitAsync($"document.documentElement.dataset.theme!=={theme}");
        await ClickAsync("[data-action=toggle-theme]");
        await WaitAsync($"document.documentElement.dataset.theme==={theme}");
        await CheckAsync("document.querySelectorAll('.standard-document').length===1", "Theme change remounted the document.");
        await CheckAsync("document.querySelector('[data-standard-menu=fold]').getAttribute('aria-pressed')==='true'", "Theme change reset the category expansion state.");
        await ClickAsync("[data-standard-menu=fold]");
        await CheckAsync("(()=>{const b=document.querySelector('.standard-return'),night=document.documentElement.dataset.theme==='star-night';return getComputedStyle(b,'::before').backgroundColor===(night?'rgb(81, 37, 165)':'rgb(165, 37, 37)');})()", "Painted button fill drifted after theme roundtrip.");
        var scrollPoint = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.standard-scroll').getBoundingClientRect();return {x:r.right-4,y:r.top+60};})()");
        using (var scroll = JsonDocument.Parse(scrollPoint))
        {
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = scroll.RootElement.GetProperty("x").GetDouble(), y = scroll.RootElement.GetProperty("y").GetDouble() }));
            await Task.Delay(100);
            await CheckAsync("(()=>{const n=document.querySelector('.standard-scroll'),p=getComputedStyle(n,'::-webkit-scrollbar-thumb'),night=document.documentElement.dataset.theme==='star-night';return n.classList.contains('cloudig-scroll-operating')&&p.backgroundColor===(night?'rgb(255, 169, 46)':'rgb(214, 140, 128)')&&getComputedStyle(n,'::-webkit-scrollbar').width==='8px';})()", "Document scrollbar deviates from the shared theme/interaction rule.");
        }
        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = 1, y = 1 }));
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.standard-scroll').scrollTop=0; delete window.__standardOriginal;");
        await Task.Delay(180);
        TraceVisualAudit("standard-document-pointer-roundtrip-passed", "complete bilingual publication; value disclosure; TOC; return; theme roundtrip; sidebars unchanged");
    }
}
