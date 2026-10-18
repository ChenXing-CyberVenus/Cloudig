using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;
public partial class MainWindow
{
    private async Task VerifyExitConfirmationAsync(VisualAuditOptions audit)
    {
        // Real native modal, hit testing and accessibility invocation. Offscreen
        // WPF cannot receive desktop mouse input without moving the user's cursor.
        var results=new List<object>();
        _surfaceLanguage=audit.Query.Contains("language=en",StringComparison.Ordinal)?"en":"zh-CN";
        foreach(var accept in new[]{false,true})
        {
            var dialog=new ExitConfirmation(this,_surfaceTheme=="star-night",_surfaceLanguage=="en",true);
            Exception? failure=null;
            dialog.Loaded+=async(_,_)=>{
                try{
                    await Dispatcher.Yield(DispatcherPriority.Render);
                    var target=accept?dialog.CloseAction:dialog.CancelAction;
                    if(dialog.Owner!=this||dialog.ShowActivated||dialog.ShowInTaskbar)throw new InvalidDataException("Exit dialog owner/activation mismatch");
                    var point=target.TranslatePoint(new Point(target.ActualWidth/2,target.ActualHeight/2),dialog);
                    var hit=dialog.InputHitTest(point) as DependencyObject;
                    while(hit is not null&&hit!=target)hit=VisualTreeHelper.GetParent(hit);
                    if(hit!=target)throw new InvalidDataException("Exit action has no native hit target");
                    var dpi=VisualTreeHelper.GetDpi(dialog);var bitmap=new RenderTargetBitmap((int)Math.Ceiling(dialog.ActualWidth*dpi.DpiScaleX),(int)Math.Ceiling(dialog.ActualHeight*dpi.DpiScaleY),dpi.PixelsPerInchX,dpi.PixelsPerInchY,PixelFormats.Pbgra32);bitmap.Render(dialog);
                    var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using(var output=File.Create(Path.ChangeExtension(audit.OutputFile,accept?".exit-confirm.png":".exit-cancel.png")))encoder.Save(output);
                    ((IInvokeProvider)new ButtonAutomationPeer(target).GetPattern(PatternInterface.Invoke)).Invoke();
                    await Task.Delay(100);
                    if(dialog.IsVisible)throw new InvalidDataException("Native exit button did not close its modal");
                    results.Add(new{accept,night=_surfaceTheme=="star-night",language=_surfaceLanguage,native_hit=true,native_accessibility_invoke=true,width=bitmap.PixelWidth,height=bitmap.PixelHeight});
                }catch(Exception error){failure=error;dialog.Close();}
            };
            var answer=dialog.ShowDialog();
            await Task.Delay(160);
            if(failure is not null)throw failure;
            if(answer!=accept)throw new InvalidDataException("Exit dialog returned the wrong decision");
            if(_closing||_closeAllowed||_resourcesClosed)throw new InvalidDataException("Dialog-only acceptance shut down the audit owner");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".exit-confirmation.json"),JsonSerializer.Serialize(results));
        TraceVisualAudit("exit-confirmation-passed","native modal; same theme/language; hit test and accessibility Invoke; cancel and confirm; owner preserved for audit");
    }
}
