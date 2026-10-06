using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

internal static class BookmarkBackupRetention
{
    internal const int MaximumGroups = 2;
    private const string ManifestName = "backup-manifest.json";

    // A group contains all stores from one transaction, not just one .json file.
    // The caller holds the root lock and has verified the new complete backup.
    internal static void Prune(string root, string? currentDirectory = null)
    {
        var previous = Directory.EnumerateDirectories(root)
            .Where(directory => !directory.Equals(currentDirectory, StringComparison.OrdinalIgnoreCase))
            .Select(ReadOwnedGroup)
            .OfType<Group>()
            .OrderByDescending(group => group.CreatedAt)
            .ThenByDescending(group => group.Directory, StringComparer.Ordinal)
            .Skip(MaximumGroups - (currentDirectory is null ? 0 : 1));
        foreach (var group in previous)
        {
            // Never recurse: an extra file, directory or link makes this group
            // ineligible. No Chrome store path from the manifest is followed.
            foreach (var file in group.Files) File.Delete(Path.Combine(group.Directory, file));
            File.Delete(Path.Combine(group.Directory, ManifestName));
            Directory.Delete(group.Directory, recursive: false);
        }
    }

    private static Group? ReadOwnedGroup(string directory)
    {
        if (!Regex.IsMatch(Path.GetFileName(directory), @"^\d{8}T\d{6}Z-[0-9a-f]{8}$")
            || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return null;
        try
        {
            var manifestPath = Path.Combine(directory, ManifestName);
            var entries = Directory.GetFileSystemEntries(directory);
            if (entries.Any(entry => (File.GetAttributes(entry) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)) return null;
            using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var value = manifest.RootElement;
            if (value.GetProperty("format").GetString() != "cloudig/chrome-bookmark-backup"
                || value.GetProperty("version").GetString() != "0.1.0"
                || !DateTimeOffset.TryParse(value.GetProperty("created_at").GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind, out var createdAt)) return null;
            var files = value.GetProperty("files").EnumerateArray()
                .Select(file => file.GetProperty("backup_file").GetString()).ToArray();
            if (files.Length == 0 || files.Any(file => string.IsNullOrEmpty(file)
                    || file != Path.GetFileName(file) || file.Contains(':')
                    || !file.EndsWith(".json", StringComparison.Ordinal) || file == ManifestName)) return null;
            var owned = files.Select(file => file!).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (owned.Count != files.Length) return null;
            owned.Add(ManifestName);
            if (!owned.SetEquals(entries.Select(Path.GetFileName)!)) return null;
            return new Group(directory, createdAt, files.Select(file => file!).ToArray());
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    private sealed record Group(string Directory, DateTimeOffset CreatedAt, string[] Files);
}
