using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using Cloudig.Desktop.Core;

namespace Cloudig.Desktop;

public partial class MainWindow
{
    private bool _startupUpdateChecked;
    private PreparedUpdate? _preparedUpdate;
    private static string? ProductVersion => typeof(MainWindow).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
    private async Task<JsonElement> QueryUpdateAsync(bool startup, CancellationToken token) {
        if (startup && _startupUpdateChecked) return Json("{\"status\":\"already_checked\"}");
        if (startup) _startupUpdateChecked = true;
        var result = await _releaseUpdates.CheckAsync(ProductVersion, token);
        return JsonSerializer.SerializeToElement(new { status = result.Status, current_version = result.CurrentVersion, latest_version = result.LatestVersion, can_install = result.Installer is not null });
    }
    private async Task<JsonElement> PrepareUpdateAsync(WebBridgeRequest request, CancellationToken token) {
        ExactProperties(request.Payload);
        if (_webRequests.Count != 1 || _pickerTokens.Count != 0) throw new IOException("请先完成正在进行的操作，再更新。 / Finish the active operation before updating.");
        if (_preparedUpdate is not null) { PortableUpdateClient.Discard(_preparedUpdate); _preparedUpdate = null; }
        var result = await _releaseUpdates.CheckAsync(ProductVersion, token);
        if (result.Status != "available" || result.Installer is null) throw new IOException("暂时没有可自动安装的新版，请重试或查看发布页。 / No verified installer is available; retry or check the releases page.");
        var prepared = await Task.Run(() => new PortableUpdateClient().PrepareAsync(result.Installer, _layout.BaseDirectory, _libraryRoot!,
            progress => Dispatcher.BeginInvoke(() => PostEvent(request, JsonSerializer.SerializeToElement(new { phase = "downloading", bytes = progress.Bytes, total = progress.Total }))), token), token);
        if (token.IsCancellationRequested || _resourcesClosed) { PortableUpdateClient.Discard(prepared); throw new OperationCanceledException(token); }
        _preparedUpdate = prepared;
        return JsonSerializer.SerializeToElement(new { capability = _preparedUpdate.Capability, version = _preparedUpdate.Version });
    }
    private JsonElement ScheduleUpdate(JsonElement payload) {
        ExactProperties(payload, "capability");
        if (_preparedUpdate is null || RequiredString(payload, "capability") != _preparedUpdate.Capability || _webRequests.Count != 1 || _pickerTokens.Count != 0 || _closing) throw new IOException("更新请求已失效，或另一个操作尚未完成。 / The update expired or another operation is still active.");
        var prepared = _preparedUpdate;
        using var helper = Process.Start(PortableUpdateClient.HelperStartInfo(prepared)) ?? throw new IOException("The update helper could not start.");
        _preparedUpdate = null;
        // Reply before disposing the bridge. The helper validates the frozen
        // installer, waits for this exact owner to exit, then installs/restarts.
        _ = Dispatcher.BeginInvoke(async () => {
            _closing = true; Hide(); await _startupFinished.Task;
            try { await ShutdownResourcesAsync(); }
            catch (Exception error) { TraceVisualAudit("update-shutdown-error", error.Message); }
            finally { _closeAllowed = true; Close(); }
        });
        return Json("{\"installing\":true}");
    }
}
