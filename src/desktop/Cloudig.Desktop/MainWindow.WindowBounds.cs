using System.Runtime.InteropServices;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    // A borderless WPF caption must still maximize to this monitor's work area,
    // not its complete screen. Coordinates here are native physical pixels.
    private void AttachWindowBounds(object? sender, EventArgs args)
    {
        var source = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        source?.AddHook(WindowBoundsHook);
    }

    private IntPtr WindowBoundsHook(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != 0x0024) return IntPtr.Zero; // WM_GETMINMAXINFO
        var monitor = MonitorFromWindow(window, 2); // MONITOR_DEFAULTTONEAREST
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return IntPtr.Zero;
        var limits = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        limits.MaxPosition = new NativePoint { X = info.Work.Left - info.Monitor.Left, Y = info.Work.Top - info.Monitor.Top };
        limits.MaxSize = new NativePoint { X = info.Work.Right - info.Work.Left, Y = info.Work.Bottom - info.Work.Top };
        // Handling this message also bypasses WPF's normal MinWidth/MinHeight
        // propagation. Windows tracks the dragged border in physical pixels,
        // whereas the existing XAML minimum is in logical DIPs.
        var dpi = GetDpiForWindow(window);
        var scale = (dpi == 0 ? 96 : dpi) / 96d;
        limits.MinTrackSize = new NativePoint { X = (int)Math.Ceiling(MinWidth * scale), Y = (int)Math.Ceiling(MinHeight * scale) };
        Marshal.StructureToPtr(limits, lParam, false);
        handled = true;
        return IntPtr.Zero;
    }

    // Query the real HWND message route, not just the WPF properties: checking
    // MinWidth alone missed the swallowed tracking limits in the original hook.
    private void VerifyNativeWindowBounds(VisualAuditOptions audit)
    {
        var window = new WindowInteropHelper(this).Handle;
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf<MinMaxInfo>());
        try
        {
            Marshal.StructureToPtr(new MinMaxInfo(), memory, false);
            SendWindowBoundsMessage(window, 0x0024, IntPtr.Zero, memory);
            var actual = Marshal.PtrToStructure<MinMaxInfo>(memory);
            var dpi = VisualTreeHelper.GetDpi(this);
            var monitor = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) throw new InvalidDataException("Window bounds audit cannot read the monitor work area");
            var expectedWidth = (int)Math.Ceiling(MinWidth * dpi.DpiScaleX);
            var expectedHeight = (int)Math.Ceiling(MinHeight * dpi.DpiScaleY);
            var minimumPass = actual.MinTrackSize.X == expectedWidth && actual.MinTrackSize.Y == expectedHeight;
            var maximizePass = actual.MaxPosition.X == monitor.Work.Left - monitor.Monitor.Left && actual.MaxPosition.Y == monitor.Work.Top - monitor.Monitor.Top
                && actual.MaxSize.X == monitor.Work.Right - monitor.Work.Left && actual.MaxSize.Y == monitor.Work.Bottom - monitor.Work.Top;
            File.WriteAllText(Path.ChangeExtension(audit.OutputFile, "window-bounds.json"), JsonSerializer.Serialize(new {
                minimum_dip = new { width=MinWidth, height=MinHeight }, dpi_x=dpi.PixelsPerInchX, dpi_y=dpi.PixelsPerInchY,
                native_minimum_px = new { width=actual.MinTrackSize.X, height=actual.MinTrackSize.Y },
                native_maximum_px = new { width=actual.MaxSize.X, height=actual.MaxSize.Y },
                minimum_pass=minimumPass, maximize_work_area_pass=maximizePass
            }, new JsonSerializerOptions { WriteIndented=true }) + "\n");
            if (!minimumPass || !maximizePass) throw new InvalidDataException("Native window sizing lost the minimum or taskbar work-area bounds");
            TraceVisualAudit("native-window-minimum-and-work-area-passed");
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo { public NativePoint Reserved; public NativePoint MaxSize; public NativePoint MaxPosition; public NativePoint MinTrackSize; public NativePoint MaxTrackSize; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public NativeRect Monitor; public NativeRect Work; public uint Flags; }
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern IntPtr SendWindowBoundsMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
}
