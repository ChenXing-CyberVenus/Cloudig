using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Only the explicitly requested visual audit's synthetic Library is altered.
    private async Task VerifyTimeCompatibilityAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal) || _libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Time compatibility audit requires its own record Library.");
        Dictionary<string, string> Snapshot() => new[] { "ContentTimes", "Conversations", "Marks" }
            .SelectMany(folder => Directory.GetFiles(Path.Combine(library, folder), "*", SearchOption.AllDirectories))
            .Append(Path.Combine(library, "CloudigLibrary.json"))
            .ToDictionary(file => file, file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
        var before = Snapshot();
        var file = Directory.GetFiles(Path.Combine(library, "ContentTimes"), "*.json")
            .Single(candidate => JsonNode.Parse(File.ReadAllBytes(candidate))?["name"]?.GetValue<string>() == "初见");
        var original = File.ReadAllBytes(file);
        var future = JsonNode.Parse(original)!;
        future["schema"] = "cloudig/content-time/1.1.0";
        var futureBytes = Encoding.UTF8.GetBytes(future.ToJsonString());
        async Task WaitAsync(string condition)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(condition) == "true") return;
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Time compatibility state timed out: {condition}");
        }
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;
                n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") throw new InvalidDataException($"Time compatibility control is obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mousePressed", "mouseReleased" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {
                type, x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble(), button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        }
        async Task CaptureAsync(string suffix)
        {
            await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        const string entry = ".reader-content-time-entry";
        try
        {
            await File.WriteAllBytesAsync(file, futureBytes);
            await ClickAsync(entry);
            await WaitAsync("!!document.querySelector('[role=alertdialog]')");
            var visible = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const d=document.querySelector('[role=alertdialog]'),r=d.getBoundingClientRect(),p=d.querySelector('p'),text=d.textContent;
                return text.includes('请更新采云')&&/update Cloudig/i.test(text)&&text.includes({{JsonSerializer.Serialize(Path.GetFileName(file))}})
                  &&!document.querySelector('[data-time-cover-layer]')&&document.querySelector('.app-root').dataset.route==='reader/cover'
                  &&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&p.scrollHeight<=p.clientHeight+1;})()
                """);
            await CaptureAsync(".time-update-required");
            if (visible != "true")
            {
                var detail = await WebView.CoreWebView2.ExecuteScriptAsync("({text:document.querySelector('[role=alertdialog]')?.textContent,route:document.querySelector('.app-root').dataset.route,rect:document.querySelector('[role=alertdialog]')?.getBoundingClientRect().toJSON()})");
                throw new InvalidDataException($"The real time entry failed to show a readable update-required prompt on its unchanged Reader route: {detail}");
            }
            if (!File.ReadAllBytes(file).SequenceEqual(futureBytes)) throw new InvalidDataException("Query rewrote a newer ContentTime file.");
            foreach (var pair in Snapshot()) if (pair.Key != file && before[pair.Key] != pair.Value) throw new InvalidDataException("Rejected query changed an unrelated business file.");
            await ClickAsync("[role=alertdialog] footer button");
            await WaitAsync("!document.querySelector('[role=alertdialog]')");
        }
        finally { await File.WriteAllBytesAsync(file, original); }
        await ClickAsync(entry);
        await WaitAsync("document.querySelector('[data-time-cover-layer]')?.textContent.includes('初见')===true");
        await CaptureAsync(".time-compatible-again");
        await ClickAsync("[data-time-return-source]");
        await WaitAsync("!document.querySelector('[data-time-cover-layer]')&&document.querySelector('.app-root').dataset.route==='reader/cover'");
        var after = Snapshot();
        if (after.Count != before.Count || before.Any(pair => !after.TryGetValue(pair.Key, out var hash) || pair.Value != hash))
            throw new InvalidDataException("Time version roundtrip changed a record or the display order.");
        TraceVisualAudit("time-compatibility-passed", "native_clicks=4;update_prompt=true;route_preserved=true;all_record_bytes_preserved=true;recovered_without_restart=true");
    }
}
