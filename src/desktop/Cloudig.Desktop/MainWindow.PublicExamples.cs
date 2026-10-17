using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private static string? FindExampleChrome()
    {
        var paths = new List<string?>();
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var root = RegistryKey.OpenBaseKey(hive, view);
            using var key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe");
            paths.Add(key?.GetValue(null) as string);
        }
        paths.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"));
        paths.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"));
        paths.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"));
        return paths.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!.Trim('"')).FirstOrDefault(p => Path.IsPathFullyQualified(p) && Path.GetFileName(p).Equals("chrome.exe", StringComparison.OrdinalIgnoreCase) && File.Exists(p));
    }

    private async Task OpenPublicExampleAsync(WebBridgeRequest request)
    {
        try
        {
            ExactProperties(request.Payload, "example");
            if (_engine is null) throw new InvalidOperationException("Engine unavailable");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var resolved = await _engine.SendAsync("reader.example.original", request.Payload, timeout.Token);
            var target = Path.GetFullPath(resolved.GetProperty("path").GetString()!);
            var expectedParent = Path.GetFullPath(Path.Combine(_layout.BaseDirectory, "docs", "examples", "html"));
            if (!Path.GetDirectoryName(target)!.Equals(expectedParent, StringComparison.OrdinalIgnoreCase) || !target.EndsWith(".html", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Example path escaped package");
            var chrome = FindExampleChrome();
            if (chrome is null)
            {
                PostError(request, "CLOUDIG_EXAMPLE_CHROME_MISSING", "未找到Chrome。请安装Chrome后重试；原HTML不会在采云内打开。 / Chrome was not found. Install Chrome to open the original HTML externally.");
                return;
            }
            var start = new ProcessStartInfo(chrome) { UseShellExecute = false };
            start.ArgumentList.Add(new Uri(target).AbsoluteUri);
            if (_layout.VisualAudit is null) { using var process = Process.Start(start); if (process is null) throw new InvalidOperationException("Chrome did not start"); }
            // Offscreen product audits validate the exact launch plan without opening windows on the user's desktop.
            PostResponse(request, true, BookmarkJson(new { opened = _layout.VisualAudit is null, launch_verified = true, browser = "Chrome" }));
        }
        catch
        {
            PostError(request, "CLOUDIG_EXAMPLE_OPEN_FAILED", "范例未能打开，请检查随包范例是否完整后重试。 / Could not open the example. Check that the bundled example files are intact and retry.");
        }
    }
}
