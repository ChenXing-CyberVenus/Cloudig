namespace Cloudig.Desktop.Core;

/// <summary>Window size is layout space, not a request to magnify text. Windows DPI still applies.</summary>
public static class ViewportScale
{
    public const double DesignWidth = 1920;
    public const double DesignHeight = 1080;

    public static double ForClient(double width, double height)
    {
        if (!double.IsFinite(width) || !double.IsFinite(height) || width <= 0 || height <= 0) return 1;
        // Do not apply monitor/window scaling a second time. CSS owns reflow
        // and each illustrated scene owns its SVG/art scale; body type stays
        // at its authored CSS size when the user maximizes/restores the window.
        return 1;
    }
}
