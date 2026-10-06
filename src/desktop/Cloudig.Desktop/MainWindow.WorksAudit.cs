using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifySavedWorksAsync(VisualAuditOptions audit)
    {
        const string modal = ".cloudig-interactive-window:not(.cloudig-interactive-box)";
        var frames = new List<CoreWebView2Frame>(); var destroyed = new HashSet<CoreWebView2Frame>();
        var results = new List<JsonElement>(); var opening = new List<JsonElement>(); var audio = new List<object>(); var timings = new List<JsonElement>();
        var muted = WebView.CoreWebView2.IsMuted; WebView.CoreWebView2.IsMuted = true;
        void Created(object? sender, CoreWebView2FrameCreatedEventArgs args)
        {
            // FrameCreatedEventArgs.Frame can return a different managed COM
            // wrapper on each access; keep the exact instance we registered.
            var frame = args.Frame; frames.Add(frame); frame.Destroyed += (_, _) => destroyed.Add(frame);
        }
        WebView.CoreWebView2.FrameCreated += Created;
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
            var p = await Point(selector, frame); await Mouse("mouseMoved", p.X, p.Y); await Mouse("mousePressed", p.X, p.Y, true);
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
            await Wait("document.querySelector('.route-transition').hidden&&Boolean(document.querySelector('.cloudig-window-entry > button'))");
            var count = int.Parse(await Read("(()=>{const b=[...document.querySelectorAll('.cloudig-window-entry > button.cloudig-box-button')];b.forEach((n,i)=>n.dataset.nativeWork=String(i));return b.length;})()"));
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
                var frame = await CurrentFrame(); await Wait("document.fonts.status==='loaded'&&Boolean(document.body.innerText.trim()||document.querySelector('canvas,svg'))", frame);
                using (var measurement = JsonDocument.Parse(await Read($"(()=>{{const d=document.querySelector('{modal}');return{{mode:'first',index:{i},read_ms:Number(d.dataset.readMs),prepare_ms:Number(d.dataset.prepareMs),ready_ms:Number(d.dataset.loadMs)}};}})()"))) timings.Add(measurement.RootElement.Clone());
                var kind = JsonSerializer.Deserialize<string>(await Read("document.querySelector('#breathe')?'glass':document.querySelector('#kilnBtn')?'kiln':window.THREE?'three':document.querySelector('.recharts-wrapper')?'jsx':document.querySelector('.count')?'react':window.Chart?'chart':document.querySelector('.slide-reader')?'slides':'document'", frame))!;
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
                else if (kind == "jsx") { await Pointer("button", frame); await Pointer("button", frame); await Wait("document.body.textContent.includes('今天一共采了 8 朵')&&document.querySelectorAll('.recharts-bar-rectangle').length>0", frame); }
                else if (kind == "three")
                {
                    await Wait("!document.body.innerText.includes('打不开 WebGL')&&document.querySelector('canvas').width>0", frame);
                    var p = await Point("canvas", frame); await Mouse("mousePressed", p.X, p.Y, true); await Mouse("mouseMoved", p.X + 80, p.Y + 20, true); await Mouse("mouseReleased", p.X + 80, p.Y + 20);
                    await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyDown\",\"key\":\"w\",\"code\":\"KeyW\",\"windowsVirtualKeyCode\":87}");
                    await Task.Delay(500); await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", "{\"type\":\"keyUp\",\"key\":\"w\",\"code\":\"KeyW\",\"windowsVirtualKeyCode\":87}");
                }
                else if (kind == "chart") await Wait("Boolean(Chart.getChart(document.querySelector('canvas'))?.data.datasets.length)", frame);
                else if (kind == "slides") { await Pointer("[data-toggle-notes]", frame); await Wait("!document.querySelector('.slide-notes').hidden", frame); }
                else if (await Read("document.body.innerText.includes('EXISTENT JOURNEY')", frame) == "true") { await Pointer("button:last-of-type", frame); await Wait("document.body.innerText.includes('觉醒')&&document.body.innerText.includes('旅途记录')", frame); }
                await Capture($"work-{i + 1}-{kind}");
                var facts = await Read("({origin:location.origin,title:document.title,text:document.body.innerText.slice(0,1200),canvas:document.querySelectorAll('canvas').length,svg:document.querySelectorAll('svg').length,fonts:document.fonts.status,navigation:performance.getEntriesByType('navigation').map(n=>({duration:n.duration,dns:n.domainLookupEnd-n.domainLookupStart,connect:n.connectEnd-n.connectStart,response:n.responseEnd-n.requestStart}))})", frame);
                using var row = JsonDocument.Parse(facts); results.Add(row.RootElement.Clone());
                if (row.RootElement.GetProperty("origin").GetString() != "https://cloudig-work.invalid") throw new InvalidDataException("Work was not isolated");
                if (i == 0)
                {
                    await ScrollProbe(frame);
                    await Pointer(modal + " .cloudig-interactive-toolbar button:nth-child(2)");
                    await Wait($"document.querySelector('{modal}').dataset.state==='source'&&document.querySelector('{modal} pre').textContent.length>10&&!document.querySelector('{modal} iframe')");
                    await Capture("work-source");
                    await Pointer(modal + " .cloudig-interactive-toolbar button:first-child");
                    await Wait($"Boolean(document.querySelector('{modal}[data-state=ready] iframe'))"); frame = await CurrentFrame();
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
            var inlineCount = int.Parse(await Read("(()=>{const ds=[...document.querySelectorAll('.cloudig-interactive-box')];ds.forEach((d,i)=>d.dataset.nativeInline=String(i));return ds.length;})()"));
            for (var i = 0; i < inlineCount; i++)
            {
                var inline = $"[data-native-inline='{i}']"; var inlineLiteral = JsonSerializer.Serialize(inline);
                await Point(inline + " .cloudig-interactive-header");
                await Wait($$"""document.querySelector({{inlineLiteral}}).dataset.state==='ready'&&Boolean(document.querySelector({{inlineLiteral}}).querySelector('iframe'))""");
                var src = await Read($$"""document.querySelector({{inlineLiteral}}).querySelector('iframe').src""");
                await Pointer(inline + " .cloudig-interactive-toolbar button:nth-child(3)");
                await Wait($"Boolean(document.querySelector('{modal}[open] iframe'))");
                var frame = await CurrentFrame();
                if (await Read($"document.querySelector('{modal} iframe').src") != src) throw new InvalidDataException("Enlarging a Box restarted it");
                if (await Read("Boolean(document.querySelector('#clouds'))",frame) == "true") {
                    await Wait("document.querySelectorAll('#sky .ti-cloud').length===5&&[...document.querySelectorAll('#sky .ti-cloud')].every(n=>getComputedStyle(n).maskImage.startsWith('url('))",frame);
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
            WebView.CoreWebView2.FrameCreated -= Created; WebView.CoreWebView2.IsMuted = muted;
        }
    }
}
