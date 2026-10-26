using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private sealed class OfflineWorkAuditHttp : System.Net.Http.HttpMessageHandler
    {
        protected override Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, CancellationToken cancellationToken)
            => throw new System.Net.Http.HttpRequestException("Offline work audit: external component request refused");
    }
    private readonly List<CoreWebView2Frame> _savedWorkAuditFrames = new();
    private readonly HashSet<CoreWebView2Frame> _destroyedSavedWorkAuditFrames = new();

    private void TrackSavedWorkFrame(object? sender, CoreWebView2FrameCreatedEventArgs args)
    {
        // Subscribe before navigation: an inline Box may already exist when
        // the page becomes ready. Enlarging it must not recreate its frame.
        var frame = args.Frame;
        _savedWorkAuditFrames.Add(frame);
        frame.Destroyed += (_, _) => _destroyedSavedWorkAuditFrames.Add(frame);
    }

    private async Task VerifySavedWorksAsync(VisualAuditOptions audit)
    {
        const string modal = ".cloudig-interactive-window:not(.cloudig-interactive-box)";
        var frames = _savedWorkAuditFrames; var destroyed = _destroyedSavedWorkAuditFrames;
        var results = new List<JsonElement>(); var opening = new List<JsonElement>(); var audio = new List<object>(); var timings = new List<JsonElement>();
        var muted = WebView.CoreWebView2.IsMuted; WebView.CoreWebView2.IsMuted = true;
        async Task<string> Read(string script, CoreWebView2Frame? frame = null) => frame is null ? await WebView.CoreWebView2.ExecuteScriptAsync(script) : await frame.ExecuteScriptAsync(script);
        async Task Capture(string name) { await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, name + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream); }
        async Task Wait(string expression, CoreWebView2Frame? frame = null)
        {
            for (var n = 0; n < 600; n++)
            {
                if (await Read(expression, frame) == "true") return;
                if (await Read($"Boolean(document.querySelector('{modal}[data-state=failed]'))") == "true") break;
                await Task.Delay(50);
            }
            await Capture("work-failed");
            throw new InvalidDataException("Saved work failed: " + expression + "; " + await Read($"document.querySelector('{modal}')?.textContent"));
        }
        async Task<(double X, double Y)> Point(string selector, CoreWebView2Frame? frame = null)
        {
            var literal = JsonSerializer.Serialize(selector);
            if (frame is null) await Read($$"""
                (()=>{const n=document.querySelector({{literal}}),s=n?.closest('.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();s.scrollTop+=r.top-v.top-(v.height-r.height)/2;} })()
                """);
            else await Read($$"""document.querySelector({{literal}})?.scrollIntoView({block:'center',inline:'nearest'})""", frame);
            await Task.Delay(100);
            using var point = JsonDocument.Parse(await Read($$"""
                (()=>{const n=document.querySelector({{literal}});if(!n)return null;const s=n.closest('.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8||r.bottom>v.bottom-8)s.scrollTop+=r.top-v.top-(v.height-r.height)/2;}const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """, frame));
            if (point.RootElement.ValueKind == JsonValueKind.Null) { await Capture("work-obstructed"); throw new InvalidDataException("Saved work pointer obstructed: " + selector); }
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            if (frame is not null)
            {
                using var rect = JsonDocument.Parse(await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();return{{x:r.x,y:r.y}};}})()"));
                x += rect.RootElement.GetProperty("x").GetDouble(); y += rect.RootElement.GetProperty("y").GetDouble();
            }
            return (x, y);
        }
        async Task Mouse(string type, double x, double y, bool down = false) => await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = type == "mouseMoved" && !down ? "none" : "left", buttons = down ? 1 : 0, clickCount = type == "mouseMoved" ? 0 : 1 }));
        async Task Pointer(string selector, CoreWebView2Frame? frame = null, int hold = 0)
        {
            // Fonts, chart layout and a naturally sized parent may settle after
            // load. Hit-test the final frame-relative coordinates, not a stale point.
            var p = await Point(selector, frame);var stable=0;var positions=new List<object>();var subpixel=false;
            for(var n=0;n<12&&stable<2;n++){
                await Task.Delay(80);var next=await Point(selector,frame);
                var dx=Math.Abs(next.X-p.X);var dy=Math.Abs(next.Y-p.Y);positions.Add(new{x=next.X,y=next.Y,dx,dy});
                // Centering a scroller can alternate adjacent fractional CSS
                // coordinates at Windows DPI. Every Point already hit-tests
                // the exact element; subpixel rounding is not moving layout.
                subpixel|=(dx>=.5||dy>=.5)&&dx<1&&dy<1;
                stable=dx<1&&dy<1?stable+1:0;p=next;
            }
            if(stable<2)throw new InvalidDataException("Saved work target did not settle: "+selector+"; "+JsonSerializer.Serialize(positions));
            if(subpixel)await File.AppendAllTextAsync(Path.ChangeExtension(audit.OutputFile,".pointer-rounding.jsonl"),JsonSerializer.Serialize(new{selector,positions})+"\n");
            await Mouse("mouseMoved", p.X, p.Y); await Mouse("mousePressed", p.X, p.Y, true);
            if (hold > 0) await Task.Delay(hold); await Mouse("mouseReleased", p.X, p.Y); await Task.Delay(120);
        }
        async Task<CoreWebView2Frame> CurrentFrame()
        {
            var hash = await Read($"new URL(document.querySelector('{modal} iframe').src).hash");
            foreach (var frame in frames.Where(frame => !destroyed.Contains(frame)).Reverse())
                if (await Read("location.hash", frame) == hash) return frame;
            throw new InvalidDataException("Native work frame not found");
        }
        async Task Close(CoreWebView2Frame frame)
        {
            await Pointer(modal + " .cloudig-interactive-close"); await Wait($"!document.querySelector('{modal}')");
            for (var n = 0; n < 100 && !destroyed.Contains(frame); n++) await Task.Delay(20);
            if (!destroyed.Contains(frame)) throw new InvalidDataException("Closing the work did not destroy its native frame");
        }
        async Task AudioState(bool playing)
        {
            // Native WebView reports playing audio even while muted. This
            // includes child work frames, unlike a main-target CDP receiver.
            for (var n = 0; n < 200; n++)
            {
                if (WebView.CoreWebView2.IsDocumentPlayingAudio == playing) { audio.Add(new { playing, muted = WebView.CoreWebView2.IsMuted }); return; }
                await Task.Delay(50);
            }
            throw new InvalidDataException("Native audio state did not become " + playing);
        }
        async Task ScrollProbe(CoreWebView2Frame frame)
        {
            // The host supplies a fallback, never replaces a work's scrollbar.
            // Gemini, for example, ships its own standard + WebKit declarations.
            var authored = await Read("[...document.querySelectorAll('style:not([data-cloudig-scroll-fallback])')].some(s=>/scrollbar(?:-width|-color|\\s|:)/.test(s.textContent))",frame);
            if(authored=="true") { TraceVisualAudit("saved-work-authored-scrollbar-preserved", "Host fallback probe is inapplicable to this author's explicit rules"); return; }
            // Explicit ephemeral audit elements, not replacements for source
            // artwork. Exercise fallback and author overrides in this real frame.
            await Read("(()=>{const s=document.createElement('style');s.id='audit-scroll-style';s.textContent='#audit-author::-webkit-scrollbar{width:17px}#audit-author::-webkit-scrollbar-thumb{background:rgb(30,160,120)}';document.head.append(s);for(const [id,left] of [['audit-default',10],['audit-author',270]]){const n=document.createElement('div');n.id=id;n.style.cssText=`position:fixed;z-index:2147483647;left:${left}px;top:10px;width:230px;height:160px;overflow:auto;background:#777;color:white`;n.innerHTML='<div style=\"height:900px;padding:12px\">Scrollbar audit</div>';document.body.append(n)}})()", frame);
            await Pointer("#audit-default", frame);
            await Wait("getComputedStyle(document.querySelector('#audit-default'),'::-webkit-scrollbar').width==='8px'&&getComputedStyle(document.querySelector('#audit-author'),'::-webkit-scrollbar').width==='17px'&&getComputedStyle(document.querySelector('#audit-author'),'::-webkit-scrollbar-thumb').backgroundColor==='rgb(30, 160, 120)'", frame);
            await Capture("scroll-fallback-idle");
            using var position = JsonDocument.Parse(await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();return{{x:r.x+10+230-4,y:r.y+10+24}};}})()"));
            var x=position.RootElement.GetProperty("x").GetDouble();var y=position.RootElement.GetProperty("y").GetDouble();
            await Mouse("mouseMoved",x,y);await Task.Delay(100);
            await Wait("document.querySelector('#audit-default').classList.contains('cloudig-scroll-operating')",frame);await Capture("scroll-fallback-active");
            await Mouse("mousePressed",x,y,true);await Mouse("mouseMoved",x,y+90,true);await Mouse("mouseReleased",x,y+90);
            await Wait("document.querySelector('#audit-default').scrollTop>0",frame);await Capture("scroll-fallback-drag");
            await Read("document.querySelectorAll('#audit-default,#audit-author,#audit-scroll-style').forEach(n=>n.remove())",frame);
        }
        try
        {
            await Wait("document.querySelector('.route-transition').hidden&&Boolean(document.querySelector('[data-reader-renderer] .cloudig-message'))");
            // Expand first: that user action rebuilds the rendered range.
            // Paging before it would silently discard the source's tail.
            if(await Read("Boolean(document.querySelector('[data-i18n=\"reader.expandThoughtsTools\"]'))")=="true") {
                await Read("document.querySelector('[data-reader-renderer] > *')?.setAttribute('data-work-audit-old-render','true')");
                await Pointer("[data-i18n=\"reader.expandThoughtsTools\"]");
                await Wait("!document.querySelector('[data-work-audit-old-render]')&&!document.querySelector('.cloudig-process-group:not([open])')");
            }
            // Real long sources can put every work after the first page. Use
            // the Reader's own navigation/paging before counting works; an
            // empty first page is not proof the Parser lost the artifacts.
            if(await Read("Boolean(document.querySelector('[data-reader-navigation-jump=last]'))")=="true"){
                await Pointer("[data-reader-navigation-jump=last]");
                await Task.Delay(350);
                await Wait("document.querySelector('.reader-conversation-loading')?.hidden===true");
                for(var page=0;page<64;page++){
                    if(await Read("Boolean(document.querySelector('[data-reader-load-earlier]:not([hidden])'))")!="true")break;
                    await Pointer("[data-reader-load-earlier]");
                    await Wait("!document.querySelector('[data-reader-load-earlier]').disabled");
                    if(page==63)throw new InvalidDataException("Work audit did not finish loading the source message range");
                }
            }
            if(audit.Query.Contains("reader-header-review=1",StringComparison.Ordinal)) {
                var metrics=await Read("(()=>{const rect=n=>n?{x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}:null;const heads=[...document.querySelectorAll('.cloudig-message-identity:has(.cloudig-avatar)')].slice(0,6).map(n=>({avatar:rect(n.querySelector('.cloudig-avatar')),name:rect(n.querySelector('.cloudig-message-name')),time:rect(n.querySelector('time')),timeText:n.querySelector('time')?.textContent,heading:rect(n)}));const elapsed=[...document.querySelectorAll('.cloudig-process-static')].filter(n=>n.textContent.includes('共用时')).map((n,i)=>{n.dataset.auditElapsed=String(i);const next=n.nextElementSibling;return {text:n.textContent,status:rect(n),next:rect(next),html:next?.outerHTML.slice(0,2000),gap:next?next.getBoundingClientRect().top-n.getBoundingClientRect().bottom:null};});const dots=[...document.querySelectorAll('.cloudig-process,.cloudig-message-content')].slice(0,12).map(n=>({class:n.className,display:getComputedStyle(n,'::before').display,fill:getComputedStyle(n,'::before').backgroundColor,ring:getComputedStyle(n,'::before').borderColor,left:getComputedStyle(n,'::before').left}));return{heads,elapsed,dots};})()");
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".reader-header.json"),metrics);
                await Point(".cloudig-message-identity:has(.cloudig-avatar)");await Capture("reader-heading");
                var elapsedCount=int.Parse(await Read("document.querySelectorAll('[data-audit-elapsed]').length"));
                for(var i=0;i<elapsedCount;i++){await Point($"[data-audit-elapsed='{i}']");await Capture($"elapsed-{i}");}
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".works.json"),"{\"reader_header_review\":true}");
                TraceVisualAudit("reader-saved-works-pointer-passed","Reader header/source time/ring nodes and elapsed spacing inspected");return;
            }
            await Wait(audit.Query.Contains("work-media=1",StringComparison.Ordinal)
                ? "Boolean(document.querySelector('.cloudig-media-player'))"
                : "Boolean(document.querySelector('.cloudig-window-entry > button.cloudig-box-button,.cloudig-interactive-box'))");
            if(audit.Query.Contains("work-theme=1",StringComparison.Ordinal)) {
                await Task.Delay(500);
                var total=int.Parse(await Read("(()=>{const a=[...document.querySelectorAll('.cloudig-interactive-box')];a.forEach((n,i)=>n.dataset.themeAudit=String(i));return a.length})()"));
                var evidence=new List<JsonElement>();
                for(var i=0;i<total;i++) {
                    var selector=$"[data-theme-audit='{i}']"; var literal=JsonSerializer.Serialize(selector);
                    using(var area=JsonDocument.Parse(await Read("(()=>{const r=document.querySelector('.reader-conversation-scroll').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")))
                        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseWheel",x=area.RootElement.GetProperty("x").GetDouble(),y=area.RootElement.GetProperty("y").GetDouble(),deltaX=0,deltaY=1}));
                    await Point(selector+" .cloudig-interactive-header");
                    await Wait($$"""document.querySelector({{literal}}).dataset.state==='ready'""");
                    await Task.Delay(400);
                    await Read($$"""(()=>{const n=document.querySelector({{literal}}),f=n.querySelector('iframe');window.__themeWitness={node:n,frame:f,top:n.getBoundingClientRect().top,src:f.src};return true})()""");
                    await Capture($"theme-{i}-before");
                    for(var pass=0;pass<2;pass++) {
                        await Read("(()=>{const b=[...document.querySelectorAll('[data-action=toggle-theme]')].find(n=>n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0);b.dataset.themeAuditButton='true'})()");
                        await Pointer("[data-theme-audit-button]");
                        await Task.Delay(1200);
                        var fact=await Read("(()=>{const w=window.__themeWitness,n=w.node,f=n.querySelector('iframe'),r=n.getBoundingClientRect(),b=n.querySelector('.cloudig-interactive-body').getBoundingClientRect();return{sameNode:n.isConnected,sameFrame:f===w.frame,srcUnchanged:f?.src===w.src,drift:Math.abs(r.top-w.top),height:b.height,viewport:innerHeight,theme:n.dataset.theme,pass:n.isConnected&&f===w.frame&&f?.src===w.src&&Math.abs(r.top-w.top)<3&&b.height<innerHeight}})()");
                        using var parsed=JsonDocument.Parse(fact);evidence.Add(parsed.RootElement.Clone());
                        await Capture($"theme-{i}-switch-{pass}");
                        if(!parsed.RootElement.GetProperty("pass").GetBoolean())throw new InvalidDataException("Theme changed the running Box or reading position: "+fact);
                    }
                    var savedSrc=await Read($$"""document.querySelector({{literal}}).querySelector('iframe').src""");
                    await Pointer(selector+" .cloudig-interactive-enlarge");await Wait($"Boolean(document.querySelector('{modal}[open] iframe'))");
                    if(await Read($"document.querySelector('{modal} iframe').src")!=savedSrc)throw new InvalidDataException("Enlarge restarted the theme-tested Box");
                    if(i==0){
                        await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();window.__sourceSize=[r.width,r.height]}})()");
                        await Pointer(modal+" .cloudig-interactive-toolbar button:nth-of-type(3)");
                        await Wait($"document.querySelector('{modal}').dataset.state==='source'");
                        if(await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();return Math.abs(r.width-window.__sourceSize[0])<1&&Math.abs(r.height-window.__sourceSize[1])<1;}})()")!="true")throw new InvalidDataException("Source view resized the live Box canvas");
                        await Capture("box-source");await Pointer(modal+" .cloudig-interactive-toolbar button:first-child");
                        await Wait($"document.querySelector('{modal}').dataset.state==='ready'");
                        if(await Read($"document.querySelector('{modal} iframe').src")!=savedSrc)throw new InvalidDataException("Box source tab restarted the running work");
                        TraceVisualAudit("box-source-state-passed","Enlarged inline Box retained the same runtime across source view");
                    }
                    await Capture($"theme-{i}-enlarged");await Pointer(modal+" .cloudig-interactive-close");await Wait($"!document.querySelector('{modal}')");
                    if(await Read($$"""document.querySelector({{literal}}).querySelector('iframe').src""")!=savedSrc)throw new InvalidDataException("Returning restarted the theme-tested Box");
                }
                // A Window-only source also returns to its starting theme.
                if(total==0){
                    await Read("window.__themeCard=document.querySelector('.cloudig-dil-view,.cloudig-box')");
                    for(var pass=0;pass<2;pass++){
                        await Read("(()=>{const b=[...document.querySelectorAll('[data-action=toggle-theme]')].find(n=>n.getBoundingClientRect().width>0);b.dataset.themeAuditButton='true'})()");
                        await Pointer("[data-theme-audit-button]");await Task.Delay(500);
                        if(await Read("window.__themeCard?.isConnected")!="true")throw new InvalidDataException("Theme replaced structured card");
                        await Capture($"structured-theme-{pass}");
                    }
                }
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".theme-works.json"),JsonSerializer.Serialize(new{inline_works=total,evidence}));
                TraceVisualAudit("reader-saved-works-pointer-passed","Theme roundtrips preserved live Box frame, position and viewport geometry");return;
            }
            if(audit.Query.Contains("work-kimi=1",StringComparison.Ordinal)) {
                foreach(var selector in new[]{".cloudig-message-assistant .cloudig-rich", ".plugin-node", ".cloudig-source-list"}) {
                    if(await Read($"Boolean(document.querySelector({JsonSerializer.Serialize(selector)}))")=="true") { await Point(selector);await Capture("kimi-reading-"+(selector.Contains("plugin")?"plugin":selector.Contains("source")?"sources":"mixed")); }
                }
                var icons=await Read("[...document.querySelectorAll('.plugin-node .cloudig-resource-image')].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))");
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".kimi-icons.json"),icons);
                using var iconData=JsonDocument.Parse(icons);foreach(var icon in iconData.RootElement.EnumerateArray())if(icon.GetProperty("width").GetDouble()>24||icon.GetProperty("height").GetDouble()>24)throw new InvalidDataException("A captured plugin icon became a conversation image");
            }
            if(audit.Query.Contains("work-review=1",StringComparison.Ordinal)) {
                await Wait("[...document.querySelectorAll('.cloudig-message-assistant:not([data-agent-instance]) .cloudig-message-name')].some(n=>n.textContent==='统一智能 · Global AI')");
                var spacing=await Read("(()=>{return [...document.querySelectorAll('.cloudig-message-user .cloudig-message-content')].slice(0,3).map(b=>{const ps=[...b.querySelectorAll('p')],p=ps.at(-1);return{height:b.getBoundingClientRect().height,lastMargin:p?getComputedStyle(p).marginBottom:null};});})()");
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".bubble-spacing.json"),spacing);
                await Point(".cloudig-message-user .cloudig-message-content");await Capture("bubble-and-global-name");
            }
            if(audit.Query.Contains("work-media=1",StringComparison.Ordinal)||audit.Query.Contains("work-kimi=1",StringComparison.Ordinal)) {
                var mediaCount=int.Parse(await Read("(()=>{const a=[...document.querySelectorAll('.cloudig-media-player')];a.forEach((n,i)=>n.dataset.auditMedia=String(i));return a.length;})()"));
                if(mediaCount==0)throw new InvalidDataException("Media audit has no source player");
                for(var m=0;m<mediaCount;m++) {
                    var sel=$"[data-audit-media='{m}']";
                    await Point(sel+" .cloudig-audio-toggle,"+sel+" video");await Capture($"media-{m}-before");
                    if(await Read($"Boolean(document.querySelector(\"{sel} .cloudig-audio-controls\"))")=="true") {
                        var paint=await Read($"(()=>{{const c=document.querySelector(\"{sel} .cloudig-audio-controls\"),b=c.querySelector('button'),s=getComputedStyle(c),r=b.getBoundingClientRect(),svg=c.querySelector('svg').getBoundingClientRect();return{{display:s.display,buttonWidth:r.width,buttonHeight:r.height,iconWidth:svg.width,background:s.backgroundColor,centre:Math.abs(r.y+r.height/2-(c.getBoundingClientRect().y+c.getBoundingClientRect().height/2))}}}})()");
                        using(var p=JsonDocument.Parse(paint))if(p.RootElement.GetProperty("display").GetString()!="grid"||p.RootElement.GetProperty("buttonWidth").GetDouble()<40||p.RootElement.GetProperty("iconWidth").GetDouble()<18||p.RootElement.GetProperty("centre").GetDouble()>2)throw new InvalidDataException("Inline media stylesheet/centering failed: "+paint);
                        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".media-{m}-paint.json"),paint);
                        if(await Read($"document.querySelector(\"{sel} audio\").volume===0.5")!="true")throw new InvalidDataException("New audio does not start at 50% volume");
                        using(var volume=JsonDocument.Parse(await Read($"(()=>{{const n=document.querySelector(\"{sel} .cloudig-audio-volume-range\"),r=n.getBoundingClientRect(),x=r.left+r.width*.35,y=r.top+r.height/2;return n===document.elementFromPoint(x,y)?{{x,y}}:null;}})()"))){
                            if(volume.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Volume slider is missing or obscured");
                            var vx=volume.RootElement.GetProperty("x").GetDouble();var vy=volume.RootElement.GetProperty("y").GetDouble();await Mouse("mouseMoved",vx,vy);await Mouse("mousePressed",vx,vy,true);await Mouse("mouseReleased",vx,vy);
                        }
                        await Wait($"(()=>{{const a=document.querySelector(\"{sel} audio\"),s=document.querySelector(\"{sel} .cloudig-audio-volume-range\");return a.volume>.2&&a.volume<.45&&Math.abs(Number(s.value)/100-a.volume)<.01;}})()");
                        await Capture($"media-{m}-volume");
                        await Read($"document.querySelector(\"{sel} audio\").volume=0.5");
                        var priorVolume=await Read($"document.querySelector(\"{sel} audio\").volume");
                        await Read($"(()=>{{const a=document.querySelector(\"{sel} audio\");a.volume=0;a.muted=false;}})()");
                        await Wait($"document.querySelector(\"{sel} .cloudig-audio-mute\").getAttribute('aria-pressed')==='true'");
                        await Pointer(sel+" .cloudig-audio-mute");
                        await Wait($"(()=>{{const a=document.querySelector(\"{sel} audio\");return !a.muted&&a.volume>0;}})()");
                        await Read($"document.querySelector(\"{sel} audio\").volume={priorVolume}");
                        TraceVisualAudit("media-zero-volume-unmute-passed", "Native pointer restored volume; source bytes untouched");
                    }
                    if(await Read($"!document.querySelector(\"{sel} .cloudig-media-play\").hidden")=="true") {
                        await Pointer(sel+" .cloudig-media-play");
                        await Wait($"['ready','failed'].includes(document.querySelector(\"{sel}\").dataset.playback)");
                    } else if(await Read($"document.querySelector(\"{sel}\").dataset.mode==='offline'")=="true") {
                        // Click the actual audio control or Chromium video
                        // control; hidden native audio has no hit rectangle.
                        if(await Read($"Boolean(document.querySelector(\"{sel} .cloudig-audio-toggle\"))")=="true")await Pointer(sel+" .cloudig-audio-toggle");
                        else {
                        using var point=JsonDocument.Parse(await Read($"(()=>{{const v=document.querySelector(\"{sel} audio,{sel} video\"),r=v.getBoundingClientRect();return{{x:r.left+28,y:v.tagName==='AUDIO'?r.top+r.height/2:r.bottom-24}}}})()"));
                        var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();
                        await Mouse("mouseMoved",x,y);await Mouse("mousePressed",x,y,true);await Mouse("mouseReleased",x,y);
                        }
                        await Wait($"document.querySelector(\"{sel} audio,{sel} video\").currentTime>0||document.querySelector(\"{sel}\").dataset.playback==='failed'");
                    }
                    if(audit.Query.Contains("work-review=1",StringComparison.Ordinal)&&await Read($"(()=>{{const p=document.querySelector(\"{sel}\");return p.dataset.mode==='offline'&&p.querySelectorAll('.cloudig-timed-lyrics li').length>1;}})()") == "true") {
                        // Real native play was clicked above. Now exercise a
                        // deterministic seek and its actual media time event.
                        await Read($"(()=>{{const p=document.querySelector(\"{sel}\"),v=p.querySelector('audio,video');v.currentTime=Math.min(v.duration/2,25);}})()");
                        await Wait($"Boolean(document.querySelector(\"{sel} .cloudig-timed-lyrics [aria-current=true]\"))");await Task.Delay(600);
                        await Point(sel+" .cloudig-music-stage");await Capture($"media-{m}-rolling-lyrics");
                    }
                    using(var state=JsonDocument.Parse(await Read($"(()=>{{const p=document.querySelector(\"{sel}\"),v=p.querySelector('audio,video');return{{mode:p.dataset.mode,playback:p.dataset.playback||'',status:p.querySelector('.cloudig-media-status').textContent,readyState:v.readyState,time:v.currentTime,lyrics:p.querySelectorAll('.cloudig-media-lyrics li').length,lyricTransform:p.querySelector('.cloudig-timed-lyrics')?.style.transform,activeLyric:p.querySelector('.cloudig-timed-lyrics [aria-current=true]')?.textContent,cover:p.querySelector('img')?{{complete:p.querySelector('img').complete,width:p.querySelector('img').naturalWidth,displayWidth:p.querySelector('img').getBoundingClientRect().width}}:null}}}})()"))) {
                        var row=state.RootElement;
                        if(row.GetProperty("playback").GetString()=="failed"&&string.IsNullOrWhiteSpace(row.GetProperty("status").GetString()))throw new InvalidDataException("Failed media has no explanation");
                        if(row.GetProperty("cover").ValueKind!=JsonValueKind.Null&&row.GetProperty("cover").GetProperty("width").GetInt32()==0)throw new InvalidDataException("Media cover failed to decode");
                        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".media-{m}.json"),state.RootElement.GetRawText());
                    }
                    await Capture($"media-{m}-result");await Read($"document.querySelector(\"{sel} audio,{sel} video\").pause()");
                }
            }
            async Task CheckKimi(CoreWebView2Frame frame, string name)
            {
                    if(await Read("Boolean(document.querySelector('#cloudig-project-input'))",frame)=="true")await Wait("document.querySelector('#root').children.length>0",frame);
                    if(await Read("[...document.querySelectorAll('*')].some(e=>e.shadowRoot?.querySelectorAll('button').length>1)",frame)=="true")
                    {
                        var beforeShadow=await Read("[...document.querySelectorAll('*')].find(e=>e.shadowRoot)?.shadowRoot.textContent",frame);
                        using var shadowPoint=JsonDocument.Parse(await Read("(()=>{const host=[...document.querySelectorAll('*')].find(e=>e.shadowRoot?.querySelectorAll('button').length>1),root=host.shadowRoot,b=root.querySelector('button[aria-pressed=false]')??[...root.querySelectorAll('button')].find(b=>!b.disabled);b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return b.contains(root.elementFromPoint(x,y))?{x,y}:null})()",frame));
                        if(shadowPoint.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Shadow control is obstructed");
                        using var framePoint=JsonDocument.Parse(await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();return{{x:r.x,y:r.y}}}})()"));
                        var sx=shadowPoint.RootElement.GetProperty("x").GetDouble()+framePoint.RootElement.GetProperty("x").GetDouble();var sy=shadowPoint.RootElement.GetProperty("y").GetDouble()+framePoint.RootElement.GetProperty("y").GetDouble();
                        await Mouse("mouseMoved",sx,sy);await Mouse("mousePressed",sx,sy,true);await Mouse("mouseReleased",sx,sy);await Task.Delay(150);
                        if(await Read("[...document.querySelectorAll('*')].find(e=>e.shadowRoot)?.shadowRoot.textContent",frame)==beforeShadow)throw new InvalidDataException("Shadow control did not respond");
                    }
                    if(await Read("Boolean(document.querySelector('input[type=range]'))",frame)=="true")
                    {
                        var before=await Read("document.querySelector('input[type=range]').value",frame);
                        await Pointer("input[type=range]",frame);
                        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyDown\",\"key\":\"End\",\"code\":\"End\",\"windowsVirtualKeyCode\":35}");
                        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyUp\",\"key\":\"End\",\"code\":\"End\",\"windowsVirtualKeyCode\":35}");
                        if(await Read("document.querySelector('input[type=range]').value",frame)==before)throw new InvalidDataException("Kimi work slider did not respond to native input");
                    }
                    await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".kimi-{name}.json"),await Read("(()=>({text:document.body.innerText.slice(0,1200),math:document.querySelectorAll('.katex').length,canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),shadowHosts:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).length,images:[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth})),fonts:document.fonts.status}))()",frame));
            }
            var count = int.Parse(await Read("(()=>{const b=[...document.querySelectorAll('.cloudig-window-entry > button.cloudig-work-open')];b.forEach((n,i)=>n.dataset.nativeWork=String(i));return b.length;})()"));
            if(audit.Query.Contains("inline-works-only=1",StringComparison.Ordinal))count=0;
            if(audit.Query.Contains("work-media-files=1",StringComparison.Ordinal))count=0;
            if (await Read($"Boolean(document.querySelector('{modal} iframe'))") != "false") throw new InvalidDataException("A heavy work ran before opening");
            for (var i = 0; i < count; i++)
            {
                var selector = $"[data-native-work='{i}']";
                if (i==0) { await Point(selector); await Capture("work-entry"); }
                await Pointer(selector);
                using(var motion=JsonDocument.Parse(await Read($"(()=>{{const d=document.querySelector('{modal}');if(d?.dataset.state!=='loading')return null;const s=d.querySelector('.cloudig-interactive-status'),c=getComputedStyle(s,'::before');return{{index:{i},name:c.animationName,duration:c.animationDuration,play:c.animationPlayState,colour:c.borderTopColor}};}})()"))) {
                    if(motion.RootElement.ValueKind!=JsonValueKind.Null) {
                        if(motion.RootElement.GetProperty("name").GetString()!="cloudig-work-opening"||motion.RootElement.GetProperty("play").GetString()!="running")throw new InvalidDataException("Work opening animation is not running");
                        opening.Add(motion.RootElement.Clone());await Capture($"work-opening-{i}");
                    }
                }
                await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))");
                await Wait($"document.querySelector('{modal} .cloudig-interactive-status').hidden&&getComputedStyle(document.querySelector('{modal} .cloudig-interactive-status'),'::before').animationName==='none'");
                var frame = await CurrentFrame(); await Wait("document.fonts.status==='loaded'&&Boolean(document.body.innerText.trim()||document.querySelector('canvas,svg')||[...document.querySelectorAll('*')].some(e=>e.shadowRoot?.textContent.trim()))", frame);
                if (audit.Query.Contains("work-kimi=1", StringComparison.Ordinal)) await CheckKimi(frame, $"window-{i}");
                if(await Read("Boolean(document.querySelector('#cloudig-file-preview'))",frame)=="true") {
                    await Wait("document.querySelector('#cloudig-file-preview').dataset.previewReady==='true'",frame);
                    await Capture($"office-{i}-first");
                    if(await Read("Boolean(document.querySelector('.office-toolbar button:last-child:not(:disabled)'))",frame)=="true") {
                        await Pointer(".office-toolbar button:last-child",frame);await Wait("document.querySelector('.office-toolbar span').textContent.startsWith('2')",frame);
                        await Capture($"office-{i}-next");
                    }
                }
                await Task.Delay(300);
                if(await Read("Boolean(document.querySelector('.slide-reader'))",frame)=="true") {
                    var controls=await Read("(()=>[...document.querySelectorAll('.slide-reader>nav,.slide-reader>footer')].map(n=>{const r=n.getBoundingClientRect();return{tag:n.tagName,top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,position:getComputedStyle(n).position}}))()",frame);
                    await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".slide-controls-{i}.json"),controls);
                    using(var measured=JsonDocument.Parse(controls))if(measured.RootElement.EnumerateArray().Any(n=>n.GetProperty("top").GetDouble() < -1 || n.GetProperty("bottom").GetDouble()>n.GetProperty("viewport").GetDouble()+1))throw new InvalidDataException("Slide reader controls escaped their viewport: "+controls);
                    if(await Read("Boolean(document.querySelector('.slide-reader [data-next]:not(:disabled)'))",frame)=="true") {
                        await Pointer(".slide-reader [data-next]",frame);await Wait("document.querySelector('.slide-count').textContent.startsWith('2')",frame);
                        await Capture($"slide-next-{i}");
                        if(audit.Query.Contains("work-kimi=1",StringComparison.Ordinal)) {
                            var page=2;
                            while(await Read("Boolean(document.querySelector('.slide-reader [data-next]:not(:disabled)'))",frame)=="true") {
                                await Pointer(".slide-reader [data-next]",frame);page++;
                                await Wait($"document.querySelector('.slide-count').textContent.startsWith('{page}')",frame);
                                await Capture($"slide-page-{page}-{i}");
                            }
                            while(await Read("Boolean(document.querySelector('.slide-reader [data-previous]:not(:disabled)'))",frame)=="true")await Pointer(".slide-reader [data-previous]",frame);
                        } else await Pointer(".slide-reader [data-previous]",frame);
                    }
                }
                var geometry=await Read($"(()=>{{const d=document.querySelector('{modal}'),r=d.getBoundingClientRect();return{{layout:d.dataset.workLayout,top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,target:parseFloat(d.style.getPropertyValue('--cloudig-window-height'))}}}})()");
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".work-{i}-geometry.json"),geometry);
                using(var bounds=JsonDocument.Parse(geometry)){var g=bounds.RootElement;if(g.GetProperty("top").GetDouble()<0||g.GetProperty("bottom").GetDouble()>g.GetProperty("viewport").GetDouble()+1||Math.Abs(g.GetProperty("height").GetDouble()-g.GetProperty("target").GetDouble())>2)throw new InvalidDataException("Work window geometry mismatch: "+geometry);}
                using (var measurement = JsonDocument.Parse(await Read($"(()=>{{const d=document.querySelector('{modal}');return{{mode:'first',index:{i},read_ms:Number(d.dataset.readMs),prepare_ms:Number(d.dataset.prepareMs),ready_ms:Number(d.dataset.loadMs)}};}})()"))) timings.Add(measurement.RootElement.Clone());
                var kind = JsonSerializer.Deserialize<string>(await Read("document.querySelector('#breathe')?'glass':document.querySelector('#kilnBtn')?'kiln':window.THREE?'three':document.querySelector('.recharts-wrapper')?'jsx':document.querySelector('.count')&&document.querySelector('.buttons')?'react':window.Chart?'chart':document.querySelector('.slide-reader')?'slides':document.querySelector('#next-slide')&&document.querySelector('#slide-counter')?'native-slides':'document'", frame))!;
                if (kind == "glass")
                {
                    await Pointer("#breathe", frame, 1000); await Wait("!document.querySelector('#restart').hidden", frame);
                    var p = await Point("#glass", frame); await Mouse("mousePressed", p.X - 60, p.Y, true);
                    for (var n = 0; n < 8; n++) { await Mouse("mouseMoved", p.X - 60 + n * 16, p.Y + Math.Sin(n) * 15, true); await Task.Delay(25); }
                    await Mouse("mouseReleased", p.X + 52, p.Y); await Wait("!document.querySelector('#wipe').hidden", frame);
                }
                else if (kind == "kiln")
                {
                    await Pointer("#play", frame); await Wait("document.querySelector('#play').textContent==='暂停'", frame);
                    await Pointer("#night", frame); await Pointer("#kilnBtn", frame); await Pointer("#rain", frame);
                    await Wait("document.querySelector('#night').getAttribute('aria-pressed')==='true'&&document.querySelector('#rain').getAttribute('aria-pressed')==='true'", frame);
                    await AudioState(true);
                }
                else if (kind == "react") { await Pointer(".buttons button:last-child", frame); await Pointer(".buttons button:last-child", frame); await Wait("document.querySelector('.count').textContent==='2'", frame); }
                else if (kind == "jsx") { await Pointer("button", frame);await Wait("document.body.textContent.includes('今天一共采了 7 朵')",frame); await Pointer("button", frame); await Wait("document.body.textContent.includes('今天一共采了 8 朵')&&document.querySelectorAll('.recharts-bar-rectangle').length>0", frame); }
                else if (kind == "three")
                {
                    await Wait("!document.body.innerText.includes('打不开 WebGL')&&document.querySelector('canvas').width>0", frame);
                    var p = await Point("canvas", frame); await Mouse("mousePressed", p.X, p.Y, true); await Mouse("mouseMoved", p.X + 80, p.Y + 20, true); await Mouse("mouseReleased", p.X + 80, p.Y + 20);
                    await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyDown\",\"key\":\"w\",\"code\":\"KeyW\",\"windowsVirtualKeyCode\":87}");
                    await Task.Delay(500); await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyUp\",\"key\":\"w\",\"code\":\"KeyW\",\"windowsVirtualKeyCode\":87}");
                }
                else if (kind == "chart")
                {
                    // Real samples include timed charts initialized with null
                    // points. A canvas/legend alone is not rendered data.
                    await Wait("Boolean(Chart.getChart(document.querySelector('canvas'))?.data.datasets.some(s=>s.data.some(v=>v!==null&&v!==undefined)))", frame);
                }
                else if (kind == "slides") { await Pointer("[data-toggle-notes]", frame); await Wait("!document.querySelector('.slide-notes').hidden", frame); }
                else if(kind == "native-slides") {
                    await Pointer("#next-slide",frame);
                    await Wait("document.querySelector('#slide-counter').textContent.includes('2')&&[...document.querySelectorAll('.slide-container')].every(n=>Number(getComputedStyle(n).opacity)===(n.classList.contains('active')?1:0))",frame);
                }
                else if (await Read("document.body.innerText.includes('EXISTENT JOURNEY')", frame) == "true") { await Pointer("button:last-of-type", frame); await Wait("document.body.innerText.includes('觉醒')&&document.body.innerText.includes('旅途记录')", frame); }
                if(await Read("typeof window.loadPyodide==='function'&&Boolean(document.querySelector('#out'))",frame)=="true") {
                    // A source example multiplies a Python string by itself.
                    // Verify the actual interpreter result, not a speculative
                    // CDN failure or a screenshot taken while WASM still loads.
                    await Wait("(()=>{const t=document.querySelector('#out').textContent;return t.includes('2 + 2 = 4')||t.includes('TypeError')&&t.includes('multiply sequence');})()",frame);
                    TraceVisualAudit("saved-work-python-result",await Read("document.querySelector('#out').textContent",frame));
                }
                if(await Read("Boolean(window.mobilenet&&document.querySelector('#file')&&document.querySelector('#preview'))",frame)=="true") {
                    await Wait("document.querySelector('#out').textContent.includes('模型就绪')",frame);
                    // Use an owned synthetic PNG through the source's actual
                    // file-change handler; never open a dialog over the user.
                    await Read("(()=>{const c=document.createElement('canvas');c.width=c.height=224;c.getContext('2d').fillRect(0,0,224,224);c.toBlob(b=>{const data=new DataTransfer();data.items.add(new File([b],'cloudig-audit.png',{type:'image/png'}));document.querySelector('#file').files=data.files;document.querySelector('#file').dispatchEvent(new Event('change',{bubbles:true}));},'image/png');})()",frame);
                    await Wait("document.querySelector('#out').querySelectorAll('b').length===3&&document.querySelector('#preview').naturalWidth===224",frame);
                    TraceVisualAudit("saved-work-ml-result",await Read("document.querySelector('#out').textContent",frame));
                }
                if(await Read("Boolean(document.querySelector('.research-visual [data-cloudig-document]'))",frame)=="true") {
                    await Pointer(".research-visual [data-cloudig-document]",frame);
                    await Wait($"document.querySelector('{modal}').dataset.state==='ready'&&!document.querySelector('{modal} .cloudig-interactive-toolbar button:nth-of-type(2)').hidden");
                    frame=await CurrentFrame();await Wait("document.body.innerText.length>100&&!document.querySelector('.research-visual')",frame);await Capture("research-original-visual");
                    await Pointer(modal+" .cloudig-interactive-toolbar button:nth-of-type(2)");
                    await Wait($"document.querySelector('{modal}').dataset.state==='ready'&&document.querySelector('{modal} .cloudig-interactive-toolbar button:nth-of-type(2)').hidden");
                    frame=await CurrentFrame();await Wait("Boolean(document.querySelector('.research-visual'))",frame);
                    TraceVisualAudit("research-document-pointer-roundtrip-passed","saved report to original visual and back within one bounded work window");
                }
                if(audit.Query.Contains("work-downloads=1",StringComparison.Ordinal) && await Read("typeof window.makePDF==='function'",frame)=="true")
                {
                    var folder=Path.Combine(Path.GetDirectoryName(audit.OutputFile)!,"generated-files");
                    async Task Saved(string name) {
                        var target=Path.Combine(folder,name);
                        for(var n=0;n<200&&!_workDownloadAuditSaved.Contains(target);n++)await Task.Delay(50);
                        if(!_workDownloadAuditSaved.Contains(target)||!File.Exists(target))throw new InvalidDataException("Work download missing: "+name);
                    }
                    await Pointer("button",frame); await Saved("osis-tideletter.pdf");
                    var pdf=await File.ReadAllBytesAsync(Path.Combine(folder,"osis-tideletter.pdf"));
                    if(!pdf.AsSpan().StartsWith("%PDF-"u8)||!System.Text.Encoding.Latin1.GetString(pdf).Contains("Osis.TideLetter Report"))throw new InvalidDataException("Generated PDF bytes/text invalid");
                    await Read("""
                      (()=>{const p=document.createElement('div');p.style.cssText='position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;background:white;padding:12px';
                      const rows=[['text','result.txt','text/plain;charset=utf-8','采云\nGenerated text'],['json','result.json','application/json',JSON.stringify({name:'采云',value:42})],['png','result.png','image/png',''],['data','data.txt','text/plain','data URL file']];
                      rows.forEach(([id,name,mime,value])=>{const b=document.createElement('button');b.id='cloudig-audit-save-'+id;b.textContent=id;b.onclick=()=>{const a=document.createElement('a');a.download=name;if(id==='png'){const c=document.createElement('canvas');c.width=2;c.height=3;c.getContext('2d').fillRect(0,0,2,3);a.href=c.toDataURL('image/png');}else if(id==='data')a.href='data:text/plain,'+encodeURIComponent(value);else a.href=URL.createObjectURL(new Blob([value],{type:mime}));if(id==='text')document.body.append(a);a.click();a.remove();};p.append(b);});document.body.append(p);})()
                      """,frame);
                    foreach(var (id,name) in new[]{("text","result.txt"),("json","result.json"),("png","result.png"),("data","data.txt")}) { await Pointer("#cloudig-audit-save-"+id,frame);await Saved(name); }
                    if(await File.ReadAllTextAsync(Path.Combine(folder,"result.txt"))!="采云\nGenerated text"||await File.ReadAllTextAsync(Path.Combine(folder,"data.txt"))!="data URL file")throw new InvalidDataException("Generated text changed");
                    using(var json=JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(folder,"result.json"))))if(json.RootElement.GetProperty("value").GetInt32()!=42)throw new InvalidDataException("Generated JSON invalid");
                    var png=await File.ReadAllBytesAsync(Path.Combine(folder,"result.png"));if(!png.AsSpan().StartsWith(new byte[]{137,80,78,71,13,10,26,10}))throw new InvalidDataException("Generated PNG invalid");
                    var savedCount=_workDownloadAuditSaved.Count;var canceled=_workDownloadAuditCanceled;
                    _workDownloadAuditCancelNext=true;await Pointer("#cloudig-audit-save-text",frame);
                    for(var n=0;n<100&&_workDownloadAuditCanceled==canceled;n++)await Task.Delay(50);
                    if(_workDownloadAuditCanceled!=canceled+1||_workDownloadAuditSaved.Count!=savedCount||await File.ReadAllTextAsync(Path.Combine(folder,"result.txt"))!="采云\nGenerated text")throw new InvalidDataException("Cancel changed an existing output");
                    await Capture("generated-files");
                    TraceVisualAudit("work-generated-files-passed","Original jsPDF + Blob text/JSON + data PNG/text; UTF-8/binary checked; cancel preserved existing file");
                }
                await Capture($"work-{i + 1}-{kind}");
                var facts = await Read("({origin:location.origin,title:document.title,text:document.body.innerText.slice(0,1200),canvas:document.querySelectorAll('canvas').length,svg:document.querySelectorAll('svg').length,fonts:document.fonts.status,navigation:performance.getEntriesByType('navigation').map(n=>({duration:n.duration,dns:n.domainLookupEnd-n.domainLookupStart,connect:n.connectEnd-n.connectStart,response:n.responseEnd-n.requestStart}))})", frame);
                using var row = JsonDocument.Parse(facts); results.Add(row.RootElement.Clone());
                if (row.RootElement.GetProperty("origin").GetString() != "https://cloudig-work.invalid") throw new InvalidDataException("Work was not isolated");
                if (i == 0)
                {
                    await ScrollProbe(frame);
                    var runningUrl=await Read($"document.querySelector('{modal} iframe').src");
                    await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();window.__sourceSize=[r.width,r.height]}})()");
                    await Read("window.__cloudigSourceViewAudit={inputs:JSON.stringify([...document.querySelectorAll('input,textarea,select')].map(n=>({value:n.value,checked:n.checked})))}",frame);
                    await Pointer(modal + " .cloudig-interactive-toolbar button:last-child");
                    await Wait($"document.querySelector('{modal}').dataset.state==='source'&&document.querySelector('{modal} pre').textContent.length>10&&getComputedStyle(document.querySelector('{modal} iframe')).visibility==='hidden'&&document.querySelector('{modal} iframe').hasAttribute('inert')");
                    await Capture("work-source");
                    if(await Read($"(()=>{{const r=document.querySelector('{modal} iframe').getBoundingClientRect();return Math.abs(r.width-window.__sourceSize[0])<1&&Math.abs(r.height-window.__sourceSize[1])<1;}})()")!="true")throw new InvalidDataException("Source view resized the live work canvas");
                    await Pointer(modal + " .cloudig-interactive-toolbar button:first-child");
                    await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))"); frame = await CurrentFrame();
                    if(await Read($"document.querySelector('{modal} iframe').src")!=runningUrl||await Read("Boolean(window.__cloudigSourceViewAudit)&&window.__cloudigSourceViewAudit.inputs===JSON.stringify([...document.querySelectorAll('input,textarea,select')].map(n=>({value:n.value,checked:n.checked})))",frame)!="true")throw new InvalidDataException("Source/work switching recreated the live work or lost form values");
                    await Pointer(modal + " .cloudig-interactive-toolbar button:first-child");
                    if(await Read($"document.querySelector('{modal} iframe').src")!=runningUrl)throw new InvalidDataException("Clicking active Work reset the runtime");
                    await Capture("work-source-return");
                    TraceVisualAudit("work-source-state-passed", "Source/Work and repeated Work retained runtime identity, JS sentinel and form values");
                }
                await Close(frame);
                if (kind == "kiln") await AudioState(false);
                if (kind == "glass")
                {
                    await Pointer(selector); await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))");
                    var reopened = await CurrentFrame(); await Wait("!document.querySelector('#restart').hidden&&!document.querySelector('#wipe').hidden", reopened);
                    await Capture("work-glass-session-restored"); await Close(reopened);
                }
                else {
                    await Pointer(selector); await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))");
                    using (var measurement = JsonDocument.Parse(await Read($"(()=>{{const d=document.querySelector('{modal}');return{{mode:'reopen',index:{i},read_ms:Number(d.dataset.readMs),prepare_ms:Number(d.dataset.prepareMs),ready_ms:Number(d.dataset.loadMs)}};}})()"))) timings.Add(measurement.RootElement.Clone());
                    await Close(await CurrentFrame());
                }
            }
            if(audit.Query.Contains("work-review=1",StringComparison.Ordinal)||audit.Query.Contains("work-kimi=1",StringComparison.Ordinal)||audit.Query.Contains("work-media-files=1",StringComparison.Ordinal)) {
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".attachment-actions.json"),await Read("[...document.querySelectorAll('.cloudig-attachment')].map(c=>({name:c.querySelector('.cloudig-attachment-name')?.textContent,preview:!!c.querySelector('.cloudig-resource-preview'),save:!!c.querySelector('.cloudig-resource-save')}))"));
                var previews=int.Parse(await Read($$"""(()=>{const seen=new Set(),buttons=[...document.querySelectorAll('.cloudig-resource-preview')].filter(b=>{const ext=b.closest('.cloudig-attachment').querySelector('.cloudig-attachment-name').textContent.split('.').at(-1).toLowerCase();if(!({{(audit.Query.Contains("work-media-files=1",StringComparison.Ordinal)?"['mp3','mp4','m4a','wav','webm','ogg','flac']":"['pdf','docx','xlsx','pptx','txt','md','csv','mp3','mp4','m4a','wav','html','htm','glb']")}}).includes(ext)||seen.has(ext))return false;seen.add(ext);return true;});buttons.forEach((b,i)=>b.dataset.auditPreview=String(i));return buttons.length;})()"""));
                if(audit.Query.Contains("work-media-files=1",StringComparison.Ordinal)&&previews==0)throw new InvalidDataException("No media attachment preview");
                for(var n=0;n<previews;n++) {
                    var selector=$"[data-audit-preview='{n}']";
                    await Read($$"""(()=>{let n=document.querySelector({{JsonSerializer.Serialize(selector)}});for(let p=n.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;})()""");
                    await Pointer(selector);await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))");var frame=await CurrentFrame();
                    if(await Read("Boolean(document.querySelector('pre > code.language-mermaid'))",frame)=="true")await Wait("Boolean(document.querySelector('.saved-diagram svg'))",frame);
                    if(await Read("Boolean(document.querySelector('#cloudig-file-preview canvas'))",frame)=="true")
                    { var p=await Point("#cloudig-file-preview canvas",frame);await Mouse("mousePressed",p.X,p.Y,true);await Mouse("mouseMoved",p.X+45,p.Y+15,true);await Mouse("mouseReleased",p.X+45,p.Y+15); }
                    await Capture($"attachment-preview-{n}");
                    if(await Read("Boolean(document.querySelector('.saved-media audio,.saved-media video'))",frame)=="true") {
                        await Wait("(()=>{const m=document.querySelector('.saved-media audio,.saved-media video');return m.localName==='audio'||m.videoWidth>0||['ready','failed'].includes(document.querySelector('.saved-video-fallback')?.dataset.state)})()",frame);
                        if(await Read("Boolean(document.querySelector('.saved-video-fallback[data-state=ready]'))",frame)=="true") {
                            await Pointer(".saved-video-fallback .cloudig-audio-mute",frame);
                            await Pointer(".saved-video-fallback .cloudig-audio-toggle",frame);
                            await Wait("document.querySelector('.saved-video-fallback').dataset.decoded==='true'",frame);
                        }else if(await Read("Boolean(document.querySelector('.saved-media>.cloudig-audio-controls'))",frame)=="true") {
                            await Read("document.querySelector('.saved-media audio').muted=true",frame);await Pointer(".saved-media .cloudig-audio-toggle",frame);
                        }else await Read("(()=>{const m=document.querySelector('.saved-media video');window.__mediaFacts={};m.muted=true;void Promise.race([m.play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('play timeout')),7000))]).catch(e=>window.__mediaFacts.error=String(e));return true;})()",frame);
                        await Task.Delay(1800);
                        var facts=await Read("(()=>{const m=document.querySelector('.saved-media audio,.saved-media video'),s=document.querySelector('.saved-video-fallback');return {tag:m.localName,readyState:m.readyState,time:s?Number(s.dataset.time??0):m.currentTime,width:s?s.querySelector('canvas')?.width??0:m.videoWidth??null,height:s?s.querySelector('canvas')?.height??0:m.videoHeight??null,frames:s?s.dataset.decoded==='true':m.getVideoPlaybackQuality?.().totalVideoFrames??null,error:m.error?.message??window.__mediaFacts?.error??null,hevc:m.canPlayType('video/mp4; codecs=\"hvc1\"'),duration:m.duration,controls:!!document.querySelector('.cloudig-audio-controls'),decoder:s?'software':'native'}})()",frame);
                        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".attachment-playback-{n}.json"),facts);await Capture($"attachment-playing-{n}");
                        using(var playing=JsonDocument.Parse(facts))if(playing.RootElement.GetProperty("time").GetDouble()<=0||playing.RootElement.GetProperty("tag").GetString()=="video"&&playing.RootElement.GetProperty("width").GetInt32()==0)throw new InvalidDataException("Saved media did not decode/play: "+facts);
                        await Read("document.querySelector('.saved-media audio,.saved-media video').pause()",frame);
                    }
                    if(await Read("Boolean(document.querySelector('.footnote-ref a'))",frame)=="true") { await Pointer(".footnote-ref a",frame);await Capture($"markdown-footnotes-{n}"); }
                    await Close(frame);
                }
            }
            if(audit.Query.Contains("work-kimi=1",StringComparison.Ordinal)) {
                var cards=int.Parse(await Read("(()=>{const cards=[...document.querySelectorAll('.cloudig-kimi-card')];cards.forEach((c,i)=>c.dataset.auditKimiCard=String(i));return cards.length})()"));
                for(var i=0;i<cards;i++) {
                    var selector=$"[data-audit-kimi-card='{i}']";
                    await Point(selector+" h3,"+selector+" summary");
                    if(await Read($"Boolean(document.querySelector(\"{selector}[data-source='kimi.com_files']\"))")=="true") {
                        await Pointer(selector+" summary");await Wait($"document.querySelector(\"{selector} details\").open&&document.querySelectorAll(\"{selector} .cloudig-attachment\").length>0");
                        await Capture("kimi-file-catalog");await Pointer(selector+" summary");
                    } else await Capture($"kimi-card-{i}");
                }
                var staticWindows=int.Parse(await Read("(()=>{const buttons=[...document.querySelectorAll('.cloudig-window-entry > button:not(.cloudig-work-open)')];buttons.forEach((b,i)=>b.dataset.auditStaticWork=String(i));return buttons.length})()"));
                for(var i=0;i<staticWindows;i++) {
                    await Pointer($"[data-audit-static-work='{i}']");await Wait("Boolean(document.querySelector('.cloudig-structured-window[open]'))");
                    if(await Read("Boolean(document.querySelector('.cloudig-structured-window iframe'))")=="true")throw new InvalidDataException("A cloud service record started executable content");
                    await Capture($"kimi-version-record-{i}");await Pointer(".cloudig-structured-window .cloudig-interactive-close");await Wait("!document.querySelector('.cloudig-structured-window')");
                }
            }
            if(audit.Query.Contains("work-media-files=1",StringComparison.Ordinal)) {
                var tasks=int.Parse(await Read("(()=>{const a=[...document.querySelectorAll('.cloudig-kimi-card[data-source=\"kimi.com_scheduled_task\"]')];a.forEach((n,i)=>n.dataset.auditTask=String(i));return a.length})()"));
                for(var i=0;i<tasks;i++) { await Point($"[data-audit-task='{i}'] h3");await Capture($"schedule-{i}"); }
                if(tasks>0)await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".schedule-labels.json"),await Read("[...document.querySelectorAll('.cloudig-kimi-schedule-time')].map(n=>n.textContent)"));
            }
            var inlineCount = int.Parse(await Read("(()=>{const ds=[...document.querySelectorAll('.cloudig-interactive-box')];ds.forEach((d,i)=>d.dataset.nativeInline=String(i));return ds.length;})()"));
            if(audit.Query.Contains("work-media-files=1",StringComparison.Ordinal))inlineCount=0;
            for (var i = 0; i < inlineCount; i++)
            {
                var inline = $"[data-native-inline='{i}']"; var inlineLiteral = JsonSerializer.Serialize(inline);
                await Point(inline + " .cloudig-interactive-header");
                await Wait($$"""document.querySelector({{inlineLiteral}}).dataset.state==='ready'&&Boolean(document.querySelector({{inlineLiteral}}).querySelector('iframe'))""");
                var src = await Read($$"""document.querySelector({{inlineLiteral}}).querySelector('iframe').src""");
                await Pointer(inline + " .cloudig-interactive-enlarge");
                await Wait($"Boolean(document.querySelector('{modal}[open] iframe'))");
                var frame = await CurrentFrame();
                if (await Read($"document.querySelector('{modal} iframe').src") != src) throw new InvalidDataException("Enlarging a Box restarted it");
                if (audit.Query.Contains("work-kimi=1", StringComparison.Ordinal)) await CheckKimi(frame, $"inline-{i}");
                if (await Read("Boolean(document.querySelector('#clouds'))",frame) == "true") {
                    await Wait("document.querySelectorAll('#sky .ti-cloud').length===5&&[...document.querySelectorAll('#sky .ti-cloud')].every(n=>getComputedStyle(n).maskImage.startsWith('url('))",frame);
                    await Read("(()=>{window.__cloudigIconPixels=null;void(async()=>{const css=getComputedStyle(document.querySelector('#sky .ti-cloud')).maskImage;const image=new Image();image.src=css.slice(4,-1).replace(/^['\"]|['\"]$/g,'');await image.decode();const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d');c.drawImage(image,0,0,64,64);const a=c.getImageData(0,0,64,64).data;let clear=0,paint=0;for(let i=3;i<a.length;i+=4){if(a[i]===0)clear++;else paint++;}window.__cloudigIconPixels={clear,paint,pass:clear>100&&paint>20};})().catch(e=>window.__cloudigIconPixels={error:String(e)});return true})()",frame);
                    await Wait("window.__cloudigIconPixels?.pass===true",frame);
                    await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".cloud-icon-pixels.json"),await Read("window.__cloudigIconPixels",frame));
                    await Capture("cloud-slider-five");await Pointer("#clouds",frame);
                    foreach(var key in new[]{("Home",36), ("End",35)}) {
                        foreach(var type in new[]{"keyDown","keyUp"}) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type,key=key.Item1,code=key.Item1,windowsVirtualKeyCode=key.Item2}));
                        await Wait(key.Item1=="Home"?"document.querySelectorAll('#sky .ti-cloud').length===0&&document.querySelector('#clouds-out').textContent.includes('0')":"document.querySelectorAll('#sky .ti-cloud').length===12&&[...document.querySelectorAll('#sky .ti-cloud')].every(n=>getComputedStyle(n).maskImage.startsWith('url('))",frame);
                        await Capture(key.Item1=="Home"?"cloud-slider-zero":"cloud-slider-twelve");
                    }
                }
                await Capture($"inline-{i + 1}-enlarged");
                await Pointer(modal + " .cloudig-interactive-close");
                await Wait($"!document.querySelector('{modal}')");
                if (await Read($$"""document.querySelector({{inlineLiteral}}).querySelector('iframe').src""") != src) throw new InvalidDataException("Returning a Box restarted it");
                await Pointer(inline + " .cloudig-interactive-close");
                await Wait($$"""!document.querySelector({{inlineLiteral}}).querySelector('iframe')""");
                for (var n = 0; n < 100 && !destroyed.Contains(frame); n++) await Task.Delay(20);
                if (!destroyed.Contains(frame)) throw new InvalidDataException("Collapsing a Box kept its native frame");
            }
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".works.json"), JsonSerializer.Serialize(new { works = results, opening, inline_works = inlineCount, timings, audio, native_frames = frames.Count, destroyed_frames = destroyed.Count }));
            TraceVisualAudit("reader-saved-works-pointer-passed", $"{count} saved works; real controls/source fonts; heavy click-only; session reopen; native frames destroyed; WebView muted during audit");
        }
        finally
        {
            WebView.CoreWebView2.FrameCreated -= TrackSavedWorkFrame; WebView.CoreWebView2.IsMuted = muted;
        }
    }
}
