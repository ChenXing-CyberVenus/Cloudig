namespace Cloudig.Desktop.Core;

/// <summary>One design-to-view scale. Inputs are WebView client DIPs, already adjusted for Windows DPI.</summary>
public static class ViewportScale
{
    public const double DesignWidth = 1920;
    public const double DesignHeight = 1080;

    public static double ForClient(double width, double height)
    {
        if (!double.IsFinite(width) || !double.IsFinite(height) || width <= 0 || height <= 0) return 1;
        // Smaller windows keep the existing responsive reflow. Larger ones
        // scale the complete WebView, including SVG, type, strokes and hit tests.
        return Math.Max(1, Math.Min(width / DesignWidth, height / DesignHeight));
    }
}
