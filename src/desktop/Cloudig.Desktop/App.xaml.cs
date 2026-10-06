using System.Windows;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Runtime.InteropServices;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

public partial class App : Application
{
    private LibraryInstance? _instance;
    private bool _activationRequested;
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int processId);

    private void ActivateExistingWindow()
    {
        _ = Dispatcher.BeginInvoke(new Action(() =>
        {
            _activationRequested = true;
            if (MainWindow is not { } window) return;
            if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
            window.Show(); window.Activate();
        }));
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instance?.Dispose();
        base.OnExit(e);
    }

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        AppLayout? layout = null;
        try
        {
            var arguments = e.Args.AsEnumerable();
            if (Environment.GetEnvironmentVariable("CLOUDIG_TEST_RESTART_AUDIT") is { } restartAudit)
            {
                Environment.SetEnvironmentVariable("CLOUDIG_TEST_RESTART_AUDIT", null);
                var extra = JsonSerializer.Deserialize<string[]>(restartAudit) ?? throw new ArgumentException("Invalid restart audit.");
                if (extra.Length != 8 || extra[0] != "--visual-audit-output" || extra[2] != "--visual-audit-query" || extra[4] != "--visual-audit-width" || extra[6] != "--visual-audit-height")
                    throw new ArgumentException("Restart audit may only configure its offscreen capture.");
                arguments = arguments.Concat(extra);
            }
            layout = AppLayout.Discover(arguments.ToArray());
            _instance = await LibraryInstance.AcquireOrActivateAsync(layout.LibraryRoot!, ActivateExistingWindow,
                processId => AllowSetForegroundWindow(processId));
            if (_instance is null) { Shutdown(0); return; }
            ShutdownMode = ShutdownMode.OnMainWindowClose;
            MainWindow = new MainWindow(layout, () => PrepareStorageAsync(layout, e.Args));
            MainWindow.Show();
            if (_activationRequested) ActivateExistingWindow();
        }
        catch (CloudigStorageException error)
        {
            ReportStartupFailure(layout, error.Message, "采云 Cloudig · 目录不可用");
            Shutdown(1);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or System.ComponentModel.Win32Exception)
        {
            ReportStartupFailure(layout, "采云未能完成启动。请保留当前文件夹与搬迁记录，不要删除原件；重新打开后可继续处理。\n\n" + error.Message, "采云 Cloudig · 操作未完成");
            Shutdown(1);
        }
    }

    // Called only after MainWindow paints the native sun. No Engine or WebView
    // is started until permissions and any unfinished move are resolved.
    private static async Task<bool> PrepareStorageAsync(AppLayout layout, string[] arguments)
    {
        await Task.Run(() => PortableStorageBoundary.Verify(layout.LibraryRoot!));
        var english = await Task.Run(() => IsEnglish(layout.LibraryRoot!));
        var completing = arguments.Length > 0 && arguments[0] == "--complete-library-move";
        if (completing && arguments.Length != 3) throw new InvalidDataException("Move completion expects its operation and frozen request hash.");
        var move = await PortableMoveStartup.ResolveAsync(layout.LibraryRoot!, prompt =>
        {
            if (layout.VisualAudit is not null) return Task.FromResult(PortableMoveChoice.Defer);
            var text = english
                ? $"A whole-folder move is unfinished.\n\nFrom: {prompt.Request.SourceRoot}\nTo: {prompt.Request.TargetRoot}\n\nYes: verify and continue.\n" + (prompt.CanCancel ? "No: stay here; keep any target copies.\nCancel: exit without changing files." : "No: exit without changing files.")
                : $"整体搬迁尚未完成。\n\n原位置：{prompt.Request.SourceRoot}\n目标：{prompt.Request.TargetRoot}\n\n是：重新核验并继续。\n" + (prompt.CanCancel ? "否：留在原位置，保留目标已复制文件。\n取消：暂缓，退出而不改文件。" : "否：暂缓，退出而不改文件。");
            if (prompt.PreviousResult?.Message is { Length: > 0 } reason) text += "\n\n" + reason;
            var choice = MessageBox.Show(text, "采云 Cloudig", prompt.CanCancel ? MessageBoxButton.YesNoCancel : MessageBoxButton.YesNo, MessageBoxImage.Question, prompt.CanCancel ? MessageBoxResult.Cancel : MessageBoxResult.No);
            return Task.FromResult(choice == MessageBoxResult.Yes ? PortableMoveChoice.Continue : choice == MessageBoxResult.No && prompt.CanCancel ? PortableMoveChoice.Cancel : PortableMoveChoice.Defer);
        }, prepared => { using var helper = Process.Start(PortableLibraryMove.HelperStartInfo(prepared)) ?? throw new IOException("The post-exit move helper could not start."); },
            completing ? arguments[1] : null, completing ? arguments[2] : null);
        if (!move.OpenLibrary) { if (layout.VisualAudit is not null) throw new IOException("The move audit stopped at an unresolved startup choice; no dialog was opened."); return false; }
        if (move.Result?.Status == "source_retained" && layout.VisualAudit is not null) throw new IOException("The move audit retained source files: " + move.Result.Message);
        if (move.Result?.Status == "source_retained") MessageBox.Show((english ? "Cloudig is ready at the new location. Some original files were preserved; do not delete them without checking:\n" : "新位置已可用，但部分原文件仍保留，请核对后再处理：\n") + move.Result.Source + "\n\n" + move.Result.Message, "采云 Cloudig", MessageBoxButton.OK, MessageBoxImage.Warning);
        await Task.Run(() => PortableStorageBoundary.Verify(new[] { layout.DeviceRoot, layout.CacheRoot, layout.WebViewUserDataRoot }));
        return true;
    }

    private static void ReportStartupFailure(AppLayout? layout, string message, string title)
    {
        if (layout?.VisualAudit is { } audit) { Directory.CreateDirectory(Path.GetDirectoryName(audit.OutputFile)!); File.WriteAllText(Path.ChangeExtension(audit.OutputFile, ".error.txt"), message); }
        else MessageBox.Show(message, title, MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private static bool IsEnglish(string root)
    {
        try { using var value = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "CloudigLibrary.json"))); return value.RootElement.GetProperty("settings").GetProperty("language").GetString() == "en"; }
        catch (Exception error) when (error is IOException or JsonException or KeyNotFoundException or InvalidOperationException) { return false; }
    }
}
