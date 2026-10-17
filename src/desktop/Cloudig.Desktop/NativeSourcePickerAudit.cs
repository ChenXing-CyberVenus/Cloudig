using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Cloudig.Desktop;

// Only called by the explicit visual-audit source-picker scenario. Observe the
// real Windows dialog belonging to this test window; never touch other apps.
internal static class NativeSourcePickerAudit
{
    internal static Task<string> ObserveAndCancelAsync(nint owner, string expectedTitle) => Task.Run(async () =>
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(20))
        {
            nint found = 0;
            EnumWindows((window, _) =>
            {
                GetWindowThreadProcessId(window, out var process);
                if (process != Environment.ProcessId || GetWindow(window, 4) != owner || !IsWindowVisible(window)) return true;
                var title = new StringBuilder(512); var kind = new StringBuilder(128);
                GetWindowText(window, title, title.Capacity); GetClassName(window, kind, kind.Capacity);
                if (kind.ToString() != "#32770" || title.ToString() != expectedTitle) return true;
                found = window; return false;
            }, 0);
            if (found != 0)
            {
                // IDCANCEL is scoped to the proven owned dialog, without moving
                // the user's mouse or sending keyboard input to the desktop.
                if (!PostMessage(found, 0x0111, 2, 0)) throw new IOException("Could not cancel the owned test picker.");
                for (var attempt = 0; attempt < 100; attempt++)
                {
                    if (!IsWindowVisible(found)) return expectedTitle;
                    await Task.Delay(50);
                }
                throw new IOException("Owned native picker did not close after Cancel.");
            }
            await Task.Delay(50);
        }
        throw new IOException("Platform card never opened its native source picker.");
    });

    private delegate bool WindowCallback(nint window, nint state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, nint state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint window, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint window, StringBuilder text, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint window, StringBuilder text, int maximum);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] private static extern bool PostMessage(nint window, uint message, nint parameter, nint data);
}
