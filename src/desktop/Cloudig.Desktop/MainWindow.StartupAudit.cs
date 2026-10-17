using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // Explicit offscreen audit only. Hold the native phase for two samples so
    // a warm browser cannot finish before animation is observed. Normal startup
    // has no test delay and no screenshots or diagnostic files.
    private async Task VerifyNativeStartupAnimationAsync(VisualAuditOptions audit, long firstFrameMilliseconds)
    {
        byte[] Capture(string suffix)
        {
            if (StartupLoading.Visibility != Visibility.Visible || WebView.Visibility != Visibility.Hidden || StartupSun.Source is null)
                throw new InvalidDataException("The first native frame has no startup GIF.");
            var bitmap = new RenderTargetBitmap((int)Math.Ceiling(StartupLoading.ActualWidth), (int)Math.Ceiling(StartupLoading.ActualHeight), 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(StartupLoading);
            var png = new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(bitmap));
            using var output = new MemoryStream(); png.Save(output);
            var bytes = output.ToArray();
            Directory.CreateDirectory(Path.GetDirectoryName(audit.OutputFile)!);
            File.WriteAllBytes(Path.ChangeExtension(audit.OutputFile, suffix + ".png"), bytes);
            return SHA256.HashData(bytes);
        }
        var first = Capture(".native-loading-first");
        await Task.Delay(1050);
        var moving = Capture(".native-loading-moving");
        if (first.AsSpan().SequenceEqual(moving)) throw new InvalidDataException("The native startup GIF did not animate.");
        if (_startupSun?.FrameCount != 90 || _startupSun.DurationMilliseconds != 2700) throw new InvalidDataException("The native loading frames differ from the approved GIF.");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".startup.json"), JsonSerializer.Serialize(new {
            first_native_frame_ms = firstFrameMilliseconds, frames = _startupSun.FrameCount, loop_ms = _startupSun.DurationMilliseconds,
            native_animation_changed = true, native_before_browser = WebView.CoreWebView2 is null, audit_only_delay_ms = 1050,
            first_sha256 = Convert.ToHexString(first), moving_sha256 = Convert.ToHexString(moving) }));
        TraceVisualAudit("native-loading-motion-passed");
    }
}
