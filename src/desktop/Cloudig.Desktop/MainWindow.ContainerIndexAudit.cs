using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private async Task VerifyContainerReopenAsync(VisualAuditOptions audit)
    {
        var library = Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library");
        if (_libraryRoot != library) throw new InvalidDataException("Index reopening audit requires its owned Library.");
        var indexFile = Directory.GetFiles(Path.Combine(library, "appdata", "indexes", "platform-json"), "*.json").Single();
        var before = SHA256.HashData(await File.ReadAllBytesAsync(indexFile));
        var times = new List<long>();
        async Task Wait(string condition)
        {
            for (var n=0;n<200;n++) { if(await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({condition})")=="true")return;await Task.Delay(50); }
            throw new InvalidDataException("ZIP reopen did not settle: "+condition);
        }
        async Task Click(string selector)
        {
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """);
            if(raw=="null")throw new InvalidDataException("ZIP reopen target obstructed: "+selector);
            using var p=JsonDocument.Parse(raw);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x=p.RootElement.GetProperty("x").GetDouble(),y=p.RootElement.GetProperty("y").GetDouble(),button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
        }
        for(var n=0;n<3;n++)
        {
            await Wait("document.querySelectorAll('[data-claude-row]').length>0");
            await Click("[data-claude-return]");
            await Wait("document.querySelector('[data-archiver-claude-view]').hidden&&!!document.querySelector('[data-source-claude]')");
            var elapsed=Stopwatch.StartNew();
            // Pointer movement enters the source row, reproducing hover+open.
            await Click("[data-source-claude]");
            await Wait("!document.querySelector('[data-archiver-claude-view]').hidden&&document.querySelectorAll('[data-claude-row]').length>0");
            times.Add(elapsed.ElapsedMilliseconds);
            var after = SHA256.HashData(await File.ReadAllBytesAsync(indexFile));
            if(!before.AsSpan().SequenceEqual(after))throw new InvalidDataException("Unchanged ZIP was reindexed while reopening.");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".reopen.json"),JsonSerializer.Serialize(new{reopen_ms=times,index_bytes_unchanged=true}));
        TraceVisualAudit("container-reopen-pointer-passed",JsonSerializer.Serialize(times));
    }
}
