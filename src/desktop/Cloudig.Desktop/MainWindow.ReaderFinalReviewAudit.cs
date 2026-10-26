using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyReaderFinalReviewAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Capture(string name) { await using var s=File.Create(Path.ChangeExtension(audit.OutputFile,name+".png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,s); }
        async Task Wait(string expression) { for(var i=0;i<240;i++){if(await Read(expression)=="true")return;await Task.Delay(50);}throw new InvalidDataException("Reader review failed: "+expression); }
        async Task Mouse(string type,double x,double y) => await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button=type=="mouseMoved"?"none":"left",buttons=type=="mousePressed"?1:0,clickCount=type=="mouseMoved"?0:1}));
        async Task Pointer(string selector,bool click=true)
        {
            using var p=JsonDocument.Parse(await Read($$"""(()=>{const r=document.querySelector({{JsonSerializer.Serialize(selector)}}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()"""));
            var x=p.RootElement.GetProperty("x").GetDouble();var y=p.RootElement.GetProperty("y").GetDouble();await Mouse("mouseMoved",x,y);await Task.Delay(150);
            // Catalog handles become actionable only after a genuine hover.
            if(await Read($$"""(()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()""")!="true")throw new InvalidDataException("Reader control is obscured: "+selector);
            if(click){await Mouse("mousePressed",x,y);await Mouse("mouseReleased",x,y);}await Task.Delay(150);
        }
        const string total="(()=>{const n=Number(document.querySelector('[data-reader-total-count]').textContent),s=document.querySelector('[data-reader-total]').textContent;return n>0&&s===(document.documentElement.lang==='en'?`Total ${n} conversation${n===1?'':'s'}`:`总${n}篇对话`)})()";
        await Wait(total);
        for(var pass=0;pass<2;pass++){
            var language=await Read("document.documentElement.lang");
            await Pointer("[data-page=reader] [data-action=toggle-language]");await Wait($"document.documentElement.lang!=={language}");await Wait(total);
        }
        await Wait("Boolean(document.querySelector('.cloudig-message-user .cloudig-message-content'))");
        var shape=await Read("(()=>{const c=getComputedStyle(document.querySelector('.cloudig-message-user .cloudig-message-content'));return[c.borderTopLeftRadius,c.borderTopRightRadius,c.borderBottomRightRadius,c.borderBottomLeftRadius]})()");
        using(var radii=JsonDocument.Parse(shape))if(radii.RootElement[0].GetString()!="0px"||radii.RootElement.EnumerateArray().Skip(1).Any(v=>v.GetString()!="22px"))throw new InvalidDataException("User bubble corners differ from the design");
        await Read("document.querySelector('.reader-conversation-scroll').scrollTop=0");await Task.Delay(250);
        await Read("document.querySelector('.reader-message-copy')?.closest('.cloudig-message,.cloudig-message-envelope').scrollIntoView({block:'center'})");await Task.Delay(200);
        await Pointer(".reader-message-copy",false);await Task.Delay(200);
        var copy=await Read("(()=>{const b=document.querySelector('.reader-message-copy');return{fill:getComputedStyle(b,'::before').backgroundColor,opacity:getComputedStyle(b).opacity,theme:document.documentElement.dataset.theme}})()");
        using(var c=JsonDocument.Parse(copy)){var expected=c.RootElement.GetProperty("theme").GetString()=="star-night"?"rgb(81, 37, 165)":"rgb(165, 37, 37)";if(c.RootElement.GetProperty("fill").GetString()!=expected||c.RootElement.GetProperty("opacity").GetString()!="1")throw new InvalidDataException("Copy action theme/hover mismatch: "+copy);}
        await Capture("reader-copy-bubble");
        var catalogWasCollapsed=await Read("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'")=="true";
        if(catalogWasCollapsed){await Pointer("[data-reader-catalog-toggle=expand]");await Wait("document.querySelector('.reader-row-title').getBoundingClientRect().height>0");}
        var titles=await Read("[...document.querySelectorAll('.reader-row-title')].map(n=>{const r=n.getBoundingClientRect(),m=n.nextElementSibling.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect();return{height:r.height,lineHeight:parseFloat(getComputedStyle(n).lineHeight),metaBottom:m.bottom,parentBottom:p.bottom,text:n.textContent}})");
        using(var rows=JsonDocument.Parse(titles))foreach(var r in rows.RootElement.EnumerateArray())if(r.GetProperty("height").GetDouble()<r.GetProperty("lineHeight").GetDouble()-.5||r.GetProperty("metaBottom").GetDouble()>r.GetProperty("parentBottom").GetDouble()+.5)throw new InvalidDataException("Catalog text line is clipped: "+titles);
        await Capture("reader-catalog-text");
        if(catalogWasCollapsed){await Pointer("[data-reader-catalog-toggle=collapse]");await Wait("document.querySelector('.reader-row-title').getBoundingClientRect().height===0");}
        // Wheel the real Reader, including lazy append; the right list must
        // follow without using scrollIntoView on either pane.
        for(var pass=0;pass<18;pass++){
            using var area=JsonDocument.Parse(await Read("(()=>{const r=document.querySelector('.reader-conversation-scroll').getBoundingClientRect();return{x:r.right-12,y:r.y+r.height/2}})()"));
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseWheel",x=area.RootElement.GetProperty("x").GetDouble(),y=area.RootElement.GetProperty("y").GetDouble(),deltaX=0,deltaY=20000}));
            await Task.Delay(300);
            if(await Read("(()=>{const s=document.querySelector('.reader-conversation-scroll'),n=document.querySelector('.reader-navigation-list');return s.scrollHeight-s.scrollTop-s.clientHeight<3&&n.lastElementChild?.dataset.current==='true'})()") == "true")break;
        }
        await Wait("(()=>{const s=document.querySelector('.reader-conversation-scroll'),l=document.querySelector('.reader-navigation-list'),n=l.querySelector('[data-current=true]');if(!n)return false;const a=n.getBoundingClientRect(),b=l.getBoundingClientRect();return s.scrollHeight-s.scrollTop-s.clientHeight<3&&n===l.lastElementChild&&a.top>=b.top-1&&a.bottom<=b.bottom+1})()");
        var axis=await Read("(()=>{const s=document.querySelector('.reader-conversation-scroll'),n=document.querySelector('.cloudig-message-list'),r=n.getBoundingClientRect(),b=s.getBoundingClientRect(),c=getComputedStyle(n,'::before');return{lineBottom:r.bottom-parseFloat(c.bottom),viewportBottom:b.bottom,navTop:document.querySelector('.reader-navigation-list').scrollTop}})()");
        using(var a=JsonDocument.Parse(axis))if(Math.Abs(a.RootElement.GetProperty("lineBottom").GetDouble()-a.RootElement.GetProperty("viewportBottom").GetDouble())>2)throw new InvalidDataException("Message axis stops before the viewport floor: "+axis);
        await Capture("reader-bottom-navigation-axis");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".reader-seven.json"),JsonSerializer.Serialize(new{shape=JsonSerializer.Deserialize<JsonElement>(shape),copy=JsonSerializer.Deserialize<JsonElement>(copy),titles=JsonSerializer.Deserialize<JsonElement>(titles),axis=JsonSerializer.Deserialize<JsonElement>(axis)}));
        TraceVisualAudit("reader-seven-passed","Count survived route/language; title ink room; bubble/copy theme; native wheel followed right navigation and full-height message axis");
    }
}
