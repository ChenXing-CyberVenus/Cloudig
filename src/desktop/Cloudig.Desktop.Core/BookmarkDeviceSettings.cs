using System.Text.Json;
using Cloudig.Bookmarks;

namespace Cloudig.Desktop.Core;

public sealed record BookmarkDeviceSettings(
    string StorePath,
    string ParentGuid,
    string FolderName,
    bool PlaceFirst,
    string InstallationId,
    string ManagedFolderGuid,
    bool PlacementPending)
{
    public static BookmarkDeviceSettings Default { get; } = new(
        string.Empty,
        string.Empty,
        BookmarkInstallTarget.DefaultFolderName,
        true,
        string.Empty,
        string.Empty,
        false);
}

public sealed class CloudigDeviceSettingsStore
{
    public const string Schema = "cloudig/device-settings/1.0.0";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        WriteIndented = true
    };
    private readonly string _file;
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal Action<BookmarkDeviceSettings>? BeforeWriteForTests { get; init; }

    public CloudigDeviceSettingsStore(string file)
    {
        _file = Path.GetFullPath(file);
    }

    public async Task<BookmarkDeviceSettings> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try { return Normalize((await LoadDocumentCoreAsync(cancellationToken)).BookmarkInstall); }
        finally { _gate.Release(); }
    }

    public async Task SaveAsync(BookmarkDeviceSettings settings, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadDocumentCoreAsync(cancellationToken);
            var normalized = Normalize(settings);
            BeforeWriteForTests?.Invoke(normalized);
            await SaveDocumentCoreAsync(current with { BookmarkInstall = normalized }, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    private async Task<DeviceDocument> LoadDocumentCoreAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_file)) return new DeviceDocument(Schema, BookmarkDeviceSettings.Default);
        await using var input = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.Read, 16_384, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var document = await JsonSerializer.DeserializeAsync<DeviceDocument>(input, JsonOptions, cancellationToken)
                       ?? throw new InvalidDataException("Cloudig device settings are empty.");
        if (document.Schema != Schema) throw new InvalidDataException("Cloudig device settings use an unsupported version.");
        return document with
        {
            BookmarkInstall = Normalize(document.BookmarkInstall)
        };
    }

    private async Task SaveDocumentCoreAsync(DeviceDocument document, CancellationToken cancellationToken)
    {
        var parent = Path.GetDirectoryName(_file) ?? throw new InvalidDataException("Cloudig device settings directory is invalid.");
        Directory.CreateDirectory(parent);
        var temporary = Path.Combine(parent, $".cloudig-device-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16_384, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(output, document, JsonOptions, cancellationToken);
                await output.WriteAsync("\n"u8.ToArray(), cancellationToken);
                await output.FlushAsync(cancellationToken);
                output.Flush(true);
            }
            File.Move(temporary, _file, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static BookmarkDeviceSettings Normalize(BookmarkDeviceSettings? value)
    {
        if (value is null) return BookmarkDeviceSettings.Default;
        var folder = value.FolderName?.Trim() ?? string.Empty;
        if (folder.Length is < 1 or > 160 || folder.Any(char.IsControl))
        {
            throw new InvalidDataException("Cloudig bookmark folder name is invalid.");
        }
        return value with
        {
            StorePath = string.IsNullOrWhiteSpace(value.StorePath) ? string.Empty : Path.GetFullPath(value.StorePath),
            ParentGuid = NormalizeGuid(value.ParentGuid),
            FolderName = folder,
            InstallationId = NormalizeGuid(value.InstallationId),
            ManagedFolderGuid = NormalizeGuid(value.ManagedFolderGuid),
            PlacementPending = value.PlacementPending && !string.IsNullOrWhiteSpace(value.StorePath)
        };
    }

    private static string NormalizeGuid(string? value) =>
        Guid.TryParse(value, out var guid) ? guid.ToString("D").ToLowerInvariant() : string.Empty;

    private sealed record DeviceDocument(string Schema, BookmarkDeviceSettings BookmarkInstall);
}
