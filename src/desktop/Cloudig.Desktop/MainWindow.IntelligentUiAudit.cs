using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyIntelligentUiAsync(VisualAuditOptions audit)
    {
        if(audit.Query.Contains("dil-fidelity=1",StringComparison.Ordinal)){await VerifyDilFidelityAsync(audit);return;}
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
        if(audit.Query.Contains("dil-progress=1",StringComparison.Ordinal))
        {
            var checklist=View("兼容性测试清单");
            await Wait($"Boolean({checklist})");
            await Read("window.__progressErrors=[];window.addEventListener('error',e=>window.__progressErrors.push(e.message))");
            var reset=$"[...({checklist}).querySelectorAll('button')].find(n=>n.textContent.includes('重置'))";
            await Pointer(reset);
            var measurements=new List<JsonElement>();
            async Task Check(int expected,string capture)
            {
                await Point($"({checklist}).querySelector('[style*=\"height: 6px\"]')");
                var result=await Read($$$"""
                    (()=>{const root={{{checklist}}},track=[...root.querySelectorAll('[data-dil-tag=box]')].find(n=>n.style.height==='6px'),bar=track.firstElementChild,a=track.getBoundingClientRect(),b=bar.getBoundingClientRect();return{checked:root.querySelectorAll('input:checked').length,count:root.innerText.match(/\d+\/20/)?.[0],percent:parseFloat(bar.style.width),actualPercent:b.width/a.width*100,height:b.height,errors:window.__progressErrors}})()
                    """);
                using var doc=JsonDocument.Parse(result);measurements.Add(doc.RootElement.Clone());
                await Capture(capture);
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-progress.json"),JsonSerializer.Serialize(measurements));
                var row=doc.RootElement;
                if(row.GetProperty("checked").GetInt32()!=expected||row.GetProperty("count").GetString()!=$"{expected}/20"||Math.Abs(row.GetProperty("percent").GetDouble()-expected*5)>0.1||Math.Abs(row.GetProperty("actualPercent").GetDouble()-expected*5)>0.5||row.GetProperty("height").GetDouble()<5||row.GetProperty("errors").GetArrayLength()>0)
                    throw new InvalidDataException("Progress failed to update immediately: "+result);
            }
            await Check(0,"progress-empty");
            for(var i=0;i<3;i++){await Pointer($"({checklist}).querySelectorAll('input[type=checkbox]')[{i}]");await Check(i+1,"progress-"+(i+1));}
            await Pointer($"({checklist}).querySelector('input[type=checkbox]')");await Check(2,"progress-uncheck");
            await Pointer($"({checklist}).querySelector('input[type=checkbox]')");
            for(var i=3;i<20;i++)await Pointer($"({checklist}).querySelectorAll('input[type=checkbox]')[{i}]");
            await Check(20,"progress-complete");
            await Pointer(reset);await Check(0,"progress-reset");
            TraceVisualAudit("dil-progress-passed","real pointer; immediate count and painted width; multiple selections; uncheck; reset; no theme or language refresh");return;
        }
        if(audit.Query.Contains("writing-tasks=1",StringComparison.Ordinal))
        {
            const string writing="[...document.querySelectorAll('.cloudig-dil-widget')].find(n=>n.querySelector('h1')?.textContent.includes('Cloudig · 富界面归档测试记录'))";
            await Wait($"Boolean({writing})");
            await Point($"({writing}).querySelector('ul')");
            await Capture("writing-tasks");
            var result=await Read("""
                (()=>{const n=WRITING,checks=[...n.querySelectorAll('input.cloudig-task-check')];return{count:checks.length,rawMarkers:n.innerText.includes('[ ]'),tables:n.querySelectorAll('table').length,rows:checks.map(c=>{const r=c.getBoundingClientRect(),s=getComputedStyle(c),li=c.closest('li'),walker=document.createTreeWalker(li,NodeFilter.SHOW_TEXT);let t;while(t=walker.nextNode())if(t.textContent.trim())break;const range=document.createRange();range.setStart(t,0);range.setEnd(t,1);const a=range.getBoundingClientRect();return{checked:c.checked,disabled:c.disabled,width:r.width,height:r.height,alignment:Math.abs(r.y+r.height/2-a.y-a.height/2),background:s.backgroundColor,opacity:s.opacity,left:r.left,textLeft:a.left}})}})()
                """.Replace("WRITING",writing));
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".writing-tasks.json"),result);
            using(var doc=JsonDocument.Parse(result))
            {
                var root=doc.RootElement;
                if(root.GetProperty("count").GetInt32()!=7||root.GetProperty("rawMarkers").GetBoolean()||root.GetProperty("tables").GetInt32()!=1)throw new InvalidDataException("Writing task structure: "+result);
                foreach(var row in root.GetProperty("rows").EnumerateArray())
                    if(row.GetProperty("checked").GetBoolean()||!row.GetProperty("disabled").GetBoolean()||row.GetProperty("width").GetDouble()!=18||row.GetProperty("height").GetDouble()!=18||row.GetProperty("alignment").GetDouble()>4||row.GetProperty("opacity").GetString()!="1"||row.GetProperty("background").GetString() is "rgb(255, 255, 255)" or "rgba(0, 0, 0, 0)")throw new InvalidDataException("Writing task appearance: "+result);
            }
            // Saved Markdown is an archive, not a live task form. A real
            // pointer must leave it unchanged; actual DIL forms remain live.
            await Pointer($"({writing}).querySelector('input')");
            await Wait($"!({writing}).querySelector('input').checked");
            const string live="document.querySelector('.cloudig-dil-view input[type=checkbox]:not(:disabled)')";
            var before=await Read($"({live}).checked");await Pointer(live);await Wait($"({live}).checked!=={before}");await Pointer(live);await Wait($"({live}).checked==={before}");
            await Point($"({writing}).querySelector('ul')");await Capture("writing-tasks-final");
            TraceVisualAudit("writing-tasks-passed","seven source task states;table and content retained;checkbox/text geometry;archive does not mutate;adjacent live checkbox still works");return;
        }
        // Real native pickers, not merely the closed input's computed colours.
        var controls = new List<JsonElement>();
        var selects="[...document.querySelectorAll('.cloudig-dil-view select')]";
        var selectCount=int.Parse(await Read(selects+".length"));
        if(selectCount==0)throw new InvalidDataException("Main sample has no selects");
        for(var i=0;i<selectCount;i++)
        {
            var select=$"{selects}[{i}]";await Pointer(select);await Wait($"({select}).matches(':open')");
            var result=await Read($"(()=>{{const n={select},s=getComputedStyle(n,'::picker(select)'),r=n.getBoundingClientRect(),options=[...n.options].map(o=>o.getBoundingClientRect()).filter(r=>r.height>0),top=Math.min(...options.map(r=>r.top)),bottom=Math.max(...options.map(r=>r.bottom));return{{background:s.backgroundColor,color:s.color,appearance:getComputedStyle(n).appearance,scroll:s.scrollbarColor,options:n.options.length,width:r.width,anchorTop:r.top,anchorBottom:r.bottom,optionsTop:top,optionsBottom:bottom,viewportHeight:innerHeight,order:s.positionTryOrder}}}})()");
            using(var row=JsonDocument.Parse(result)){if(row.RootElement.GetProperty("background").GetString() is "rgb(255, 255, 255)" or "rgba(0, 0, 0, 0)"||row.RootElement.GetProperty("appearance").GetString()!="base-select")throw new InvalidDataException("Unthemed open select: "+result);controls.Add(row.RootElement.Clone());}
            using(var row=JsonDocument.Parse(result))
            {
                var r=row.RootElement;var top=r.GetProperty("optionsTop").GetDouble();var bottom=r.GetProperty("optionsBottom").GetDouble();var anchor=r.GetProperty("anchorBottom").GetDouble();
                if(r.GetProperty("order").GetString()!="normal"||((r.GetProperty("viewportHeight").GetDouble()-anchor)>bottom-top+30&&top<anchor))throw new InvalidDataException("Select opens above despite sufficient room below: "+result);
            }
            await Capture("dil-select-open-"+i);await Key("Escape",27);await Wait($"!({select}).matches(':open')");
        }
        var dateButtons="[...document.querySelectorAll('.cloudig-dil-view [data-dil-date-open]')]";
        var dateCount=int.Parse(await Read(dateButtons+".length"));if(dateCount==0)throw new InvalidDataException("Main sample has no date controls");
        for(var i=0;i<dateCount;i++)
        {
            var opener=$"{dateButtons}[{i}]";await Pointer(opener);await Wait("Boolean(document.querySelector('.cloudig-date-picker:popover-open'))");
            var result=await Read("(()=>{const n=document.querySelector('.cloudig-date-picker'),s=getComputedStyle(n),r=n.getBoundingClientRect();return{background:s.backgroundColor,color:s.color,left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()");
            using(var row=JsonDocument.Parse(result)){var r=row.RootElement;if(r.GetProperty("background").GetString() is "rgb(255, 255, 255)" or "rgba(0, 0, 0, 0)"||r.GetProperty("left").GetDouble()<0||r.GetProperty("top").GetDouble()<0||r.GetProperty("right").GetDouble()>r.GetProperty("w").GetDouble()||r.GetProperty("bottom").GetDouble()>r.GetProperty("h").GetDouble())throw new InvalidDataException("Calendar theme/bounds: "+result);controls.Add(r.Clone());}
            await Capture("dil-calendar-open-"+i);
            var day="document.querySelector('.cloudig-date-picker [data-date-value]:not(:disabled):not([aria-pressed=true])')";var chosen=await Read($"({day}).dataset.dateValue");
            await Pointer(day);await Wait("!document.querySelector('.cloudig-date-picker')");await Wait($"({opener}).parentElement.querySelector('input').value==={chosen}");
            await Pointer(opener);await Key("Escape",27);await Wait("!document.querySelector('.cloudig-date-picker')");
        }
        var area="document.querySelector('.cloudig-dil-view textarea')";
        await Pointer(area);var original=await Read($"({area}).value");
        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type="keyDown",key="a",code="KeyA",windowsVirtualKeyCode=65,modifiers=2}));
        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type="keyUp",key="a",code="KeyA",windowsVirtualKeyCode=65,modifiers=2}));
        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText",JsonSerializer.Serialize(new{text=string.Join("\n",Enumerable.Range(1,40).Select(n=>"Scroll verification "+n))}));
        await Wait($"({area}).scrollHeight>({area}).clientHeight+30&&({area}).hasAttribute('data-scroll-region')");
        await Read($"({area}).scrollTop=0");await Pointer($"({area}).closest('.cloudig-dil-view').querySelector('[data-dil-tag=title],[data-dil-tag=text]')");await Mouse("mouseMoved",2,2);
        await Wait($"getComputedStyle({area},'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'");
        var middle=await Point(area);await Mouse("mouseMoved",middle.X,middle.Y);await Task.Delay(250);
        var idleFacts=await Read($"(()=>{{const n={area},probe=document.createElement('span');probe.style.background='var(--cloudig-scroll-idle)';n.parentElement.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return{{actual:getComputedStyle(n,'::-webkit-scrollbar-thumb').backgroundColor,expected,hover:n.matches(':hover'),classes:n.className,hit:document.elementFromPoint({middle.X},{middle.Y})?.outerHTML.slice(0,250),rect:n.getBoundingClientRect().toJSON(),marker:n.hasAttribute('data-scroll-region'),focus:document.activeElement?.outerHTML.slice(0,150)}}}})()");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-scroll-idle.json"),idleFacts);
        using(var row=JsonDocument.Parse(idleFacts))if(row.RootElement.GetProperty("actual").GetString()!=row.RootElement.GetProperty("expected").GetString())throw new InvalidDataException("Shared scroll idle mismatch: "+idleFacts);
        await Capture("dil-textarea-scroll-idle");
        using(var rect=JsonDocument.Parse(await Read($"(()=>{{const n={area},r=n.getBoundingClientRect();return{{x:r.right-6,y:r.top+12,h:r.height}}}})()")))
        {
            var r=rect.RootElement;var x=r.GetProperty("x").GetDouble();var y=r.GetProperty("y").GetDouble();
            await Mouse("mouseMoved",x,y);await Wait($"({area}).classList.contains('cloudig-scroll-operating')");await Capture("dil-textarea-scroll-active");
            var result=await Read($"(()=>{{const n={area},s=getComputedStyle(n,'::-webkit-scrollbar-thumb'),probe=document.createElement('span');probe.style.background='var(--cloudig-scroll-active)';n.parentElement.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return{{actual:s.backgroundColor,expected,width:getComputedStyle(n,'::-webkit-scrollbar').width}}}})()");
            using(var row=JsonDocument.Parse(result)){var p=row.RootElement;if(p.GetProperty("actual").GetString()!=p.GetProperty("expected").GetString()||p.GetProperty("width").GetString()!="8px")throw new InvalidDataException("Shared scroll skin mismatch: "+result);controls.Add(p.Clone());}
            await Mouse("mousePressed",x,y,true);await Mouse("mouseMoved",x,y+Math.Min(60,r.GetProperty("h").GetDouble()/2),true);await Mouse("mouseReleased",x,y+Math.Min(60,r.GetProperty("h").GetDouble()/2));await Wait($"({area}).scrollTop>0");
        }
        await Read($"({area}).value={original};({area}).dispatchEvent(new Event('input',{{bubbles:true}}))");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-controls.json"),JsonSerializer.Serialize(new{selects=selectCount,dates=dateCount,scroll=true,controls}));
        if(audit.Query.Contains("intelligent-ui-controls-only=1",StringComparison.Ordinal)){TraceVisualAudit("intelligent-ui-controls-passed","themed open selects;calendar pointer value and dismissal;shared scrollbar hidden/idle/active/drag");return;}
        // The audit enters a conversation by route, unlike a user's catalog
        // click. Select the real row first; an empty pin set proves nothing.
        var catalogInitiallyCollapsed=await Read("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'")=="true";
        if(catalogInitiallyCollapsed)
        {
            var reveal=await Point("document.querySelector('.reader-catalog-toggle-zone')");await Mouse("mouseMoved",reveal.X,reveal.Y);await Task.Delay(180);
            await Pointer("document.querySelector('[data-reader-catalog-toggle=expand]')");
        }
        await Pointer("document.querySelector('.reader-row-open')");
        await Wait("document.querySelectorAll('.reader-row-selected .reader-row-pin').length===2");
        await Wait($"{views}.length>=40&&!document.querySelector('.cloudig-dil-loading')");
        var originalTheme=await Read("document.documentElement.dataset.theme");
        foreach(var expectedTheme in new[]{originalTheme.Contains("star-night")?"dawn":"star-night",originalTheme.Trim('"')})
        {
            await Pointer("document.querySelector('[data-action=toggle-theme]')");
            await Wait($"document.documentElement.dataset.theme==={JsonSerializer.Serialize(expectedTheme)}&&!document.querySelector('[data-action=toggle-theme]').disabled");
            await Wait($"(()=>{{const pins=[...document.querySelectorAll('.reader-row-selected .reader-row-pin')].filter(n=>getComputedStyle(n).display!=='none');return pins.length>0&&pins.every(n=>n.src.endsWith({JsonSerializer.Serialize(expectedTheme=="star-night"?"Pushpin-Purple.svg":"Pushpin-Red.svg")}))}})()");
            await Capture("dil-pin-"+expectedTheme);
        }
        if(await Read("document.querySelector('[data-page=reader]').dataset.catalogOverlay==='true'&&document.querySelector('[data-page=reader]').dataset.catalogCollapsed!=='true'")=="true")await Pointer("document.querySelector('[data-reader-catalog-toggle=collapse]')");
        var media=$"({View("E03")}).querySelector('video')";
        await Wait($"Boolean({media})&&({View("E03")}).querySelector('[data-mode=remote]')!==null");
        if(await Read($"Boolean(({media}).currentSrc||({media}).querySelector('source[src]'))")!="false")throw new InvalidDataException("Remote video contacted its source before explicit play");
        await Read($"({media}).scrollIntoView({{block:'center',behavior:'instant'}})");
        await Wait($"(()=>{{const b=({View("E03")}).querySelector('.cloudig-media-play'),s=getComputedStyle(b);return s.backgroundColor===(document.documentElement.dataset.theme==='star-night'?'rgb(81, 37, 165)':'rgb(165, 37, 37)')&&s.fontWeight==='700'&&b.getBoundingClientRect().height>=40}})()");
        await Capture("dil-video-play-button");
        await Read($"({media}).muted=true");
        await Pointer($"({View("E03")}).querySelector('.cloudig-media-actions>button')");
        await Wait($"({media}).readyState>=2&&({media}).videoWidth>0&&({media}).currentTime>.05");
        await Read($"({media}).pause()");await Capture("dil-video-played");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".media-playback.json"),await Read($"(()=>{{const v={media};return{{src:v.currentSrc,duration:v.duration,currentTime:v.currentTime,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState}}}})()"));
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
            (()=>{const p=document.querySelector('[data-chart-type=pie]'),legend=p.parentElement.querySelector('.cloudig-dil-chart-legend'),inputs=[...document.querySelectorAll('.cloudig-dil-node input[type=checkbox],.cloudig-dil-node input[type=radio]')],headings=[...document.querySelectorAll('.cloudig-message-content>.cloudig-rich:not(:first-child)>:is(h1,h2,h3,h4,h5,h6):first-child,.cloudig-message-content>.cloudig-dil-view:not(:first-child)>[data-dil-tag=title]')];return{pieHeight:p.getBoundingClientRect().height,legend:legend.innerText,colors:[...legend.querySelectorAll('i')].map(n=>getComputedStyle(n).backgroundColor),choices:inputs.map(n=>({appearance:getComputedStyle(n).appearance,background:getComputedStyle(n).backgroundColor})),headingMargins:headings.map(n=>parseFloat(getComputedStyle(n).marginTop))}})()
            """);
        using(var data=JsonDocument.Parse(readingStyle))
        {
            var r=data.RootElement;
            if(Math.Abs(r.GetProperty("pieHeight").GetDouble()-432)>1||r.GetProperty("headingMargins").GetArrayLength()==0||r.GetProperty("headingMargins").EnumerateArray().Any(n=>n.GetDouble()<18)||r.GetProperty("choices").GetArrayLength()==0||r.GetProperty("choices").EnumerateArray().Any(n=>n.GetProperty("appearance").GetString()!="none"||n.GetProperty("background").GetString()=="rgb(255, 255, 255)"))throw new InvalidDataException("Saved UI reading style regression: "+readingStyle);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-reading-style.json"),readingStyle);
        await Read("[...document.querySelectorAll('.cloudig-rich h2,.cloudig-dil-view>[data-dil-tag=title]')].find(n=>n.textContent.includes('五、ChatGPT'))?.scrollIntoView({block:'center',behavior:'instant'})");await Capture("dil-heading-spacing");
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
            await Wait($"getComputedStyle(document.documentElement).colorScheme==={JsonSerializer.Serialize(originalTheme.Contains("star-night")?"dark":"light")}",frame);
            await Wait("document.scrollingElement.scrollHeight<=innerHeight+2",frame);
            await Task.Delay(300);
            var geometry=await Read("(()=>{const d=document.querySelector('.cloudig-dil-window'),b=d.querySelector(':scope>.cloudig-interactive-body'),f=d.querySelector('iframe'),r=d.getBoundingClientRect();return{windowHeight:innerHeight,dialog:r.height,top:r.top,bottom:r.bottom,layout:d.dataset.workLayout,target:parseFloat(d.style.getPropertyValue('--cloudig-window-height')),available:b.clientHeight,content:b.scrollHeight,frame:f.getBoundingClientRect().height,width:f.getBoundingClientRect().width}})()");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,$".window-{i}-geometry.json"),geometry);
            using(var bounds=JsonDocument.Parse(geometry))if(i<2&&bounds.RootElement.GetProperty("content").GetDouble()>bounds.RootElement.GetProperty("available").GetDouble()+2){await Capture("dil-window-overflow");throw new InvalidDataException("Responsive canvas work unnecessarily scrolls: "+geometry);}
            using(var bounds=JsonDocument.Parse(geometry)){var g=bounds.RootElement;if(g.GetProperty("top").GetDouble()<0||g.GetProperty("bottom").GetDouble()>g.GetProperty("windowHeight").GetDouble()+1||Math.Abs(g.GetProperty("dialog").GetDouble()-g.GetProperty("target").GetDouble())>2)throw new InvalidDataException("Work did not fit its content/viewport policy: "+geometry);}
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
        if(catalogInitiallyCollapsed&&await Read("document.querySelector('[data-page=reader]').dataset.catalogCollapsed!=='true'")=="true")
        {
            var restore=await Point("document.querySelector('.reader-catalog-toggle-zone')");await Mouse("mouseMoved",restore.X,restore.Y);await Task.Delay(180);
            await Pointer("document.querySelector('[data-reader-catalog-toggle=collapse]')");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".intelligent-ui.json"),JsonSerializer.Serialize(new{windows=facts,linked=true,closed=true,zoom=WebView.ZoomFactor}));
        TraceVisualAudit("intelligent-ui-passed","owned views;real input;linked score;bidirectional AppBlock;3 isolated windows;close releases frames");
    }
}
