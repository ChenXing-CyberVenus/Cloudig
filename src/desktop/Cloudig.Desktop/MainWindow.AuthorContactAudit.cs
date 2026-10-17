using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task VerifyAuthorContactAsync()
    {
        foreach(var expected in new[]{"https://zhuanlan.zhihu.com/p/2085630488027330496","https://github.com/ChenXing-CyberVenus/Cloudig/issues"})
        {
        var selector=$"a.cloudig-contact-link[href='{expected}']";
        var original=WebView.Source;
        var requested=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Capture(object? sender,CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled=true;
            if(e.IsUserInitiated)requested.TrySetResult(e.Uri);
            else requested.TrySetException(new InvalidDataException("Author link was not user initiated"));
        }
        // Observe the actual native external-window request without launching
        // sixteen browser tabs or disturbing the user's current desktop.
        WebView.CoreWebView2.NewWindowRequested-=OnNewWindowRequested;
        WebView.CoreWebView2.NewWindowRequested+=Capture;
        try
        {
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const a=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=a?.getBoundingClientRect();if(!r||!r.width||!r.height)return null;const x=r.left+r.width/2,y=r.top+r.height/2,s=getComputedStyle(a),p=getComputedStyle(a.parentElement);return a.contains(document.elementFromPoint(x,y))&&s.color===p.color&&s.fontSize===p.fontSize?{x,y}:null})()
                """);
            if(raw=="null")throw new InvalidDataException("Author link is covered or changed the footer typography");
            using var point=JsonDocument.Parse(raw);var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
            if(await requested.Task.WaitAsync(TimeSpan.FromSeconds(5))!=expected)throw new InvalidDataException("Author link requested the wrong article");
            if(WebView.Source!=original)throw new InvalidDataException("Author link navigated the application WebView");
            var keyboard=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);requested=keyboard;
            await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(selector)}).focus()");
            foreach(var type in new[]{"keyDown","keyUp"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent",JsonSerializer.Serialize(new{type,key="Enter",code="Enter",windowsVirtualKeyCode=13}));
            if(await keyboard.Task.WaitAsync(TimeSpan.FromSeconds(5))!=expected)throw new InvalidDataException("Keyboard author link requested the wrong article");
            await WebView.CoreWebView2.ExecuteScriptAsync("document.activeElement.blur()");
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent","{\"type\":\"mouseMoved\",\"x\":1,\"y\":1}");
            TraceVisualAudit("author-contact-native-external-passed",expected+";pointer-and-keyboard;browser-launch-suppressed");
        }
        finally
        {
            WebView.CoreWebView2.NewWindowRequested-=Capture;
            WebView.CoreWebView2.NewWindowRequested+=OnNewWindowRequested;
        }
        }
    }
}
