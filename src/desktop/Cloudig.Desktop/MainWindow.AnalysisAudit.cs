using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task VerifyAnalysisLinksAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string expression) => await WebView.CoreWebView2.ExecuteScriptAsync(expression);
        async Task Click(string selector)
        {
            var encoded=JsonSerializer.Serialize(selector);
            await Read($"document.querySelector({encoded}).scrollIntoView({{block:'center'}})");
            await Task.Delay(120);
            var raw=await Read($$"""
                (()=>{const n=document.querySelector({{encoded}}),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                if(!n.contains(document.elementFromPoint(x,y)))throw Error('Analysis control obstructed');return{x,y};})()
                """);
            using var p=JsonDocument.Parse(raw);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{
                    type,x=p.RootElement.GetProperty("x").GetDouble(),y=p.RootElement.GetProperty("y").GetDouble(),
                    button=type=="mouseMoved"?"none":"left",buttons=type=="mousePressed"?1:0,clickCount=type=="mouseMoved"?0:1}));
            await Task.Delay(120);
        }
        for(var step=0;step<180;step++)
        {
            if(await Read("!!document.querySelector('.cloudig-analysis-open')")=="true")break;
            await Read("(()=>{const s=document.querySelector('[data-reader-conversation-scroll]');s.scrollTop+=Math.max(500,s.clientHeight*.8)})()");
            await Task.Delay(100);
        }
        if(await Read("!!document.querySelector('.cloudig-analysis-open')")!="true")throw new InvalidDataException("No analysis entry in actual Reader");
        await Read("document.querySelector('.cloudig-analysis-open').dataset.auditAnalysis='first'");
        await Read("document.querySelector('[data-audit-analysis=first]').scrollIntoView({block:'center'})");
        await Task.Delay(120);
        if(await Read("(()=>{const b=document.querySelector('[data-audit-analysis=first]'),r=b.getBoundingClientRect(),t=document.createRange();t.selectNodeContents(b);const s=t.getBoundingClientRect();return s.left>=r.left&&s.right<=r.right&&s.top>=r.top&&s.bottom<=r.bottom})()")!="true")throw new InvalidDataException("Analysis button text overflows");
        await using(var file=File.Create(Path.ChangeExtension(audit.OutputFile,".analysis-entry.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);
        await Click("[data-audit-analysis='first']");
        var facts=await Read("""
            (()=>{const b=document.querySelector('[data-audit-analysis=first]'),a=b.closest('.cloudig-message'),ids=b.getAttribute('aria-controls').split(' '),nodes=ids.map(id=>document.getElementById(id));
            return{paired:nodes.length,sameMessage:nodes.every(n=>n?.closest('.cloudig-message')===a),opened:nodes.every(n=>n?.open&&n.querySelector('pre')&&!n.parentElement.closest('details:not([open])')),
              codeChars:nodes[0]?.querySelector('code')?.textContent.length??0,sourceTools:[...document.querySelectorAll('.cloudig-tool>.cloudig-fold-title')].filter(n=>n.textContent==='检索来源').length};})()
            """);
        using var result=JsonDocument.Parse(facts);
        if(result.RootElement.GetProperty("paired").GetInt32()<2||!result.RootElement.GetProperty("sameMessage").GetBoolean()||!result.RootElement.GetProperty("opened").GetBoolean()||result.RootElement.GetProperty("codeChars").GetInt32()==0||result.RootElement.GetProperty("sourceTools").GetInt32()!=0)
            throw new InvalidDataException("Analysis call/result navigation failed: "+facts);
        await using(var file=File.Create(Path.ChangeExtension(audit.OutputFile,".analysis-open.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);
        var source=await Read("(()=>{const s=[...document.querySelectorAll('.cloudig-references>.cloudig-fold-title')].find(n=>n.textContent==='检索来源');if(!s)return false;s.dataset.auditSources='first';return true})()");
        if(source!="true")throw new InvalidDataException("No source summary in actual Reader");
        if(await Read("(()=>{const s=document.querySelector('[data-audit-sources=first]').parentElement.parentElement.closest('details:not([open])');if(!s)return false;s.querySelector(':scope>summary').dataset.auditSourceGroup='first';return true})()") == "true")
            await Click("[data-audit-source-group='first']");
        await Click("[data-audit-sources='first']");
        if(await Read("(()=>{const s=document.querySelector('[data-audit-sources=first]').closest('details');return s.open&&s.querySelectorAll('a').length>0})()")!="true")throw new InvalidDataException("Source summary failed to open");
        await using(var file=File.Create(Path.ChangeExtension(audit.OutputFile,".analysis-sources.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".analysis.json"),facts);
        TraceVisualAudit("reader-analysis-native-pointer-passed");
    }
}
