using System;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyCapturedTaskCardsAsync(VisualAuditOptions audit)
    {
        var match = Regex.Match(audit.Query, @"(?:^|&)task-card-count=(\d+)");
        var expected = match.Success ? int.Parse(match.Groups[1].Value) : 3;
        if (expected < 1) throw new InvalidDataException("Empty task-card acceptance");
        for (var step = 0; step < 160; step++)
        {
            var found = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{if(document.querySelectorAll('.cloudig-schedule-task').length>={{expected}})return true;
                const s=document.querySelector('[data-reader-conversation-scroll]');s.scrollTop+=Math.max(500,s.clientHeight*.8);return false;})()
                """);
            if (found == "true") break;
            await Task.Delay(100);
        }
        var count = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-schedule-task').length");
        if (count != expected.ToString()) throw new InvalidDataException($"Task count {count}, expected {expected}");
        async Task ClickAsync(int index)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelectorAll('.cloudig-schedule-task')[{index}].querySelector('summary').scrollIntoView({{block:'center'}})");
            await Task.Delay(100);
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelectorAll('.cloudig-schedule-task')[{{index}}].querySelector('summary'),r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Task summary obstructed');return{x,y};})()
                """);
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {
                    type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(),
                    button=type=="mouseMoved"?"none":"left", buttons=type=="mousePressed"?1:0, clickCount=type=="mouseMoved"?0:1
                }));
            await Task.Delay(100);
        }
        for (var i = 0; i < expected; i++)
        {
            var closed = await WebView.CoreWebView2.ExecuteScriptAsync($"!document.querySelectorAll('.cloudig-schedule-task')[{i}].open");
            if (closed != "true") throw new InvalidDataException("Task should start folded");
            await ClickAsync(i);
            var opened = await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelectorAll('.cloudig-schedule-task')[{i}].open && !!document.querySelectorAll('.cloudig-schedule-task')[{i}].querySelector('.cloudig-schedule-settings')");
            if (opened != "true") throw new InvalidDataException("Native pointer did not reveal task settings");
            if (i == 0)
            {
                await using var screenshot = File.Create(Path.ChangeExtension(audit.OutputFile,".task-open.png"));
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,screenshot);
            }
            await ClickAsync(i);
        }
        var result = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const cards=[...document.querySelectorAll('.cloudig-schedule-task')],owner=document.querySelector('[data-reader-conversation-scroll]').getBoundingClientRect();
            cards[0].scrollIntoView({block:'center'});return{tasks:cards.length,closedAgain:cards.every(c=>!c.open),
            rows:cards.map(c=>{const r=c.getBoundingClientRect(),s=c.querySelector('summary'),state=s.querySelector('.cloudig-schedule-state');return{status:c.dataset.taskStatus,label:state?.textContent,
            stateVisible:!!state&&getComputedStyle(state).display!=='none',fits:r.left>=owner.left&&r.right<=owner.right+1,summaryHeight:s.getBoundingClientRect().height}})}})()
            """);
        using var facts = JsonDocument.Parse(result);
        if (!facts.RootElement.GetProperty("closedAgain").GetBoolean()) throw new InvalidDataException("Task did not refold");
        foreach (var row in facts.RootElement.GetProperty("rows").EnumerateArray())
            if (!row.GetProperty("fits").GetBoolean() || !row.GetProperty("stateVisible").GetBoolean()) throw new InvalidDataException("Task card layout/state failed: "+result);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".schedule-cards.json"),result);
        TraceVisualAudit("reader-schedule-cards-passed");
        TraceVisualAudit($"reader-task-native-clicks-passed {expected*2}");
    }
}
