using System.Text.Json;

namespace Cloudig.Desktop.Core;

public enum RecordRecoveryChoice { Complete, Rollback, Cancel }
public sealed class CloudigLibraryStartupException(string message) : IOException(message);

public static class RecordStartupBoundary
{
    public static async Task<JsonElement> InitializeAsync(
        Func<string, JsonElement, CancellationToken, Task<JsonElement>> send,
        Func<string, Task<RecordRecoveryChoice>> choose,
        CancellationToken cancellationToken = default,
        Func<Task<bool>>? confirmRestoreSettings = null)
    {
        var empty = JsonSerializer.SerializeToElement(new { });
        var state = await send("library.startup.recover", empty, cancellationToken);
        var handled = new HashSet<string>(StringComparer.Ordinal);
        var initialized = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var status = state.TryGetProperty("status", out var value) ? value.GetString() : null;
            if (status == "valid") return state;
            if (status == "missing" && !initialized)
            {
                await send("library.create", empty, cancellationToken);
                initialized = true;
                state = await send("library.startup.recover", empty, cancellationToken);
                continue;
            }
            if (status == "settings_recovery" && !initialized)
            {
                if (confirmRestoreSettings is null || !await confirmRestoreSettings()) throw new CloudigLibraryStartupException("默认设置尚未恢复，已有头像、时间、标记与会话均已保留。可重新打开后确认恢复。 / Existing records were preserved; default settings were not restored.");
                initialized = true;
                try { await send("library.settings.recover", empty, cancellationToken); }
                catch (Exception error) when (error is IOException or EngineRemoteException) { throw new CloudigLibraryStartupException("设置恢复尚未完成。已有档案与恢复材料均已保留，请重新打开处理。\n\n" + error.Message); }
                state = await send("library.startup.recover", empty, cancellationToken);
                continue;
            }
            if (status == "transaction_recovery" && state.TryGetProperty("operations", out var operations) && operations.ValueKind == JsonValueKind.Array && operations.GetArrayLength() > 0)
            {
                foreach (var item in operations.EnumerateArray())
                {
                    var operation = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
                    if (operation is null || !Guid.TryParse(operation, out _) || !handled.Add(operation)) throw new CloudigLibraryStartupException("采云未能完成这次恢复。原文件与恢复材料已保留，请勿删除它们。");
                    var choice = await choose(operation);
                    if (choice == RecordRecoveryChoice.Cancel) throw new CloudigLibraryStartupException("已暂缓恢复。采云没有继续读写资料库，原文件与未完成操作均已保留。关闭后可重新打开处理。");
                    await send("library.recovery.commit", JsonSerializer.SerializeToElement(new { operation, action = choice == RecordRecoveryChoice.Complete ? "complete" : "rollback" }), cancellationToken);
                }
                state = await send("library.startup.recover", empty, cancellationToken);
                continue;
            }
            if (status == "unsupported" && state.TryGetProperty("reason", out var reason) && reason.GetString() == "schema_update_required")
                throw new CloudigLibraryStartupException("此资料库的数据标准不受当前采云支持，请更新采云或使用支持该标准的版本。原文件已保留，未初始化或覆盖。 / Unsupported data standard. Please update Cloudig; original files were preserved.");
            if (status == "unsupported") throw new CloudigLibraryStartupException("此目录是旧开发格式，或现有资料不符合当前采云标准。原文件已保留；本版不会自动迁移或覆盖，请核对所选目录与文件格式。");
            if (status == "unsafe") throw new CloudigLibraryStartupException("采云目录不完整或路径不安全。已有身份、时间、标记及会话均未改写；请保留原件，先修复目录或恢复设置文件。");
            throw new CloudigLibraryStartupException("采云资料库尚未准备好。原文件保持不变，请检查程序与资料目录。");
        }
    }
}
