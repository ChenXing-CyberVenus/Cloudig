using System.Diagnostics;

namespace Cloudig.Desktop.Core;

public static class ExternalBrowserLauncher
{
    public static bool TryOpen(string value) => TryOpen(value, start => { using var process = Process.Start(start); });

    internal static bool TryOpen(string value, Action<ProcessStartInfo> launch)
    {
        if (!BridgePolicy.IsExternalHttp(value)) return false;
        try
        {
            launch(new ProcessStartInfo(value) { UseShellExecute = true });
            return true;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
