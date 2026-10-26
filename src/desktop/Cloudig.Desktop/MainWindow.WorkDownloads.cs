using System.IO;
using System.Windows;
using System.Windows.Threading;
using Cloudig.Desktop.Core;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private bool _workSavePickerOpen;
    private readonly HashSet<CoreWebView2DownloadOperation> _workDownloads = new();
    private readonly List<string> _workDownloadAuditSaved = new();
    private bool _workDownloadAuditCancelNext;
    private int _workDownloadAuditCanceled;

    private async void OnWorkDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs args)
    {
        args.Cancel = true;
        args.Handled = true;
        if (_closing || _resourcesClosed || _workSavePickerOpen || !WorkDownloadPolicy.IsGenerated(args.DownloadOperation.Uri)) return;
        using var deferral = args.GetDeferral();
        _workSavePickerOpen = true;
        try
        {
            // The picker runs after the WebView event returns, as required by
            // WebView2's modal/reentrancy contract. No bytes traverse IPC.
            await System.Windows.Threading.Dispatcher.Yield(DispatcherPriority.Background);
            if (_closing || _resourcesClosed) return;
            var name = WorkDownloadPolicy.SuggestedName(args.ResultFilePath);
            string destination;
            if (_layout.VisualAudit is { } audit && audit.Query.Contains("work-downloads=1", StringComparison.Ordinal))
            {
                if (_workDownloadAuditCancelNext) { _workDownloadAuditCancelNext = false; _workDownloadAuditCanceled++; return; }
                var folder = Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "generated-files");
                Directory.CreateDirectory(folder); destination = Path.Combine(folder, name);
            }
            else
            {
                var dialog = new Microsoft.Win32.SaveFileDialog
                {
                    FileName = name, Title = _surfaceLanguage == "en" ? "Save generated file" : "保存作品生成的文件",
                    InitialDirectory = _libraryRoot is null ? "" : Path.Combine(_libraryRoot, "Exports"), OverwritePrompt = true
                };
                if (dialog.ShowDialog(this) != true) return;
                destination = dialog.FileName;
            }
            var operation = args.DownloadOperation;
            EventHandler<object>? changed = null;
            changed = (_, _) =>
            {
                if (operation.State == CoreWebView2DownloadState.InProgress) return;
                operation.StateChanged -= changed;
                _workDownloads.Remove(operation);
                if (operation.State == CoreWebView2DownloadState.Completed)
                {
                    if (_layout.VisualAudit is not null) _workDownloadAuditSaved.Add(destination);
                    TraceVisualAudit("work-download-complete", Path.GetFileName(destination));
                }
                else
                {
                    TraceVisualAudit("work-download-interrupted", operation.InterruptReason.ToString());
                    if (!_closing && !_resourcesClosed && _layout.VisualAudit is null && operation.InterruptReason != CoreWebView2DownloadInterruptReason.UserCanceled)
                        Dispatcher.BeginInvoke(new Action(() => {
                            if (!_closing && !_resourcesClosed) MessageBox.Show(this, _surfaceLanguage == "en" ? "The generated file could not be saved. Please retry or choose another folder." : "作品文件未能保存，请重试或选择其他文件夹。", "采云 Cloudig", MessageBoxButton.OK, MessageBoxImage.Warning);
                        }));
                }
            };
            operation.StateChanged += changed;
            _workDownloads.Add(operation);
            args.ResultFilePath = destination;
            args.Cancel = false;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            TraceVisualAudit("work-download-refused", error.Message);
            if (_layout.VisualAudit is null && !_closing && !_resourcesClosed)
                MessageBox.Show(this, _surfaceLanguage == "en" ? "Could not open the save dialog. Please retry." : "未能打开保存窗口，请重试。", "采云 Cloudig", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally { _workSavePickerOpen = false; }
    }

    private void CancelWorkDownloads()
    {
        foreach (var download in _workDownloads.ToArray()) download.Cancel();
        _workDownloads.Clear();
    }
}
