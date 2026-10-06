namespace Cloudig.Desktop.Core;

public readonly record struct WindowSurfaceColor(byte Red, byte Green, byte Blue);

public readonly record struct WindowSurfaceStop(WindowSurfaceColor Color, double Offset);

public sealed record WindowSurfaceStyle(
    IReadOnlyList<WindowSurfaceStop> Stops,
    WindowSurfaceColor Foreground,
    WindowSurfaceColor Border,
    WindowSurfaceColor WebFallback,
    bool LightCaptionControls);

public static class WindowSurfaceStyles
{
    private static readonly WindowSurfaceColor White = new(255, 255, 255);
    private static readonly WindowSurfaceColor DarkText = new(45, 45, 45);
    private static readonly WindowSurfaceColor LightText = new(226, 225, 225);

    public static WindowSurfaceStyle Resolve(string theme, string page) => (theme, page) switch
    {
        ("dawn", "welcome") => Style(
            [Stop(White, 0), Stop(210, 210, 210, .5), Stop(White, 1)],
            DarkText, Color(210, 210, 210), White, true),
        ("star-night", "welcome") => Style(
            [Stop(0, 0, 0, 0), Stop(17, 17, 17, .5), Stop(0, 0, 0, 1)],
            LightText, Color(30, 30, 30), Color(0, 0, 0), false),
        ("dawn", "reader") => Style(
            [Stop(224, 201, 173, 0), Stop(234, 216, 195, 1)],
            DarkText, Color(183, 136, 98), Color(224, 201, 173), true),
        ("star-night", "reader") => DarkWorkSurface(),
        ("dawn", "archiver") => Style(
            [Stop(132, 32, 30, 0), Stop(249, 202, 130, .34), Stop(174, 139, 127, .68), Stop(75, 127, 130, 1)],
            Color(253, 252, 237), Color(132, 32, 30), Color(249, 202, 130), false),
        ("star-night", "archiver") => DarkWorkSurface(),
        _ => throw new ArgumentOutOfRangeException(nameof(page), "Window surface theme or page is invalid.")
    };

    private static WindowSurfaceStyle DarkWorkSurface() => Style(
        [Stop(59, 56, 60, 0), Stop(73, 73, 78, 1)],
        LightText, Color(40, 40, 40), Color(59, 56, 60), false);

    private static WindowSurfaceStyle Style(
        IReadOnlyList<WindowSurfaceStop> stops,
        WindowSurfaceColor foreground,
        WindowSurfaceColor border,
        WindowSurfaceColor fallback,
        bool lightCaptionControls) => new(stops, foreground, border, fallback, lightCaptionControls);

    private static WindowSurfaceStop Stop(byte red, byte green, byte blue, double offset) => new(Color(red, green, blue), offset);

    private static WindowSurfaceStop Stop(WindowSurfaceColor color, double offset) => new(color, offset);

    private static WindowSurfaceColor Color(byte red, byte green, byte blue) => new(red, green, blue);
}
