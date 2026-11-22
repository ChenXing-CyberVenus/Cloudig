using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

internal static class BookmarkBackupRetention
{
    internal const int MaximumGroups = 2;
    private const string ManifestName = "backup-manifest.json";

    internal static FileStream Lock(string root)
    {
        Directory.CreateDirectory(root);
        return new FileStream(Path.Combine(root,".transaction.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None,1,FileOptions.DeleteOnClose);
    }

    // A group contains all stores from one transaction, not just one .json file.
    // The caller holds the root lock and has verified the new complete backup.
    internal static void Prune(string root, string? currentDirectory = null)
    {
        var previous = Directory.EnumerateDirectories(root)
            .Select(ReadOwnedGroup)
            .OfType<Group>()
            .Concat(LiveGroups(root))
            .Where(group => !group.Directory.Equals(currentDirectory,StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(group => group.CreatedAt)
            .ThenByDescending(group => group.Directory, StringComparer.Ordinal)
            .Skip(MaximumGroups - (currentDirectory is null ? 0 : 1));
        foreach (var group in previous)
        {
            // Never recurse: an extra file, directory or link makes this group
            // ineligible. No Chrome store path from the manifest is followed.
            foreach (var file in group.Files) File.Delete(Path.Combine(group.Directory, file));
            Directory.Delete(group.Directory, recursive: false);
        }
    }

    private static IEnumerable<Group> LiveGroups(string root)
    {
        var live = Path.Combine(root,"Live");
        if (!Directory.Exists(live) || File.GetAttributes(live).HasFlag(FileAttributes.ReparsePoint)) yield break;
        foreach (var area in Directory.EnumerateDirectories(live))
        {
            var folder = Path.GetFileName(area);
            if (!Guid.TryParseExact(folder,"D",out _) || File.GetAttributes(area).HasFlag(FileAttributes.ReparsePoint)) continue;
            foreach (var dir in LiveUpdate.Groups(area))
            {
                var stamp=Path.GetFileName(dir).Split('-')[0];
                if (!DateTimeOffset.TryParseExact(stamp,"yyyyMMdd'T'HHmmssfffffff'Z'",CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal,out var created)) continue;
                var files=Directory.GetFileSystemEntries(dir);
                if (files.Length!=1 || Path.GetFileName(files[0])!=LiveUpdate.Journal ||
                    File.GetAttributes(files[0]).HasFlag(FileAttributes.ReparsePoint)) continue;
                bool owned;
                try { var log=LiveUpdate.ReadLog(dir);owned=(string?)log["format"]=="cloudig/live-bookmarks/1" && (string?)log["folder"]==folder; }
                catch(Exception error) when(error is IOException or InvalidDataException or JsonException or InvalidOperationException) {owned=false;}
                if (owned) yield return new Group(dir,created,[LiveUpdate.Journal]);
            }
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
            return new Group(directory, createdAt, owned.ToArray());
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    private sealed record Group(string Directory, DateTimeOffset CreatedAt, string[] Files);
}
