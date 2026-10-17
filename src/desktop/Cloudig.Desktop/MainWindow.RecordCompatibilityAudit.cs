using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyRecordCompatibilityAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal) || _libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Record compatibility audit requires its own copied Library.");
        var originals = Directory.GetFiles(Path.Combine(library, "Conversations"), "*.json").ToDictionary(file => file, File.ReadAllBytes);
        if (originals.Count != 1) throw new InvalidDataException("This audit requires one old supported Conversation.");
        var futurePath = Path.Combine(library, "Conversations", "future-format-audit.json");
        if (File.Exists(futurePath)) throw new InvalidDataException("Refusing to overwrite a pre-existing test file.");
        var future = JsonNode.Parse(originals.Single().Value)!;
        if (future["schema"]?.GetValue<string>() != "cloudig/conversation/1.0.0") throw new InvalidDataException("The compatibility input is not the old format.");
        future["schema"] = "cloudig/conversation/1.0.2"; future["conversation_id"] = Guid.CreateVersion7().ToString();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(future);
        await File.WriteAllBytesAsync(futurePath, bytes);
        using var point = JsonDocument.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('[data-archive-refresh]'),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"));
        if (point.RootElement.ValueKind == JsonValueKind.Null) throw new InvalidDataException("Archive refresh is covered.");
        foreach (var type in new[] { "mousePressed", "mouseReleased" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble(), button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        var passed = false;
        for (var n = 0; n < 200; n++)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('.cloudig-notice[role=status]');return !!n&&n.textContent.includes('future-format-audit.json')&&/请更新采云|Please update Cloudig/.test(n.textContent)&&document.querySelectorAll('.archiver-archive-row').length===1;})()") == "true") { passed = true; break; }
            await Task.Delay(50);
        }
        await using (var output = File.Create(Path.ChangeExtension(audit.OutputFile, ".record-update-required.png"))) await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
        if (!passed) throw new InvalidDataException("Unsupported Conversation did not show an update notice while retaining the old readable row.");
        if (!File.ReadAllBytes(futurePath).SequenceEqual(bytes) || originals.Any(item => !File.ReadAllBytes(item.Key).SequenceEqual(item.Value))) throw new InvalidDataException("Archive refresh rewrote a Conversation.");
        TraceVisualAudit("record-compatibility-passed", "old 1.0.0 row retained; future 1.0.2 upgrade notice; actual refresh pointer; both original byte sequences unchanged");
        File.Delete(futurePath); // Only the exact file created above, verified unchanged, in this owned test Library.
        using var notice = JsonDocument.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('.cloudig-notice'),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()"));
        if (notice.RootElement.ValueKind == JsonValueKind.Null) throw new InvalidDataException("Upgrade notice cannot be dismissed with a pointer.");
        foreach (var type in new[] { "mousePressed", "mouseReleased" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = notice.RootElement.GetProperty("x").GetDouble(), y = notice.RootElement.GetProperty("y").GetDouble(), button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        await Task.Delay(80);
        if (await WebView.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('.cloudig-notice-layer')") != "false") throw new InvalidDataException("Upgrade notice did not dismiss.");
    }
}
