using System.IO;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

internal sealed record AppLayout(
    string BaseDirectory,
    string WebRoot,
    string NodeExecutable,
    string EngineScript,
    string BookmarkManifest,
    string BookmarkArtifactRoot,
    string BookmarkChangelog,
    string BookmarkBackupRoot,
    string BookmarkSettingsFile,
    string DeviceRoot,
    string CacheRoot,
    string WebViewUserDataRoot,
    bool LibraryArgumentExplicit,
    string? LibraryRoot,
    VisualAuditOptions? VisualAudit)
{
    internal static AppLayout Discover(IReadOnlyList<string> arguments)
    {
        var program = CloudigProgramLayout.Resolve(Environment.ProcessPath ?? throw new InvalidOperationException("Cloudig executable path is unavailable."), AppContext.BaseDirectory);
        var root = program.Root;
        string? dataRootArgument = null;
        string? libraryArgument = null;
        string? auditOutput = null;
        string? auditQuery = null;
        string? auditMoveTarget = null;
        var auditWidth = 1920;
        var auditHeight = 1080;
        for (var index = 0; index < arguments.Count; index++)
        {
            var argument = arguments[index];
            if (argument is not ("--data-root" or "--library-root" or "--visual-audit-output" or "--visual-audit-query" or "--visual-audit-width" or "--visual-audit-height" or "--visual-audit-move-target")) continue;
            if (++index >= arguments.Count) throw new ArgumentException($"Missing value for {argument}.");
            var value = arguments[index];
            if (argument == "--data-root") dataRootArgument = value;
            else if (argument == "--library-root") libraryArgument = value;
            else if (argument == "--visual-audit-output") auditOutput = value;
            else if (argument == "--visual-audit-query") auditQuery = value;
            else if (argument == "--visual-audit-move-target") auditMoveTarget = Path.GetFullPath(value);
            else if (argument == "--visual-audit-width" && !int.TryParse(value, out auditWidth)) throw new ArgumentException("Visual audit width is invalid.");
            else if (argument == "--visual-audit-height" && !int.TryParse(value, out auditHeight)) throw new ArgumentException("Visual audit height is invalid.");
        }
        VisualAuditOptions? visualAudit = null;
        if (auditOutput is not null)
        {
            if (auditWidth is < 1280 or > 7680 || auditHeight is < 720 or > 4320) throw new ArgumentOutOfRangeException(nameof(arguments), "Visual audit viewport is outside the capture bounds.");
            var output = Path.GetFullPath(auditOutput);
            if (!Path.GetExtension(output).Equals(".png", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Visual audit output must be a PNG file.");
            var query = string.IsNullOrWhiteSpace(auditQuery) ? "?screenshot=1&fixture=sample&route=welcome&theme=dawn&language=zh-CN&phase=start" : auditQuery.Trim();
            if (!query.StartsWith("?", StringComparison.Ordinal)) query = $"?{query}";
            if (query.Length > 2048 || !query.Contains("screenshot=1", StringComparison.Ordinal)) throw new ArgumentException("Visual audit query is invalid.");
            if (auditMoveTarget is not null && (!query.Contains("fixture=real", StringComparison.Ordinal) || !query.Contains("interaction=library-move", StringComparison.Ordinal)))
                throw new ArgumentException("A move audit needs the explicit real-Library move journey.");
            visualAudit = new VisualAuditOptions(output, query, auditWidth, auditHeight, auditMoveTarget);
        }
        else if (auditMoveTarget is not null) throw new ArgumentException("A move audit cannot run without an offscreen capture.");
        var dataRoots = CloudigDataRootPolicy.Resolve(root, dataRootArgument, libraryArgument, visualAudit?.OutputFile);
        var deviceRoot = dataRoots.DeviceRoot;
        var webViewUserDataRoot = Path.Combine(dataRoots.CacheRoot, "WebView2");
        return new AppLayout(
            root,
            Path.Combine(program.App, "web"),
            Path.Combine(program.App, "runtime", "node", "node.exe"),
            Path.Combine(program.App, "engine", "engine.mjs"),
            Path.Combine(root, "bookmarks", "bookmark-package.json"),
            Path.Combine(root, "bookmarks", "artifacts"),
            Path.Combine(root, "bookmarks", "BOOKMARKLET_CHANGELOG.md"),
            Path.Combine(deviceRoot, "BookmarkBackups"),
            Path.Combine(deviceRoot, "cloudig-device.json"),
            deviceRoot,
            dataRoots.CacheRoot,
            webViewUserDataRoot,
            dataRoots.LibraryArgumentExplicit,
            dataRoots.LibraryRoot,
            visualAudit);
    }
}

internal sealed record VisualAuditOptions(string OutputFile, string Query, int Width, int Height, string? MoveTarget = null);
