using System.IO;
using System.Text.Json;
using Cloudig.Desktop.Core;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // The opt-in test supplies only the native picker's answer. Preview,
    // confirmation, IPC, shutdown, helper and target startup stay production.
    private async Task VerifyLibraryMoveAuditAsync(VisualAuditOptions audit)
    {
        if (audit.MoveTarget is null || _libraryRoot is null) throw new InvalidDataException("Move audit roots are missing.");
        async Task WaitAsync(string expression)
        {
            for (var attempt = 0; attempt < 300; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({expression})") == "true") return;
                await Task.Delay(50);
            }
            throw new IOException("Move audit did not reach the expected UI state: " + expression);
        }
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") throw new IOException("Move audit control is absent or covered: " + selector);
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new
                {
                    type, x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble(),
                    button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1
                }));
        }
        const string entry = "[data-archiver-shell-action='change-library']";
        const string confirm = ".cloudig-dialog:not(.cloudig-library-move-progress) footer .cloudig-button-filled";
        const string cancel = ".cloudig-dialog:not(.cloudig-library-move-progress) footer .cloudig-button-outline";
        for (var pass = 0; pass < 2; pass++)
        {
            await ClickAsync(entry);
            await WaitAsync($"document.querySelector({JsonSerializer.Serialize(confirm)})");
            var shown = await WebView.CoreWebView2.ExecuteScriptAsync("[...document.querySelectorAll('.cloudig-dialog dd')].map(n=>n.textContent)");
            using var paths = JsonDocument.Parse(shown);
            if (paths.RootElement[0].GetString() != _libraryRoot || paths.RootElement[1].GetString() != audit.MoveTarget)
                throw new IOException("The move confirmation did not show the actual source and target.");
            if (PortableLibraryMove.IsPending(_libraryRoot) || Directory.EnumerateFileSystemEntries(audit.MoveTarget).Any())
                throw new IOException("Preview wrote a move request or target files before confirmation.");
            if (pass == 0)
            {
                if (audit.Query.Contains("guide-preview=1", StringComparison.Ordinal))
                    await CaptureFeatureGuideRegionAsync(audit, "12-move-library", ".cloudig-dialog");
                await ClickAsync(cancel); await WaitAsync("!document.querySelector('.cloudig-dialog-layer')");
                if (PortableLibraryMove.IsPending(_libraryRoot)) throw new IOException("Cancelled preview created a move request.");
                TraceVisualAudit("library-move-preview-cancel-passed");
                if (audit.Query.Contains("guide-preview=1", StringComparison.Ordinal))
                {
                    TraceVisualAudit("feature-guide-move-preview-only");
                    await ShutdownResourcesAsync(); _closeAllowed = true; Close(); return;
                }
            }
        }
        await using (var capture = File.Create(Path.ChangeExtension(audit.OutputFile, ".confirmation.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, capture);
        TraceVisualAudit("library-move-confirm-click");
        await ClickAsync(confirm);
        for (var attempt = 0; attempt < 200 && !_closing; attempt++) await Task.Delay(25);
        if (!_closing) throw new IOException("The real move command did not start the host shutdown.");
    }
}
