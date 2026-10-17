using System.IO;
using System.Text.Json;

namespace Cloudig.Desktop;

internal sealed record PendingLibraryMove(
    string PlanId,
    string SourceRoot,
    string TargetRoot,
    string Strategy,
    bool TargetExisted,
    string ManifestSha256,
    long TotalBytes,
    int TotalFiles,
    int TotalDirectories,
    string Phase);

internal sealed record BookmarkInstallSettings(
    string StorePath,
    string ParentGuid,
    string FolderName,
    bool PlaceFirst,
    string InstallationId,
    string ManagedFolderGuid,
    bool PlacementPending)
{
    public static BookmarkInstallSettings Default { get; } = new(
        string.Empty,
        string.Empty,
        "采云 Cloudig",
        true,
        string.Empty,
        string.Empty,
        false);
}

internal sealed class LocalSettings
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        WriteIndented = true
    };

    private readonly string _file;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public LocalSettings(string file)
    {
        _file = file;
    }

    public string LibraryRoot { get; private set; } = string.Empty;
    public PendingLibraryMove? PendingLibraryMove { get; private set; }
    public BookmarkInstallSettings BookmarkInstall { get; private set; } = BookmarkInstallSettings.Default;
    public int ThemeSwitchUsedVersion { get; private set; }

    public async Task LoadAsync()
    {
        if (!File.Exists(_file)) return;
        try
        {
            await using var stream = File.OpenRead(_file);
            var document = await JsonSerializer.DeserializeAsync<SettingsDocument>(stream, JsonOptions);
            LibraryRoot = string.IsNullOrWhiteSpace(document?.LibraryRoot)
                ? string.Empty
                : Path.GetFullPath(document.LibraryRoot);
            PendingLibraryMove = NormalizePendingMove(document?.PendingLibraryMove);
            BookmarkInstall = NormalizeBookmarkInstall(document?.BookmarkInstall);
            ThemeSwitchUsedVersion = NormalizeThemeSwitchUsedVersion(document?.ThemeSwitchUsedVersion ?? 0);
        }
        catch (Exception) when (!System.Diagnostics.Debugger.IsAttached)
        {
            LibraryRoot = string.Empty;
            PendingLibraryMove = null;
            BookmarkInstall = BookmarkInstallSettings.Default;
            ThemeSwitchUsedVersion = 0;
        }
    }

    public async Task SetLibraryRootAsync(string root)
    {
        var normalized = Path.GetFullPath(root);
        await SaveAsync(normalized, PendingLibraryMove, BookmarkInstall, ThemeSwitchUsedVersion);
    }

    public async Task BeginLibraryMoveAsync(PendingLibraryMove pending)
    {
        var normalized = NormalizePendingMove(pending)
            ?? throw new InvalidOperationException("Cloudig received an invalid pending library move.");
        if (!string.IsNullOrWhiteSpace(LibraryRoot)
            && !Path.GetFullPath(LibraryRoot).Equals(normalized.SourceRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig can move only its current selected library.");
        }
        await SaveAsync(normalized.SourceRoot, normalized with { Phase = "preparing" }, BookmarkInstall, ThemeSwitchUsedVersion);
    }

    public async Task CommitLibraryMoveTargetAsync(string planId)
    {
        var pending = RequirePendingMove(planId);
        await SaveAsync(pending.TargetRoot, pending with { Phase = "target_current" }, BookmarkInstall, ThemeSwitchUsedVersion);
    }

    public async Task CompleteLibraryMoveAsync(string planId, string root)
    {
        var pending = RequirePendingMove(planId);
        var normalizedRoot = Path.GetFullPath(root);
        if (!normalizedRoot.Equals(pending.SourceRoot, StringComparison.OrdinalIgnoreCase)
            && !normalizedRoot.Equals(pending.TargetRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig library move completed with an unknown root.");
        }
        await SaveAsync(normalizedRoot, null, BookmarkInstall, ThemeSwitchUsedVersion);
    }

    public async Task SetBookmarkInstallAsync(BookmarkInstallSettings settings)
    {
        await SaveAsync(LibraryRoot, PendingLibraryMove, NormalizeBookmarkInstall(settings), ThemeSwitchUsedVersion);
    }

    public async Task SetThemeSwitchUsedVersionAsync(int version)
    {
        var normalized = NormalizeThemeSwitchUsedVersion(version);
        if (normalized <= ThemeSwitchUsedVersion) return;
        await SaveAsync(LibraryRoot, PendingLibraryMove, BookmarkInstall, normalized);
    }

    private PendingLibraryMove RequirePendingMove(string planId)
    {
        if (PendingLibraryMove is null
            || !PendingLibraryMove.PlanId.Equals(planId, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig library move checkpoint does not match the pending operation.");
        }
        return PendingLibraryMove;
    }

    private async Task SaveAsync(
        string root,
        PendingLibraryMove? pending,
        BookmarkInstallSettings bookmarkInstall,
        int themeSwitchUsedVersion)
    {
        var normalized = string.IsNullOrWhiteSpace(root) ? string.Empty : Path.GetFullPath(root);
        await _writeGate.WaitAsync();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var temporary = Path.Combine(Path.GetDirectoryName(_file)!, $".settings-{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllTextAsync(
                    temporary,
                    JsonSerializer.Serialize(new SettingsDocument(
                        normalized,
                        pending,
                        bookmarkInstall,
                        NormalizeThemeSwitchUsedVersion(themeSwitchUsedVersion)), JsonOptions) + Environment.NewLine);
                File.Move(temporary, _file, overwrite: true);
                LibraryRoot = normalized;
                PendingLibraryMove = pending;
                BookmarkInstall = bookmarkInstall;
                ThemeSwitchUsedVersion = NormalizeThemeSwitchUsedVersion(themeSwitchUsedVersion);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private static PendingLibraryMove? NormalizePendingMove(PendingLibraryMove? value)
    {
        if (value is null
            || value.PlanId.Length != 64
            || value.ManifestSha256.Length != 64
            || !value.PlanId.All(Uri.IsHexDigit)
            || !value.ManifestSha256.All(Uri.IsHexDigit)
            || value.Strategy is not ("rename" or "copy_verify")
            || value.Phase is not ("preparing" or "target_current")
            || value.TotalBytes < 0
            || value.TotalFiles < 1
            || value.TotalDirectories < 1)
        {
            return null;
        }
        var source = Path.GetFullPath(value.SourceRoot);
        var target = Path.GetFullPath(value.TargetRoot);
        if (source.Equals(target, StringComparison.OrdinalIgnoreCase)) return null;
        return value with
        {
            PlanId = value.PlanId.ToLowerInvariant(),
            ManifestSha256 = value.ManifestSha256.ToLowerInvariant(),
            SourceRoot = source,
            TargetRoot = target
        };
    }

    private static BookmarkInstallSettings NormalizeBookmarkInstall(BookmarkInstallSettings? value)
    {
        if (value is null) return BookmarkInstallSettings.Default;
        var folderName = value.FolderName?.Trim() ?? string.Empty;
        if (folderName.Length is < 1 or > 160 || folderName.Any(char.IsControl))
        {
            return BookmarkInstallSettings.Default;
        }
        var storePath = string.IsNullOrWhiteSpace(value.StorePath)
            ? string.Empty
            : Path.GetFullPath(value.StorePath);
        var parentGuid = NormalizeGuid(value.ParentGuid);
        var installationId = NormalizeGuid(value.InstallationId);
        var managedFolderGuid = NormalizeGuid(value.ManagedFolderGuid);
        return value with
        {
            StorePath = storePath,
            ParentGuid = parentGuid,
            FolderName = folderName,
            InstallationId = installationId,
            ManagedFolderGuid = managedFolderGuid,
            PlacementPending = value.PlacementPending && !string.IsNullOrWhiteSpace(storePath)
        };
    }

    private static string NormalizeGuid(string? value) =>
        Guid.TryParse(value, out var parsed) ? parsed.ToString("D").ToLowerInvariant() : string.Empty;

    private static int NormalizeThemeSwitchUsedVersion(int value) => Math.Clamp(value, 0, 1000);

    private sealed record SettingsDocument(
        string LibraryRoot,
        PendingLibraryMove? PendingLibraryMove = null,
        BookmarkInstallSettings? BookmarkInstall = null,
        int ThemeSwitchUsedVersion = 0);
}
