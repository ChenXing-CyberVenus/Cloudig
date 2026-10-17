using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyReaderLayoutFixesAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string js)=>await WebView.CoreWebView2.ExecuteScriptAsync(js);
        async Task Click(string selector)
        {
            await Read($"document.querySelector({JsonSerializer.Serialize(selector)})?.scrollIntoView({{block:'center',behavior:'instant'}})");
            using var point=JsonDocument.Parse(await Read($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """));
            if(point.RootElement.ValueKind==JsonValueKind.Null)throw new InvalidDataException("Reader control is obstructed: "+selector);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble(),button="left",clickCount=1}));
        }
        if(await Read("Boolean(document.querySelector('.reader-doc-content ul')?.getBoundingClientRect().height)")=="true")
        {
            var facts=await Read("""
                (()=>{const u=document.querySelector('.reader-doc-content ul'),r=u.getBoundingClientRect(),paper=u.closest('.reader-doc-board').getBoundingClientRect(),label=u.querySelector('.reader-doc-label'),opticalOffset=-new DOMMatrix(getComputedStyle(label).transform).m41,rows=[...u.querySelectorAll('button')].map(b=>{const dot=b.querySelector('i').getBoundingClientRect(),s=b.querySelector('.reader-doc-label>span'),t=document.createRange();t.selectNodeContents(s);const text=t.getBoundingClientRect(),br=b.getBoundingClientRect();return {left:dot.left,right:text.right,textLeft:text.left,buttonLeft:br.left,buttonRight:br.right,overflow:s.scrollWidth>s.clientWidth+1}}),signedCenterOffset=(Math.min(...rows.map(n=>n.left))+Math.max(...rows.map(n=>n.right)))/2-(paper.left+paper.right)/2;return {left:r.left,right:r.right,paperCenter:(paper.left+paper.right)/2,rows,opticalOffset,signedCenterOffset,centerError:Math.abs(signedCenterOffset+opticalOffset),alignmentError:Math.max(...rows.map(n=>n.textLeft))-Math.min(...rows.map(n=>n.textLeft))}})()
                """);
            using var data=JsonDocument.Parse(facts);var root=data.RootElement;
            if(root.GetProperty("centerError").GetDouble()>1.5||root.GetProperty("alignmentError").GetDouble()>1||root.GetProperty("opticalOffset").GetDouble()<=0||root.GetProperty("rows").EnumerateArray().Any(n=>n.GetProperty("overflow").GetBoolean()))throw new InvalidDataException("Reader document column is not balanced: "+facts);
            var vertical=await Read("""
                (()=>{const u=document.querySelector('.reader-doc-content ul'),board=u.closest('.reader-doc-board').getBoundingClientRect(),log=document.querySelector('.reader-system-log').getBoundingClientRect(),rows=[...u.querySelectorAll('.reader-doc-label>span')].map(n=>n.getBoundingClientRect()),wave=board.top+board.height*1698.545/1920,topGap=Math.min(...rows.map(r=>r.top))-log.bottom,bottomGap=wave-Math.max(...rows.map(r=>r.bottom));return{topGap,bottomGap,wave,gapError:Math.abs(topGap-bottomGap)}})()
                """);
            using(var v=JsonDocument.Parse(vertical))if(v.RootElement.GetProperty("gapError").GetDouble()>1||v.RootElement.GetProperty("topGap").GetDouble()<0||v.RootElement.GetProperty("bottomGap").GetDouble()<0)throw new InvalidDataException("Reader document rows are not centred above the wave: "+vertical);
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".document-vertical.json"),vertical);
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".document-column.json"),facts);
            await VerifyReaderPlatformSelectionAsync(audit);
        }
        else
        {
            await Click("[data-reader-navigation-jump=last]");
            var ready=false;for(var n=0;n<300;n++){if(await Read("Boolean(document.querySelector('[data-reader-load-earlier]:not([hidden])'))")=="true"){ready=true;break;}await Task.Delay(50);}
            if(!ready)throw new InvalidDataException("Earlier-message audit requires a real paginated conversation");
            await Read("document.querySelector('[data-reader-load-earlier]').scrollIntoView({block:'center',behavior:'instant'})");
            var facts=await Read("""
                (()=>{const b=document.querySelector('[data-reader-load-earlier]'),r=b.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(b);const rects=[...range.getClientRects()],text=range.getBoundingClientRect();return {lines:rects.length,width:r.width,height:r.height,textWidth:text.width,textHeight:text.height,inside:text.left>=r.left&&text.right<=r.right&&text.top>=r.top&&text.bottom<=r.bottom,offset:document.querySelector('.cloudig-message')?.dataset.messageAnchor}})()
                """);
            using var data=JsonDocument.Parse(facts);if(!data.RootElement.GetProperty("inside").GetBoolean()||data.RootElement.GetProperty("lines").GetInt32()!=1)throw new InvalidDataException("Earlier-message label exceeds its outline: "+facts);
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".earlier-button.json"),facts);
            await using(var stream=File.Create(Path.ChangeExtension(audit.OutputFile,".earlier-button.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);
            await Click("[data-reader-load-earlier]");await Task.Delay(350);
        }
        TraceVisualAudit("reader-layout-fixes-passed");
    }
}
