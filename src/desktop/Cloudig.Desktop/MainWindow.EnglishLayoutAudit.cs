using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task CheckEnglishLayoutGeometryAsync(VisualAuditOptions audit, string stage)
    {
        var vectorReady = false;
        for (var i=0;i<100;i++)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{if(document.documentElement.lang!=='en'||!document.querySelector('.reader-scene-statement')?.getClientRects().length)return true;let i=window.__welcomeVectorAudit;if(!i){i=new Image();i.src='/assets/reader/Reader-Welcome-Home-English.svg';window.__welcomeVectorAudit=i;}return i.complete&&i.naturalWidth===480&&i.naturalHeight>136;})()") == "true") { vectorReady=true; break; }
            await Task.Delay(30);
        }
        if (!vectorReady) throw new InvalidDataException("Reader's outlined welcome SVG did not load");
        var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{
              const en=document.documentElement.lang==='en', errors=[], images=[], poems=[], buttons=[], scene={};
              const visible=n=>Boolean(n?.getClientRects().length&&n.getBoundingClientRect().width&&n.getBoundingClientRect().height);
              const welcome=document.querySelector('[data-page=welcome]');
              if(visible(welcome)) {
                const title=welcome.querySelector('#welcome-title');
                if(title?.tagName!=='IMG'||title.getAttribute('src')!=='/assets/welcome/Cloudig-Logo-Title-Slogan.svg'||!visible(title)||!title.complete||!title.naturalWidth)errors.push('Welcome bilingual artwork changed');
                if(welcome.querySelector('.welcome-wordmark-en'))errors.push('Welcome must not have a separate English wordmark');
              }
              for(const n of document.querySelectorAll('img[data-brand-english]')) {
                const expected=en?n.dataset.brandEnglish:n.dataset.brandChinese;
                if(n.getAttribute('src')!==expected)errors.push('Wrong brand source: '+n.className);
              }
              if(!en) {
                const statement=document.querySelector('.reader-scene-statement');
                if(visible(statement)&&(getComputedStyle(statement).webkitTextStrokeWidth!=='0px'||getComputedStyle(statement,'::before').maskImage!=='none'))errors.push('Chinese statement must not inherit the English SVG');
                return {en,errors};
              }
              for(const n of document.querySelectorAll('img[src*="English-Grey-"]'))if(visible(n)) {
                const r=n.getBoundingClientRect();images.push({src:n.getAttribute('src'),width:r.width,height:r.height});
                if(!n.complete||!n.naturalWidth||!n.src.endsWith('.svg'))errors.push('English SVG not loaded: '+n.src);
              }
              for(const n of document.querySelectorAll('.cloudig-page-switch'))if(visible(n)) {
                const r=n.getBoundingClientRect(),c=getComputedStyle(n),range=document.createRange();range.selectNodeContents(n);
                const t=range.getBoundingClientRect(),left=t.left-r.left,right=r.right-t.right;
                const x=r.left+r.width/2,y=r.top+r.height/2,hit=n.contains(document.elementFromPoint(x,y));
                buttons.push({text:n.textContent,width:r.width,padding_left:c.paddingLeft,padding_right:c.paddingRight,left,right,hit});
                if(left<17||right<17||!hit||r.left<0||r.right>innerWidth)errors.push('Header button spacing/hit: '+n.textContent);
              }
              const brand=document.querySelector('.reader-scene-brand'),statement=document.querySelector('.reader-scene-statement');
              if(visible(brand)&&visible(statement)) {
                const b=brand.getBoundingClientRect(),s=statement.getBoundingClientRect(),c=getComputedStyle(statement),vector=getComputedStyle(statement,'::before');
                const slogan=[...brand.querySelectorAll('.reader-scene-brand-slogan')].find(visible).getBoundingClientRect();
                const center=s.left+s.width/2,lines=[...statement.children].map(n=>({text:n.textContent,clip:getComputedStyle(n).clipPath}));
                Object.assign(scene,{medium:'outlined-svg',mask:vector.maskImage,color:c.color,vector_color:vector.backgroundColor,layout_width:c.width,layout_height:c.height,lines,brand_center_delta:Math.abs(b.left+b.width/2-center),slogan_center_delta:Math.abs(slogan.left+slogan.width/2-center),brand_bottom:b.bottom,statement_top:s.top,statement_bottom:s.bottom});
                const expectedColor=document.documentElement.dataset.theme==='dawn'?'rgb(253, 252, 237)':'rgb(226, 225, 225)';
                if(c.color!==expectedColor||vector.backgroundColor!==c.color||!vector.maskImage.endsWith('/Reader-Welcome-Home-English.svg")'))errors.push('Reader vector asset/theme color');
                // Fractional WebView zoom rounds layout to subpixel units.
                if(Math.abs(parseFloat(c.width)-480)>.02||Math.abs(parseFloat(c.height)-136.64)>.02||scene.brand_center_delta>1||scene.slogan_center_delta>1||b.bottom>s.top)errors.push('Reader English lockup geometry');
                if(JSON.stringify(lines.map(n=>n.text))!==JSON.stringify(['Welcome Home,','OUR Clouds.'])||lines.some(n=>n.clip!=='inset(50%)'))errors.push('Reader English accessible words/vector paint');
                const entry=document.querySelector('.reader-archive-entry').getBoundingClientRect();
                if(s.bottom>entry.top)errors.push('Reader welcome overlaps the archive entry');
              }
              const archiver=document.querySelector('[data-page=archiver]');
              if(archiver) {
                for(const n of archiver.querySelectorAll('.archiver-bookmark-poem,.archiver-right-poem'))if(visible(n)) {
                  const r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect(),c=getComputedStyle(n);
                  const delta=Math.abs(r.left+r.width/2-p.left-p.width/2);
                  poems.push({class:n.className,font:c.fontSize,center_delta:delta,lines:[...n.children].map(s=>s.textContent)});
                  if(delta>1||parseFloat(c.fontSize)<16||c.textAlign!=='left')errors.push('Poem block alignment/size: '+n.className);
                  if(r.left<p.left-1||r.right>p.right+1||r.bottom>p.bottom+1)errors.push('Poem exceeds rail: '+n.className);
                }
                if(new Set(poems.map(n=>n.font)).size>1)errors.push('Poem sizes differ');
                for(const [id,label] of [['doubao','Doubao'],['chatglm','ChatGLM'],['yuanbao','Yuanbao']]) {
                  if(archiver.querySelector(`[data-platform=${id}] strong > span`)?.textContent!==label)errors.push('Untranslated platform: '+id);
                }
                for(const n of archiver.querySelectorAll('.archiver-bookmark-install,.archiver-install-all'))if(visible(n)) {
                  const r=n.getBoundingClientRect(),c=getComputedStyle(n),range=document.createRange();range.selectNodeContents(n);
                  const fragments=[...range.getClientRects()];
                  const fits=fragments.every(t=>t.left>=r.left+parseFloat(c.paddingLeft)-1&&t.right<=r.right-parseFloat(c.paddingRight)+1&&t.top>=r.top-1&&t.bottom<=r.bottom+1);
                  buttons.push({text:n.textContent,width:r.width,padding_right:c.paddingRight,fits});
                  if(!fits)errors.push('Button text overflow: '+n.textContent);
                }
              }
              return {en,errors,images,poems,buttons,scene};
            })()
            """);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, stage + ".english-layout.json"), raw);
        using var result = JsonDocument.Parse(raw);
        if (result.RootElement.GetProperty("errors").GetArrayLength() != 0) throw new InvalidDataException("English layout: " + raw);
    }

    private async Task VerifyEnglishLayoutAsync(VisualAuditOptions audit)
    {
        await CheckEnglishLayoutGeometryAsync(audit, "initial");
        foreach (var language in new[] { "zh-CN", "en" })
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
                (()=>{const b=document.querySelector('[data-action=toggle-language],[data-archiver-shell-action=toggle-language]');
                  const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:b.contains(document.elementFromPoint(x,y))};})()
                """);
            using var point = JsonDocument.Parse(raw);
            if (!point.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidDataException("Language switch is covered");
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
            var ready = false;
            for (var i=0;i<160;i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    document.documentElement.lang==={{JsonSerializer.Serialize(language)}} && [...document.images].filter(n=>n.getClientRects().length).every(n=>n.complete&&n.naturalWidth>0)
                    """) == "true") { ready=true; break; }
                await Task.Delay(50);
            }
            if (!ready) throw new TimeoutException("English layout language roundtrip");
            await CheckEnglishLayoutGeometryAsync(audit, language);
            await using var output = File.Create(Path.ChangeExtension(audit.OutputFile, language + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
        }
        await CaptureEnglishStatementAsync(audit);
        // Exercise the resized header controls with real hit-tested pointer input.
        if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-page-switch'))") == "true")
        {
            for (var round = 0; round < 2; round++)
            {
                var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
                    (()=>{const b=document.querySelector('.cloudig-page-switch'),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                      return{x,y,target:b.dataset.routeTarget,hit:b.contains(document.elementFromPoint(x,y))};})()
                    """);
                using var point = JsonDocument.Parse(raw);
                if (!point.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidDataException("Header route switch is covered");
                foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                    await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
                var selector = $"[data-page={point.RootElement.GetProperty("target").GetString()}]";
                var ready = false;
                for (var i=0;i<200;i++)
                {
                    if (await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                        Boolean(document.querySelector({{JsonSerializer.Serialize(selector)}})) && document.querySelector('.route-transition').hidden && [...document.images].filter(n=>n.getClientRects().length).every(n=>n.complete&&n.naturalWidth>0)
                        """) == "true") { ready=true; break; }
                    await Task.Delay(50);
                }
                if (!ready) throw new TimeoutException("English header navigation roundtrip");
                await CheckEnglishLayoutGeometryAsync(audit, "navigation-" + round);
            }
            TraceVisualAudit("english-header-navigation-roundtrip-passed");
        }
        TraceVisualAudit("english-layout-language-roundtrip-passed");
    }

    private async Task CaptureEnglishStatementAsync(VisualAuditOptions audit)
    {
        var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const n=document.querySelector('.reader-scene-statement');if(!n?.getClientRects().length||document.documentElement.lang!=='en')return null;
              const r=n.getBoundingClientRect();return {x:r.left-3,y:r.top-3,width:r.width+6,height:r.height+6,scale:1};})()
            """);
        if (raw == "null") return;
        using var bounds = JsonDocument.Parse(raw);
        var b = bounds.RootElement;
        // WebView's native zoom is outside DOM CSS coordinates; CDP capture
        // clips use the unzoomed host viewport. Keep the crop on the same text.
        var zoom = WebView.ZoomFactor;
        var clip = new { x=b.GetProperty("x").GetDouble()*zoom, y=b.GetProperty("y").GetDouble()*zoom, width=b.GetProperty("width").GetDouble()*zoom, height=b.GetProperty("height").GetDouble()*zoom, scale=1 };
        async Task Capture(string name)
        {
            using var shot = JsonDocument.Parse(await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.captureScreenshot", JsonSerializer.Serialize(new { format="png", clip })));
            await File.WriteAllBytesAsync(Path.ChangeExtension(audit.OutputFile, name + ".png"), Convert.FromBase64String(shot.RootElement.GetProperty("data").GetString()!));
        }
        await Capture("statement");
    }
}
