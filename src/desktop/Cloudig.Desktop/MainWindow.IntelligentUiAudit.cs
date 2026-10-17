using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyIntelligentUiAsync(VisualAuditOptions audit)
    {
        var facts = new List<JsonElement>();
        async Task<string> Read(string js, CoreWebView2Frame? frame = null) => frame is null ? await WebView.CoreWebView2.ExecuteScriptAsync(js) : await frame.ExecuteScriptAsync(js);
        async Task Capture(string suffix) { await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream); }
        async Task Wait(string js, CoreWebView2Frame? frame = null)
        {
            for (var i=0; i<400; i++) { if (await Read(js, frame)=="true") return; await Task.Delay(50); }
            await Capture("dil-failed"); throw new InvalidDataException("UI did not reach: " + js + " | " + await Read("document.querySelector('.cloudig-dil-window')?.innerText"));
        }
        async Task Mouse(string type, double x, double y, bool down = false) => await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = type == "mouseMoved" && !down ? "none" : "left", buttons = down ? 1 : 0, clickCount = type == "mouseMoved" ? 0 : 1 }));
        async Task<(double X,double Y)> Point(string expression, CoreWebView2Frame? frame = null)
        {
            await Read($"({expression})?.scrollIntoView({{block:'center',behavior:'instant'}})",frame); await Task.Delay(100);
            using var point=JsonDocument.Parse(await Read($$"""
                (()=>{const n={{expression}};if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """,frame));
            if(point.RootElement.ValueKind==JsonValueKind.Null){await Capture("dil-obstructed");throw new InvalidDataException("UI pointer blocked: "+expression);}
            var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();
            if(frame is not null){using var offset=JsonDocument.Parse(await Read("(()=>{const r=document.querySelector('.cloudig-dil-window iframe').getBoundingClientRect();return{x:r.x,y:r.y}})()"));x+=offset.RootElement.GetProperty("x").GetDouble();y+=offset.RootElement.GetProperty("y").GetDouble();}
            return(x,y);
        }
        async Task Pointer(string expression,CoreWebView2Frame? frame=null){var p=await Point(expression,frame);await Mouse("mouseMoved",p.X,p.Y);await Mouse("mousePressed",p.X,p.Y,true);await Mouse("mouseReleased",p.X,p.Y);await Task.Delay(120);}
        async Task Key(string key,int code){foreach(var type in new[]{"keyDown","keyUp"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type,key,code=key,windowsVirtualKeyCode=code}));await Task.Delay(100);}
        const string views="[...document.querySelectorAll('.reader-conversation-scroll .cloudig-dil-view')]";
        string View(string prefix)=>$"{views}.find(n=>n.innerText.trim().startsWith({JsonSerializer.Serialize(prefix)}))";
        await Wait($"{views}.length>=40&&!document.querySelector('.cloudig-dil-loading')");
        if(await Read("Boolean(document.querySelector('.cloudig-dil-window iframe'))")!="false")throw new InvalidDataException("Window started before opening");
        await Wait("(()=>{const p=document.querySelector('[data-chart-type=pie]')?.parentElement;return p&&[...p.querySelectorAll('.cloudig-dil-chart-key')].length===4&&[...p.querySelectorAll('.cloudig-dil-chart-key')].every(n=>!n.hidden&&getComputedStyle(n).backgroundColor!=='rgba(0, 0, 0, 0)')})()");
        // Reader images are lazy: bring each plot into view before requiring
        // decoded pixels, otherwise a never-scrolled image cannot pass.
        await Wait("document.querySelectorAll('.cloudig-dil-chart-original').length===4");
        for(var i=0;i<4;i++)
        {
            await Read($"document.querySelectorAll('.cloudig-dil-chart-original')[{i}].scrollIntoView({{block:'center',behavior:'instant'}})");
            await Wait($"(()=>{{const p=document.querySelectorAll('.cloudig-dil-chart-original')[{i}],img=p.querySelector('img');return Math.abs(p.getBoundingClientRect().height-432)<1&&img?.complete&&img.naturalWidth>0&&Math.abs(img.getBoundingClientRect().height-p.getBoundingClientRect().height)<1}})()");
        }
        await Read("document.querySelector('[data-chart-type=pie]').scrollIntoView({block:'center',behavior:'instant'})");await Task.Delay(300);await Capture("dil-pie-legend");
        var readingStyle=await Read("""
            (()=>{const p=document.querySelector('[data-chart-type=pie]'),legend=p.parentElement.querySelector('.cloudig-dil-chart-legend'),inputs=[...document.querySelectorAll('.cloudig-dil-node input[type=checkbox],.cloudig-dil-node input[type=radio]')],headings=[...document.querySelectorAll('.cloudig-message-content>.cloudig-rich:not(:first-child)>:is(h1,h2,h3,h4,h5,h6):first-child')];return{pieHeight:p.getBoundingClientRect().height,legend:legend.innerText,colors:[...legend.querySelectorAll('i')].map(n=>getComputedStyle(n).backgroundColor),choices:inputs.map(n=>({appearance:getComputedStyle(n).appearance,background:getComputedStyle(n).backgroundColor})),headingMargins:headings.map(n=>parseFloat(getComputedStyle(n).marginTop))}})()
            """);
        using(var data=JsonDocument.Parse(readingStyle))
        {
            var r=data.RootElement;
            if(Math.Abs(r.GetProperty("pieHeight").GetDouble()-432)>1||r.GetProperty("headingMargins").GetArrayLength()==0||r.GetProperty("headingMargins").EnumerateArray().Any(n=>n.GetDouble()<18)||r.GetProperty("choices").GetArrayLength()==0||r.GetProperty("choices").EnumerateArray().Any(n=>n.GetProperty("appearance").GetString()!="none"||n.GetProperty("background").GetString()=="rgb(255, 255, 255)"))throw new InvalidDataException("Saved UI reading style regression: "+readingStyle);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-reading-style.json"),readingStyle);
        await Read("[...document.querySelectorAll('.cloudig-rich h2')].find(n=>n.textContent.includes('五、ChatGPT'))?.scrollIntoView({block:'center',behavior:'instant'})");await Capture("dil-heading-spacing");
        foreach(var prefix in new[]{"A01","A03","B01","B03","C01","C05","D01","E02","K01"})
        {
            await Read($"({View(prefix)})?.scrollIntoView({{block:'start',behavior:'instant'}})");await Task.Delay(200);await Capture("dil-"+prefix);
        }
        if(audit.Query.Contains("intelligent-ui-gallery=1",StringComparison.Ordinal))
        {
            var countAll=int.Parse(await Read($"{views}.length"));
            for(var i=0;i<countAll;i++)
            {
                await Read($"{views}[{i}].scrollIntoView({{block:'start',behavior:'instant'}})");await Task.Delay(100);await Capture($"dil-all-{i:D2}");
                if(await Read($"{views}[{i}].getBoundingClientRect().height>document.querySelector('.reader-conversation-scroll').clientHeight") == "true")
                {
                    await Read($"{views}[{i}].scrollIntoView({{block:'end',behavior:'instant'}})");await Task.Delay(100);await Capture($"dil-all-{i:D2}-tail");
                }
            }
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-all.json"),await Read($"{views}.map((n,i)=>({{index:i,text:n.innerText.slice(0,90),height:n.getBoundingClientRect().height}}))"));
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-viewport.json"),await Read("(()=>{const r=document.querySelector('.reader-conversation-scroll').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth}})()"));
        }
        // Real range-domain regression: changing program state alone is not
        // evidence that the native thumb/value survived a keyed repaint.
        var phase=$"({View("C05")}).querySelector('input[type=range]')";
        await Pointer(phase);await Key("Home",36);
        using(var bounds=JsonDocument.Parse(await Read($"(()=>{{const r=({phase}).getBoundingClientRect();return{{x:r.left,y:r.top+r.height/2,w:r.width}}}})()")))
        {
            var b=bounds.RootElement;var x=b.GetProperty("x").GetDouble();var y=b.GetProperty("y").GetDouble();var w=b.GetProperty("w").GetDouble();
            await Mouse("mousePressed",x+8,y,true);
            foreach(var fraction in new[]{.25,.5,.75,.95}) {await Mouse("mouseMoved",x+w*fraction,y,true);await Task.Delay(100);await Wait($"Number(({phase}).value)>{fraction*360-20}");}
            await Mouse("mouseReleased",x+w*.95,y);await Key("End",35);await Wait($"({phase}).value==='360'");await Capture("dil-range-maximum");
            await Key("Home",36);await Wait($"({phase}).value==='0'");
        }
        var colors=await Read($"[...({View("K01")}).querySelectorAll('.cloudig-box-chart-svg rect')].map(n=>getComputedStyle(n).fill)");
        using(var parsed=JsonDocument.Parse(colors))if(parsed.RootElement.EnumerateArray().Select(n=>n.GetString()).Distinct().Count()!=3)throw new InvalidDataException("Native category colours were flattened: "+colors);
        await Wait($"(()=>{{const c=({View("K01")}).querySelector('.cloudig-dil-widget:has(.cloudig-box-chart)'),next=c.nextElementSibling;return !next||c.getBoundingClientRect().bottom<=next.getBoundingClientRect().top+.5}})()");
        var surfaces=await Read($"{views}.filter(n=>!n.classList.contains('cloudig-window-entry')).map(n=>getComputedStyle(n).backgroundColor)");
        using(var parsed=JsonDocument.Parse(surfaces))if(parsed.RootElement.EnumerateArray().Any(n=>n.GetString() is not ("rgba(0, 0, 0, 0)" or "transparent")))throw new InvalidDataException("A UI mount painted a background without a source content surface");
        await Wait($"(()=>{{const v=({View("B03")}),form=v.querySelector('[data-dil-tag=form]'),content=v.querySelector('[data-dil-tag=box][style*=background]'),probe=document.createElement('span');probe.style.background='var(--cloudig-panel)';v.append(probe);const panel=getComputedStyle(probe).backgroundColor;probe.remove();return getComputedStyle(form).backgroundColor==='rgba(0, 0, 0, 0)'&&content&&getComputedStyle(content).backgroundColor===panel }})()");
        var frames=await Read("[...document.querySelectorAll('.cloudig-dil-view [data-dil-border]')].map(n=>({width:parseFloat(getComputedStyle(n).borderTopWidth),style:getComputedStyle(n).borderTopStyle}))");
        using(var parsed=JsonDocument.Parse(frames))if(parsed.RootElement.GetArrayLength()==0||parsed.RootElement.EnumerateArray().Any(n=>n.GetProperty("width").GetDouble()<=0||n.GetProperty("style").GetString()=="none"))throw new InvalidDataException("Source composition frame removed: "+frames);
        await Wait("(()=>{const nodes=[...document.querySelectorAll('.cloudig-dil-view.cloudig-window-entry,.cloudig-dil-view .cloudig-box-map')];return nodes.length>=3&&nodes.every(n=>{const p=document.createElement('span');p.style.background='var(--cloudig-panel)';n.append(p);const expected=getComputedStyle(p).backgroundColor;p.remove();return getComputedStyle(n).backgroundColor===expected})})()");
        await Wait($"(()=>{{const b=({View("B03")}).querySelector('button[type=submit]'),i=b.querySelector('.cloudig-dil-icon');return i&&getComputedStyle(i).color===getComputedStyle(b).color}})()");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-layout.json"),"{\"range_min\":0,\"range_max\":360,\"colors\":"+colors+",\"surfaces\":"+surfaces+"}");
        await Wait("[...document.querySelectorAll('.cloudig-dil-icon>.cloudig-box-image')].every(n=>n.getBoundingClientRect().height>0&&getComputedStyle(n).maskImage!=='none')");
        await Wait("[...document.querySelectorAll('.cloudig-dil-gallery .cloudig-gallery-stage')].every(n=>getComputedStyle(n).display==='grid'&&n.getBoundingClientRect().height<=221)");
        var gallery=$"({View("E02")}).querySelector('.cloudig-gallery-arrow:last-child')";
        if(await Read($"Boolean({gallery})")=="true") { await Pointer(gallery); await Capture("dil-gallery-page"); }
        // Real pointer + keyboard input must update a sibling view, not a copy.
        var calc=View("C06"); var dashboard=View("K01");
        await Pointer($"({calc}).querySelector('input[type=range]')");await Key("Home",36);await Key("ArrowRight",39);
        await Wait($"({dashboard}).querySelector('input[type=range]').value==='1'");
        await Read($"({dashboard}).scrollIntoView({{block:'start',behavior:'instant'}})");await Capture("dil-linked-score");
        await Pointer($"({calc}).querySelector('button')");
        // Hidden content, form and paging are exercised through actual hit tests.
        foreach(var prefix in new[]{"B01","B02","B03","B04","B05","B06"})
        {
            var expression=$"({View(prefix)}).querySelector('button:not(:disabled),input[type=radio],input[type=checkbox],select')";
            if(await Read($"Boolean({expression})")=="true")await Pointer(expression);
            await Capture("dil-action-"+prefix);
        }
        await Read("[...document.querySelectorAll('.cloudig-dil-view.cloudig-window-entry')].forEach((n,i)=>n.dataset.dilAuditWork=String(i))");
        var count=int.Parse(await Read("document.querySelectorAll('[data-dil-audit-work]').length"));
        if(count!=3)throw new InvalidDataException("Main sample must retain three heavy views");
        for(var i=0;i<count;i++)
        {
            await Pointer($"document.querySelector('[data-dil-audit-work=\"{i}\"]>button')");
            await Wait("Boolean(document.querySelector('.cloudig-dil-window .cloudig-interactive-box[data-state=ready] iframe'))");
            var hash=await Read("new URL(document.querySelector('.cloudig-dil-window iframe').src).hash");CoreWebView2Frame? frame=null;
            foreach(var candidate in _savedWorkAuditFrames.Where(f=>!_destroyedSavedWorkAuditFrames.Contains(f)).Reverse())if(await Read("location.hash",candidate)==hash){frame=candidate;break;}
            if(frame is null)throw new InvalidDataException("Native Window frame missing");
            await Wait("document.fonts.status==='loaded'",frame);
            if(i<2)
            {
                await Wait("(()=>{const c=document.querySelector('canvas');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.some((v,i)=>i%4===3&&v>0)})()",frame);
                if(i==0)
                {
                    var slider="document.querySelector('.cloudig-dil-window .cloudig-dil-view input[type=range]')";
                    await Pointer(slider);await Key("End",35);
                    var expected=await Read($"Number({slider}.value)");await Wait($"Number(window.__bindings.value)==={expected}",frame);
                    var frameHash=await Read("location.hash",frame);var p=await Point("document.querySelector('canvas')",frame);
                    await Mouse("mousePressed",p.X,p.Y,true);await Mouse("mouseMoved",p.X+20,p.Y-20,true);await Mouse("mouseReleased",p.X+20,p.Y-20);await Task.Delay(150);
                    var child=await Read("Number(window.__bindings.value)",frame);
                    if(child==expected)throw new InvalidDataException("Canvas interaction did not change its bound value");
                    await Wait($"Number({slider}.value)==={child}");
                    if(frameHash!=await Read("location.hash",frame))throw new InvalidDataException("Binding update restarted the canvas");
                }
                else {var p=await Point("document.querySelector('canvas')",frame);await Mouse("mousePressed",p.X,p.Y,true);await Mouse("mouseMoved",p.X+60,p.Y+20,true);await Mouse("mouseReleased",p.X+60,p.Y+20);}
            }
            else {await Pointer("document.querySelector('button')",frame);await Wait("document.querySelector('#counter').textContent==='1'",frame);}
            await Capture("dil-window-"+i);
            using(var row=JsonDocument.Parse(await Read("({origin:location.origin,canvas:document.querySelectorAll('canvas').length,text:document.body.innerText.slice(0,400)})",frame)))facts.Add(row.RootElement.Clone());
            await Pointer("document.querySelector('.cloudig-dil-window>.cloudig-interactive-header>.cloudig-interactive-close')");
            await Wait("!document.querySelector('.cloudig-dil-window')");
            for(var n=0;n<100&&!_destroyedSavedWorkAuditFrames.Contains(frame);n++)await Task.Delay(20);
            if(!_destroyedSavedWorkAuditFrames.Contains(frame))throw new InvalidDataException("Closed UI window retains its native frame");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".intelligent-ui.json"),JsonSerializer.Serialize(new{windows=facts,linked=true,closed=true,zoom=WebView.ZoomFactor}));
        TraceVisualAudit("intelligent-ui-passed","owned views;real input;linked score;bidirectional AppBlock;3 isolated windows;close releases frames");
    }
}
