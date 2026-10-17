using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Isolated audit only; the same packaged UI, assets and Engine as the user.
    private async Task VerifyHistoryDocumentAsync(VisualAuditOptions audit)
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
            for (var i = 0; i < 200; i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(50);
            }
            await Capture("timeout"); throw new TimeoutException("History document did not become ready");
        }
        async Task Pointer(string selector, bool click = true)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const s=n.closest('.standard-nav-panel nav,.standard-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8)s.scrollTop+=r.top-v.top-8;else if(r.bottom>v.bottom-8)s.scrollTop+=r.bottom-v.bottom+8;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24);return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") { await Capture("obstructed"); throw new InvalidDataException($"History pointer target obstructed: {selector}"); }
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            if (click) foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(100);
        }
        var sidebars = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{window.__historyOriginal=document.querySelector('.reader-main,.archiver-center').firstElementChild;return [...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});})()");
        await Pointer("[data-doc-topic=roadmap]");
        await Wait("Boolean(document.querySelector('.history-document[data-document-ready=true]')&&[...document.querySelectorAll('.history-art img')].every(i=>i.complete&&i.naturalWidth))");
        await Check("document.querySelectorAll('.history-volumes > button').length===8&&document.querySelectorAll('.history-prose').length===1&&document.querySelector('.history-home-preface').textContent.length>1500&&document.querySelectorAll('[data-history-art]').length===1", "History opening missed the complete preface or mounted other works");
        await Check("(()=>{const h=document.querySelector('.history-art').getBoundingClientRect(),p=document.querySelector('.history-home-preface').getBoundingClientRect(),v=document.querySelector('.history-volumes').getBoundingClientRect();return p.top>=h.bottom&&v.top>p.bottom;})()", "Home must read hero, full preface, then works");
        await Check("(()=>{const e=document.querySelector('.history-document'),r=e.getBoundingClientRect(),s=e.querySelector('.standard-scroll'),img=[...e.querySelectorAll('.history-art img')].find(i=>getComputedStyle(i).display!=='none').getBoundingClientRect();return s.scrollWidth<=s.clientWidth+1&&Math.abs(img.left-r.left-(r.right-img.right))<1;})()", "History hero is not centered or overflows");
        await Capture("home");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#history-chronicle-2']");
        await Check("!document.querySelector('.history-document').dataset.historyVolume&&document.activeElement.id==='history-chronicle-2'", "Fixed contents missed the home preface");
        await Check("(()=>{const p=document.querySelector('.history-home-preface'),s=p.querySelector('.history-section'),b=s.querySelector('.history-section-body'),d=[...b.querySelectorAll('p')].at(-1);return s.firstElementChild.matches('.history-chapter-flower')&&s.firstElementChild.querySelector('svg')&&b.lastElementChild.dataset.historyArt==='chronicle-2'&&d.textContent.includes('2026-09-19')&&Boolean(d.compareDocumentPosition(b.lastElementChild)&4);})()", "Preface must open with the SVG bear and close with the full illustration after the author's date");
        await Capture("home-preface");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),e=document.querySelector('.history-home-preface [data-history-art]');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-180;})()");
        await Wait("[...document.querySelectorAll('.history-home-preface img')].every(i=>i.complete&&i.naturalWidth)");
        await WebView.CoreWebView2.ExecuteScriptAsync("window.__historyPrefaceArtPainted=false;(async()=>{await Promise.all([...document.querySelectorAll('.history-home-preface img')].map(i=>i.decode()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.__historyPrefaceArtPainted=true;})()");
        await Wait("window.__historyPrefaceArtPainted===true");
        await Check("(()=>{const f=document.querySelector('.history-home-preface [data-history-art]');return f.previousElementSibling.tagName==='P'&&f.previousElementSibling.textContent.includes('2026-09-19')&&getComputedStyle(f).borderTopWidth==='0px';})()", "Preface ending still has a divider before its illustration");
        await Capture("home-preface-end");
        var bearTheme = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme");
        var bearHeight = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.history-home-preface [data-history-art]').getBoundingClientRect().height");
        const string bearVariantCheck = "(()=>{const f=document.querySelector('.history-home-preface [data-history-art]'),all=[...f.querySelectorAll('img')],visible=all.filter(i=>getComputedStyle(i).display!=='none');if(all.length!==2||visible.length!==1)return false;const r=visible[0].getBoundingClientRect();return visible[0].complete&&visible[0].naturalWidth&&visible[0].src.endsWith(document.documentElement.dataset.theme==='star-night'?'/chronicle-2-night.png':'/chronicle-2.png')&&Math.abs(r.width/r.height-3)<.01;})()";
        await Check(bearVariantCheck, "The homepage bear does not match the active theme");
        await Pointer("[data-action=toggle-theme]"); await Wait($"document.documentElement.dataset.theme!=={bearTheme}");
        await Check(bearVariantCheck, "The bear did not change with the theme");
        await Check($"Math.abs(document.querySelector('.history-home-preface [data-history-art]').getBoundingClientRect().height-({bearHeight}))<1", "The bear changed layout height on theme switch");
        await Capture("home-preface-end-opposite");
        await Pointer("[data-action=toggle-theme]"); await Wait($"document.documentElement.dataset.theme==={bearTheme}");
        await Check(bearVariantCheck, "The bear did not restore with the original theme");
        await Check("(()=>{const refs=[...document.querySelectorAll('.history-home-preface [data-history-note]')];return refs.length===5&&refs.every((n,i)=>Number(n.textContent.match(/\\d+/)[0])===i+1);})()", "Homepage preface notes must start at one without gaps");
        await Pointer(".history-home-preface [data-history-note]");
        await Check("document.querySelector('.history-note-preview').id==='history-note-chronicle-1'", "Home citation lost its original source namespace");
        await Check("document.querySelectorAll('.history-note-preview .history-dialogue-user').length===3&&document.querySelectorAll('.history-note-preview .history-dialogue-assistant').length===3&&document.querySelector('.history-note-heading').textContent.includes('2026-08-28')", "History dialogue must retain the actual six source turns, title and date");
        await Capture("dialogue-user");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),n=document.querySelector('.history-note-preview .history-dialogue-assistant');s.scrollTop+=n.getBoundingClientRect().top-s.getBoundingClientRect().top-document.querySelector('.history-note-heading').getBoundingClientRect().height-16;})()");
        await Check("(()=>{const u=document.querySelector('.history-dialogue-user .history-dialogue-message'),a=document.querySelector('.history-dialogue-assistant .history-dialogue-message'),s=document.querySelector('.standard-scroll'),p=document.querySelector('.history-note-preview'),night=document.documentElement.dataset.theme==='star-night';return getComputedStyle(u).backgroundColor===(night?'rgb(73, 57, 80)':'rgb(223, 193, 152)')&&getComputedStyle(p).backgroundColor===(night?'rgb(52, 45, 62)':'rgb(234, 214, 184)')&&getComputedStyle(a).borderLeftWidth==='2px'&&getComputedStyle(a).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(a).fontSize==='16px'&&s.scrollWidth<=s.clientWidth+1;})()", "Dialogue must be a distinct, theme-coherent source panel, with user bubbles and marked unframed replies");
        await Capture("dialogue-assistant");
        await Pointer("[data-close-history-note]");
        await Pointer(".history-home-preface [data-history-note]");
        await Pointer(".history-home-preface [data-history-note]");
        await Check("!document.querySelector('.history-note-preview')&&document.querySelector('.history-home-preface [data-history-note]').getAttribute('aria-expanded')==='false'", "The same citation must collapse its excerpt");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#history-chronicle-3']");
        await Check("document.querySelector('.history-document').dataset.historyVolume==='chronicle'&&!document.querySelector('#history-chronicle-2')", "Fixed contents cannot bypass the preface or duplicated it");
        await Pointer(".history-preface-link");
        await Check("Boolean(document.querySelector('.history-home-preface'))", "Chronicle backlink did not reach the home preface");
        await Pointer("[data-history-volume=appeal]");
        await Check("document.querySelector('.history-volume-heading > .history-volume-number').textContent==='07'&&document.querySelector('.history-appeal-letter').textContent.includes('With respect, with sorrow, with fury, with LOVE.')", "Appeal numbering or unchanged letter is missing");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),e=document.querySelector('.history-mail-evidence');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-24;})()");
        await Wait("Boolean(document.querySelector('.history-mail-evidence img').complete&&document.querySelector('.history-mail-evidence img').naturalWidth)");
        await Check("(()=>{const i=document.querySelector('.history-mail-evidence img'),r=i.getBoundingClientRect(),s=document.querySelector('.standard-scroll');return i.naturalWidth===1344&&i.naturalHeight===663&&Math.abs(r.width/r.height-1344/663)<.01&&s.scrollWidth<=s.clientWidth+1;})()", "Original mail screenshot was cropped or distorted");
        await Capture("appeal-mail");
        await Pointer("[data-history-volume=references]");
        await Check("document.querySelector('.history-volume-heading > .history-volume-number').textContent==='08'", "References are not volume 08");
        await Pointer("[data-history-home]");
        await Pointer("[data-history-volume=chronicle]");
        await Check("document.querySelectorAll('[data-history-art]').length===15&&[...document.querySelectorAll('[data-history-art] img')].every(i=>i.loading==='lazy'&&i.width>0)", "Article illustrations or reserved dimensions are missing");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),e=document.querySelector('[data-history-art]');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-24;})()");
        await Wait("Boolean(document.querySelector('[data-history-art] img').complete&&document.querySelector('[data-history-art] img').naturalWidth)");
        await Capture("article-art");
        await Check("document.querySelectorAll('.history-chapter').length===15&&!document.querySelector('.history-source-record')&&getComputedStyle(document.querySelector('.history-prose')).fontSize==='16px'", "History text, chapters or deferred sources failed");
        await Capture("chronicle-start");
        await Check("(()=>{const n=document.querySelector('h2 .source-note-ref'),a=n?.querySelector('a');return n&&a&&getComputedStyle(a).fontSize==='12px'&&getComputedStyle(a).fontWeight==='400'&&getComputedStyle(n).verticalAlign==='super'&&getComputedStyle(n.parentElement).fontSize==='30px';})()", "Title citation must remain a small regular-weight superscript without shrinking the title");
        await Check("(()=>{const n=document.querySelector('h2 .source-note-ref'),h=n.closest('h2'),a=n.querySelector('a'),range=document.createRange();range.selectNodeContents(h);range.setEndBefore(n);const t=range.getBoundingClientRect(),r=h.getBoundingClientRect(),b=a.getBoundingClientRect();return Math.abs((t.left+t.right-r.left-r.right)/2)<1&&n.getBoundingClientRect().width===0&&b.left>=t.right-1&&b.width>12;})()", "The title text itself must be centered; its clickable note must follow at the right without taking centering width");
        await Pointer(".history-prose [data-history-note]");
        await Check("document.querySelectorAll('.history-note-preview').length===1&&document.querySelector('.history-note-preview .history-dialogue-message').textContent.length>40", "Original source did not open inline");
        await Check("(()=>{const r=document.querySelector('.history-note-preview header').getBoundingClientRect(),v=document.querySelector('.standard-scroll').getBoundingClientRect();return r.top>=v.top&&r.bottom<=v.bottom;})()", "The opened source is outside the visible reading area");
        await Capture("source");
        await Pointer("[data-close-history-note]");
        await Check("!document.querySelector('.history-note-preview')&&document.activeElement.matches('[data-history-note]')", "Closing source did not return to the citation");
        await Check("(()=>{const refs=[...document.querySelectorAll('.history-prose [data-history-note]')];return new Set(refs.map(n=>n.dataset.historyNote)).size===refs.length&&document.querySelector('h2 [data-history-note=chronicle-2]')&&!document.querySelector('[data-history-note=chronicle-1]')&&![10,28,47,66,72,94,134].some(n=>document.querySelector('[data-history-note=chronicle-'+n+']'));})()", "Editorial omissions, title placement or one-reference-per-note failed");
        await Check("(()=>{const refs=[...document.querySelectorAll('.history-prose [data-history-note]')];return refs.length===116&&refs.every((n,i)=>Number(n.textContent.match(/\\d+/)[0])===i+6);})()", "Chronicle display numbers must continue after the five homepage preface notes");
        await Pointer("[data-history-note=chronicle-73]");
        await Wait("document.querySelectorAll('.history-note-preview .katex').length===11&&!document.querySelector('.history-note-preview .katex-error')");
        await WebView.CoreWebView2.ExecuteScriptAsync("window.__historyMathReady=false;document.fonts.ready.then(()=>requestAnimationFrame(()=>{window.__historyMathReady=true}));");
        await Wait("window.__historyMathReady===true");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),n=document.querySelector('.history-note-preview .katex');s.scrollTop+=n.getBoundingClientRect().top-s.getBoundingClientRect().top-document.querySelector('.history-note-heading').getBoundingClientRect().height-40;})()");
        await Check("(()=>{const s=document.querySelector('.standard-scroll'),m=document.querySelector('.history-note-preview .katex');return m.getBoundingClientRect().height>10&&getComputedStyle(m).fontFamily.toLowerCase().includes('katex')&&s.scrollWidth<=s.clientWidth+1;})()", "Actual equations or math fonts did not render within the source panel");
        await Capture("dialogue-formulas");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const s=document.querySelector('.standard-scroll'),n=document.querySelector('.history-note-preview [data-history-gap]');s.scrollTop+=n.getBoundingClientRect().top-s.getBoundingClientRect().top-document.querySelector('.history-note-heading').getBoundingClientRect().height-90;})()");
        await Check("(()=>{const g=document.querySelector('.history-note-preview [data-history-gap]');return g.parentElement.className==='history-dialogue'&&!g.closest('.history-dialogue-turn')&&getComputedStyle(g).display==='flex';})()", "Omission marker is still attributed to a speaker");
        await Capture("dialogue-omission");
        await Pointer("[data-close-history-note]");
        var top = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.standard-bar').getBoundingClientRect().top");
        await Pointer("[data-standard-menu=core]", false);
        await Check("(()=>{const p=document.querySelector('.standard-nav-panel'),r=p.getBoundingClientRect(),d=document.querySelector('.history-document').getBoundingClientRect();return !p.hidden&&p.querySelectorAll('nav a').length>30&&r.left>=d.left&&r.right<=d.right+1&&r.bottom<=d.bottom+1;})()", "History category menu escaped the reading surface");
        await Pointer(".standard-nav-panel nav a", false);
        await Check("!document.querySelector('.standard-nav-panel').hidden", "History hover bridge disappeared");
        await Capture("contents");
        await Pointer("[data-standard-menu=core]");
        await Check("document.querySelector('[data-standard-menu=core]').getAttribute('aria-pressed')==='false'", "History category did not fold");
        await Pointer(".standard-nav-panel nav a");
        await Check("document.querySelector('[data-standard-menu=core]').getAttribute('aria-pressed')==='mixed'&&!document.querySelector('.standard-nav-panel:not([hidden])')", "History jump did not reveal the selected section");
        await Capture("chapter");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href^='#history-three-']");
        await Check("document.querySelector('.history-document').dataset.historyVolume==='three'&&!document.querySelector('[id^=history-chronicle-]')", "Cross-work jump did not replace only the current work");
        await Pointer(".history-prose [data-history-note]");
        await Check("document.querySelector('.history-note-preview').id.startsWith('history-note-three-')", "Repeated note number resolved to a different author");
        await Pointer("[data-close-history-note]");
        await Pointer("[data-standard-menu=fold]");
        await Check("document.querySelectorAll('.history-source-record').length===204&&document.querySelector('details.source-notes').open", "Fold did not disclose complete source records");
        await Pointer("[data-standard-menu=fold]");
        await Check("!document.querySelector('details.source-notes').open", "Full source appendix did not fold again");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href='#history-chronicle-sources']");
        await Check("document.querySelectorAll('.history-source-record').length===121&&!document.querySelector('.history-source-dialogue-body .history-dialogue-turn')&&!document.querySelector('[data-dialogue-id=\"10\"]')&&[...document.querySelectorAll('.history-source-number')].every((n,i)=>Number(n.textContent)===i+1)&&document.querySelector('[data-dialogue-id=\"3\"] .history-source-number').textContent==='2'", "Source appendix must show consecutive numbers while retaining stable evidence IDs and deferred turns");
        await Pointer(".history-source-dialogue > summary");
        await Wait("document.querySelectorAll('.history-source-dialogue-body .history-dialogue-turn').length===6");
        await Capture("dialogue-appendix");
        await Pointer(".history-source-dialogue > summary");
        await Pointer(".history-note-back[href='#history-ref-chronicle-1-1']");
        await Check("!document.querySelector('.history-document').dataset.historyVolume&&document.activeElement.id==='history-ref-chronicle-1-1'&&document.querySelectorAll('#history-ref-chronicle-1-1').length===1", "Source appendix did not return to the moved home quotation");
        await Pointer("[data-standard-menu=all]");
        await Pointer(".standard-nav-panel a[href^='#history-three-']");
        await Check($$"""
            (()=>{const b=document.querySelector('.standard-bar'),r=b.getBoundingClientRect(),s=document.querySelector('.standard-scroll');return Math.abs(r.top-{{top}})<1&&s.scrollWidth<=s.clientWidth+1&&[...b.querySelectorAll('[data-standard-menu],.standard-return')].every(n=>{const x=n.getBoundingClientRect();return x.left>=r.left&&x.right<=r.right+1});})()
            """, "History bar moved or controls overflowed after deep navigation");
        // Switching theme does not replace the active work or its disclosure.
        var initialTheme = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme");
        await Pointer("[data-action=toggle-theme]");
        await Wait($"document.documentElement.dataset.theme!=={initialTheme}");
        await Check("document.querySelector('.history-document').dataset.historyVolume==='three'", "Theme switch lost the current work");
        await Pointer("[data-action=toggle-theme]");
        await Wait($"document.documentElement.dataset.theme==={initialTheme}");
        var pointRaw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.standard-scroll').getBoundingClientRect();return {x:r.right-4,y:r.top+60};})()");
        using (var point = JsonDocument.Parse(pointRaw))
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble() }));
        await Check("(()=>{const s=document.querySelector('.standard-scroll'),night=document.documentElement.dataset.theme==='star-night';return getComputedStyle(s,'::-webkit-scrollbar').width==='8px'&&s.classList.contains('cloudig-scroll-operating')&&getComputedStyle(s,'::-webkit-scrollbar-thumb').backgroundColor===(night?'rgb(255, 169, 46)':'rgb(214, 140, 128)');})()", "History does not use the shared interactive scrollbar colors");
        await Check($$"""
            JSON.stringify([...document.querySelectorAll('.reader-catalog,.reader-navigation,.archiver-bookmarks,.archiver-right')].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))===JSON.stringify({{sidebars}})
            """, "History changed the existing sidebars");
        await Pointer(".standard-return");
        await Check("!document.querySelector('.history-document')&&document.querySelector('.reader-main,.archiver-center').firstElementChild===window.__historyOriginal", "History return failed to restore the host");
        await Pointer("[data-doc-topic=roadmap]");
        await Wait("Boolean(document.querySelector('.history-document[data-document-ready=true]')&&document.querySelector('.history-home'))");
        TraceVisualAudit("history-document-pointer-roundtrip-passed", "full preface on home before eight works; home citations and source-appendix return; chronicle starts at chapter one; per-article illustrations; appeal 07 and references 08; category controls; local scrolling; themes; sidebars; return");
    }
}
