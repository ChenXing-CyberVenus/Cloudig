using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyDilPrimitivesAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string js)=>await WebView.CoreWebView2.ExecuteScriptAsync(js);
        for(var n=0;n<200;n++){if(await Read("document.querySelectorAll('.cloudig-dil-view [data-dil-tag=row]').length>0&&!document.querySelector('.cloudig-dil-loading')")=="true")break;await Task.Delay(50);}
        var facts=await Read("""
            (()=>{
              const lines=[...document.querySelectorAll('[data-dil-tag=box]')].filter(n=>parseFloat(n.style.width)>0&&parseFloat(n.style.width)<5&&parseFloat(n.style.minHeight)>32&&!n.textContent.trim());
              if(!lines.length)throw new Error('No captured layout connectors');
              const group=lines[0].parentElement.parentElement.parentElement,rows=[...group.children];
              if(rows.length!==lines.length+1)throw new Error('Connector/row count mismatch');
              const sample=lines.map((n,i)=>{
                const s=getComputedStyle(n),r=n.getBoundingClientRect(),label=n.previousElementSibling.getBoundingClientRect(),row=n.parentElement.parentElement,next=rows[i+1].getBoundingClientRect();
                if(s.backgroundColor==='transparent'||s.backgroundColor==='rgba(0, 0, 0, 0)')throw new Error('Semantic connector is invisible');
                if(Math.abs(r.width-parseFloat(n.style.width))>1||r.height<parseFloat(n.style.minHeight)-1)throw new Error('Connector lost declared geometry');
                if(Math.abs((r.left+r.right-label.left-label.right)/2)>1||Math.abs(r.top-label.bottom)>1||Math.abs(r.bottom-next.top)>1)throw new Error('Connector detached from its number or next row');
                return {color:s.backgroundColor,width:r.width,height:r.height,label:row.firstElementChild.textContent.trim(),text:row.lastElementChild.textContent};
              });
              const labels=rows.map(row=>row.firstElementChild.textContent.trim());
              if(labels.some((x,i)=>x!==String(i+1)))throw new Error('Numbered sequence is incomplete');
              group.dataset.auditPrimitiveGroup='true';
              return {sample,labels,rows:rows.length};
            })()
            """);
        using(var parsed=JsonDocument.Parse(facts))if(parsed.RootElement.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("Missing primitive geometry: "+facts);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-primitives.json"),facts);
        await Read("document.querySelector('[data-audit-primitive-group]').scrollIntoView({block:'start',behavior:'instant'})");await Task.Delay(100);
        using(var point=JsonDocument.Parse(await Read("(()=>{const n=document.querySelector('[data-audit-primitive-group]>[data-dil-tag=row]'),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()")))
        {
            if(point.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Layout row is obstructed");
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseMoved",x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble()}));
        }
        await using var stream=File.Create(Path.ChangeExtension(audit.OutputFile,".dil-primitives.png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);
        TraceVisualAudit("dil-primitives-passed","semantic paint;declared size;number alignment;row continuity");
    }

    private async Task VerifyDilFidelityAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string js)=>await WebView.CoreWebView2.ExecuteScriptAsync(js);
        async Task Capture(string name){await using var stream=File.Create(Path.ChangeExtension(audit.OutputFile,name+".png"));await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);}
        for(var n=0;n<200;n++){if(await Read("document.querySelectorAll('.cloudig-dil-view').length>20&&!document.querySelector('.cloudig-dil-loading')")=="true")break;await Task.Delay(50);}
        var facts=await Read("(()=>{const v=[...document.querySelectorAll('.cloudig-dil-view')],icons=[...document.querySelectorAll('.cloudig-dil-icon')],titles=[...document.querySelectorAll('[data-dil-tag=title]')];return{views:v.length,suggestions:document.querySelectorAll('.cloudig-dil-suggestion').length,iconPlaceholders:icons.filter(n=>n.textContent==='◇').length,icons:icons.length,headingSizes:[...new Set(titles.map(n=>getComputedStyle(n).fontSize))],danger:titles.filter(n=>n.style.color.includes('danger')).map(n=>getComputedStyle(n).color),links:document.querySelectorAll('.cloudig-dil-view a[href]').length}})()");
        using(var data=JsonDocument.Parse(facts)){var r=data.RootElement;if(r.GetProperty("views").GetInt32()<20||r.GetProperty("suggestions").GetInt32()!=2||r.GetProperty("iconPlaceholders").GetInt32()!=0||r.GetProperty("headingSizes").GetArrayLength()<2||r.GetProperty("danger").GetArrayLength()<1||r.GetProperty("links").GetInt32()<70)throw new InvalidDataException("Daily UI fidelity mismatch: "+facts);}
        foreach(var (name,expression) in new[]{
            ("dil-daily-stats","[...document.querySelectorAll('[data-dil-tag=row]')].find(n=>n.querySelector('[data-dil-tag=title]'))"),
            ("dil-daily-suggestion","document.querySelector('.cloudig-dil-suggestion')"),
            ("dil-daily-table","[...document.querySelectorAll('[data-dil-tag=table]')].find(n=>n.querySelector('.cloudig-dil-icon'))")})
        {
            await Read($"({expression})?.scrollIntoView({{block:'center',behavior:'instant'}})");await Task.Delay(250);
            var geometry=await Read($"(()=>{{const n={expression};if(!n)return null;const r=n.getBoundingClientRect();return{{width:r.width,height:r.height,top:r.top,left:r.left,text:n.innerText,children:[...n.children].map(c=>({{width:c.getBoundingClientRect().width,flex:getComputedStyle(c).flex}}))}}}})()");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,name+".json"),geometry);
            using(var data=JsonDocument.Parse(geometry)){if(data.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Missing daily UI target: "+name);if(name=="dil-daily-stats"){var children=data.RootElement.GetProperty("children");if(children.GetArrayLength()==2&&Math.Abs(children[0].GetProperty("width").GetDouble()-children[1].GetProperty("width").GetDouble())>2)throw new InvalidDataException("Unequal native statistic columns: "+geometry);}if(name=="dil-daily-table"&&!data.RootElement.GetProperty("text").GetString()!.Contains("02:30",StringComparison.Ordinal))throw new InvalidDataException("Formatted time missing from table");}
            if(name=="dil-daily-suggestion"){
                using var point=JsonDocument.Parse(await Read($"(()=>{{const n={expression},r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{{x,y}}:null}})()"));
                if(point.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Suggestion pointer is blocked");
                var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();var before=await Read("location.href");
                foreach(var type in new[]{"mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
                if(before!=await Read("location.href"))throw new InvalidDataException("Saved suggestion navigated");
            }
            await Capture(name);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".dil-fidelity.json"),facts);
        TraceVisualAudit("dil-fidelity-passed","source hierarchy;semantic colour;owned icons;static suggestion pointer;time formatting;citations");
    }
}
