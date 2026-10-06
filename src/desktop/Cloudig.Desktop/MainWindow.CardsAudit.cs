using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifySavedCardsAsync(VisualAuditOptions audit)
    {
        async Task<string> Read(string script) => await WebView.CoreWebView2.ExecuteScriptAsync(script);
        async Task Capture(string suffix) { await using var output = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output); }
        async Task Check(string expression)
        {
            for (var n = 0; n < 200; n++) { if (await Read(expression) == "true") return; await Task.Delay(50); }
            await Capture("card-failed"); throw new InvalidDataException("Saved card failed: " + expression);
        }
        async Task Point(string selector, bool click = true)
        {
            var name = JsonSerializer.Serialize(selector);
            var scroll = $$"""(()=>{const n=document.querySelector({{name}}),s=n?.closest('.reader-conversation-scroll');if(s){const r=n.getBoundingClientRect(),v=s.getBoundingClientRect();if(r.top<v.top+8||r.bottom>v.bottom-8)s.scrollTop+=r.top-v.top-Math.max(8,(v.height-r.height)/2);} })()""";
            await Read(scroll); await Task.Delay(150); await Read(scroll);
            using var point = JsonDocument.Parse(await Read($$"""(()=>{const n=document.querySelector({{name}});if(!n)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24);return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"""));
            if (point.RootElement.ValueKind == JsonValueKind.Null) { await Capture("card-obstructed"); throw new InvalidDataException("Card control is covered: " + selector); }
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            if (click) foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
            await Task.Delay(80);
        }
        async Task Label(string scope, string zh, string en)
        {
            var found = await Read($$"""
                (()=>{document.querySelectorAll('[data-card-action]').forEach(n=>n.removeAttribute('data-card-action'));const n=[...document.querySelector({{JsonSerializer.Serialize(scope)}}).querySelectorAll('button,summary')].find(n=>[{{JsonSerializer.Serialize(zh)}},{{JsonSerializer.Serialize(en)}}].includes(n.getAttribute('aria-label')||n.textContent.trim()));if(!n||n.disabled)return false;n.dataset.cardAction='';return true;})()
                """);
            if (found != "true") throw new InvalidDataException("Card action missing: " + zh);
            await Point("[data-card-action]");
        }
        await Check("document.querySelector('.route-transition').hidden&&!!document.querySelector('.cloudig-box')");
        if (await Read("!!document.querySelector('.cloudig-structured-window')") == "true") throw new InvalidDataException("A structured Window opened without a click.");
        if (await Read("document.querySelectorAll('.cloudig-box').length===1&&!!document.querySelector('.cloudig-window-entry')") == "true")
        {
            await Point(".cloudig-window-entry button"); await Check("!!document.querySelector('.cloudig-structured-window[open] .cloudig-box-translation')");
            await Check("(()=>{const n=document.querySelector('.cloudig-structured-window'),r=n.getBoundingClientRect();return n.dataset.theme===document.documentElement.dataset.theme&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()");
            await Capture("structured-window");
            foreach (var type in new[] { "keyDown", "keyUp" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key = "Escape", code = "Escape", windowsVirtualKeyCode = 27 }));
            await Check("!document.querySelector('.cloudig-structured-window')&&document.activeElement===document.querySelector('.cloudig-window-entry button')");
            await Point(".cloudig-window-entry button"); await Point(".cloudig-structured-window .cloudig-interactive-close");
            await Check("!document.querySelector('.cloudig-structured-window')");
            TraceVisualAudit("reader-saved-cards-pointer-passed", "derived structured Window: lazy open; themed bounded dialog; Escape/focus; reopen/close; no iframe"); return;
        }
        // The caller chooses a real source. Shuangren intentionally has fewer
        // card types than the separate 16-type Xianzhuo fixture.
        for (var page = 0; page < 80 && await Read("document.querySelectorAll('.cloudig-box[data-source]').length===0") == "true"; page++)
        {
            await Read("(()=>{const s=document.querySelector('.reader-conversation-scroll');if(s)s.scrollTop=s.scrollHeight;})()");
            await Task.Delay(150);
        }
        await Check("document.querySelectorAll('.cloudig-box[data-source]').length>0");
        using var sourceList = JsonDocument.Parse(await Read("[...document.querySelectorAll('.cloudig-box[data-source]')].map((n,index)=>{n.dataset.nativeCard=String(index);return {source:n.dataset.source,index}})"));
        var rows = new List<JsonElement>(); var ordinal = 0;
        foreach (var item in sourceList.RootElement.EnumerateArray())
        {
            var source = item.GetProperty("source").GetString()!; var selector = $".cloudig-box[data-native-card='{item.GetProperty("index").GetInt32()}']"; var selected = $"document.querySelector({JsonSerializer.Serialize(selector)})";
            await Point(selector, false);
            await Check($"[...{selected}.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0)&&!{selected}.classList.contains('cloudig-box-fallback')");
            if (source == "chatgpt.com_dil")
            {
                await Check($"{selected}.dataset.savedOnly==='true'&&!{selected}.querySelector('iframe,script,pre,a')");
                var before = await Read($"{selected}.innerHTML");
                if (await Read($"Boolean({selected}.querySelector('.cloudig-dil-suggestion'))") == "true")
                {
                    await Point(selector + " .cloudig-dil-suggestion");
                    await Check($"{selected}.querySelector('.cloudig-dil-suggestion').getAttribute('aria-disabled')==='true'");
                }
                await Task.Delay(1100);
                if (before != await Read($"{selected}.innerHTML")) throw new InvalidDataException("Saved DIL changed after pointer input or timer wait");
            }
            else if (source.Contains("quiz_display", StringComparison.Ordinal))
            {
                await Point(selector + " .cloudig-box-choice"); await Check($"Boolean({selected}.querySelector('.cloudig-box-feedback'))");
                await Label(selector, "卡片", "Flashcards"); await Label(selector, "查看答案", "View answer");
                await Check($"Boolean({selected}.querySelector('.cloudig-box-flashcard'))");
            }
            else if (source.Contains("recipe_display", StringComparison.Ordinal))
            {
                await Label(selector, "增加份数", "More servings"); await Point(selector + " .cloudig-box-ingredient");
                await Check($"{selected}.querySelector('.cloudig-box-ingredient').getAttribute('aria-pressed')==='true'");
                await Point(selector + " .cloudig-box-units summary"); await Label(selector, "美制", "US");
                await Label(selector, "开始制作", "Start cooking"); await Check($"Boolean({selected}.querySelector('dialog[open]'))");
                await Capture("card-cooking"); await Label(selector, "退出制作", "Exit cooking mode"); await Check($"!{selected}.querySelector('dialog[open]')");
            }
            else if (source.Contains("itinerary", StringComparison.Ordinal))
            {
                if (await Read($"{selected}.querySelectorAll('.cloudig-box-tabs button').length>1") == "true") { await Point(selector + " .cloudig-box-tabs button:nth-child(2)"); await Check($"{selected}.querySelector('.cloudig-box-tabs button:nth-child(2)').getAttribute('aria-pressed')==='true'"); }
            }
            else if (source.Contains("message_compose", StringComparison.Ordinal))
            {
                await Point(selector + " textarea"); await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text = " local check" }));
                await Check($"{selected}.querySelector('textarea').value.includes('local check')");
            }
            else if (source.Contains("chart_display", StringComparison.Ordinal))
            {
                if (await Read($"{selected}.textContent.includes('云量与降水')") == "true") {
                    await Check($"{selected}.querySelectorAll('svg circle').length===12&&{selected}.querySelectorAll('tbody tr').length===12&&{selected}.querySelector('svg').textContent.includes('100')");
                    await Point(selector + " svg", false); await Capture("scatter-points");
                }
                await Label(selector, "表格", "Table"); await Check($"!{selected}.querySelector('.cloudig-box-data-table').hidden"); await Capture("card-chart-table"); await Label(selector, "图表", "Chart");
            }
            else if (source.EndsWith("weather_fetch", StringComparison.Ordinal)) { await Point(selector + " .cloudig-box-weather-day"); await Check($"{selected}.textContent.includes(document.documentElement.lang==='en'?'Precipitation':'降水')"); }
            else if (source.Contains("places_list", StringComparison.Ordinal)) { await Label(selector, "逐个查看", "View one by one"); await Label(selector, "下一项", "Next"); await Label(selector, "查看全部", "View all"); }
            else if (source.Contains("ask_user_input", StringComparison.Ordinal)) await Check($"!{selected}.querySelector('input,button,textarea')");
            else if (source.Contains("places_map", StringComparison.Ordinal)) await Check("!document.querySelector('.cloudig-map-window')");
            else if (await Read($"Boolean({selected}.querySelector('.cloudig-box-pager > button:last-child:not(:disabled)'))") == "true") await Point(selector + " .cloudig-box-pager > button:last-child");
            var galleryCount=int.Parse(await Read($"(()=>{{const a=[...{selected}.querySelectorAll('.cloudig-box-images')];a.forEach((n,i)=>n.dataset.nativeGallery=String(i));return a.length;}})()"));
            for(var imageGroup=0;imageGroup<galleryCount;imageGroup++) {
                var gallery=selector+$" [data-native-gallery='{imageGroup}']";var readGallery=$"document.querySelector({JsonSerializer.Serialize(gallery)})";
                var imageCount=int.Parse(await Read("Number("+readGallery+".dataset.imageCount)"));
                await Check($"{readGallery}.querySelector('.cloudig-gallery-stage').children.length===Math.min(3,{imageCount})");
                await Check($"(()=>{{const a=[...{readGallery}.querySelector('.cloudig-gallery-stage').children].map(n=>n.getBoundingClientRect());return a.every((r,i)=>r.width>0&&Math.abs(r.width-a[0].width)<2&&(i===0||r.left>=a[i-1].right));}})()");
                if(imageCount>3) {
                    var pages=(imageCount+2)/3;
                    for(var page=1;page<pages;page++) {
                        var first=page*3+1;var end=Math.Min(page*3+3,imageCount);var label=(first==end?first.ToString():$"{first}–{end}")+$" / {imageCount}";
                        await Point(gallery+" .cloudig-gallery-arrow:last-child");await Check(readGallery+".querySelector('.cloudig-gallery-count').textContent==="+JsonSerializer.Serialize(label));
                        await Check($"{readGallery}.querySelector('.cloudig-gallery-stage').children.length==={end-first+1}&&[...{readGallery}.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0)");
                    }
                    for(var page=1;page<pages;page++) await Point(gallery+" .cloudig-gallery-arrow:first-child");
                } else await Check("!"+readGallery+".querySelector('.cloudig-gallery-controls')");
            }
            await Check($"{selected}.scrollWidth<={selected}.clientWidth+1");
            await Point(selector, false); await Capture($"card-{++ordinal}-{source}");
            using var row = JsonDocument.Parse(await Read($"({{source:{JsonSerializer.Serialize(source)},text:{selected}.innerText.slice(0,1000),images:{selected}.querySelectorAll('img').length,overflow:{selected}.scrollWidth-{selected}.clientWidth}})")); rows.Add(row.RootElement.Clone());
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".cards.json"), JsonSerializer.Serialize(rows));
        TraceVisualAudit("reader-saved-cards-pointer-passed", $"{rows.Count} native captured card types; actual controls; local draft editing; no send/copy/external/map actions; screenshots and image checks");
    }
}
