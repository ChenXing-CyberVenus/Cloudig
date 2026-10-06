using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public static class ChromeProfileDiscovery
{
    public static string DefaultUserDataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Google",
        "Chrome",
        "User Data");

    public static IReadOnlyList<ChromeProfile> Discover(string userDataDirectory)
    {
        if (string.IsNullOrWhiteSpace(userDataDirectory) || !Directory.Exists(userDataDirectory)) return Array.Empty<ChromeProfile>();
        var root = Path.GetFullPath(userDataDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var localState = Path.Combine(root, "Local State");
        var displayNames = ReadDisplayNames(localState);
        var lastUsed = ReadLastUsedProfile(localState);
        var candidates = new HashSet<string>(displayNames.Keys, StringComparer.OrdinalIgnoreCase);
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            if (File.Exists(Path.Combine(directory, "Bookmarks")) || File.Exists(Path.Combine(directory, "Bookmarks Account")))
            {
                candidates.Add(Path.GetFileName(directory));
            }
        }

        var profiles = new List<ChromeProfile>();
        foreach (var directoryName in candidates)
        {
            if (string.IsNullOrWhiteSpace(directoryName)) continue;
            var profilePath = Path.GetFullPath(Path.Combine(root, directoryName));
            if (!profilePath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
            var stores = new List<BookmarkStore>();
            AddStore(stores, directoryName, displayNames.GetValueOrDefault(directoryName) ?? directoryName, profilePath, "Bookmarks", "local");
            AddStore(stores, directoryName, displayNames.GetValueOrDefault(directoryName) ?? directoryName, profilePath, "Bookmarks Account", "account");
            if (stores.Count == 0) continue;
            profiles.Add(new ChromeProfile(
                directoryName,
                displayNames.GetValueOrDefault(directoryName) ?? directoryName,
                directoryName.Equals(lastUsed, StringComparison.OrdinalIgnoreCase),
                stores));
        }
        return profiles
            .OrderBy(profile => profile.DirectoryName.Equals("Default", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(profile => profile.DirectoryName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public static bool IsChromeRunning()
    {
        var processes = Process.GetProcessesByName("chrome");
        try { return processes.Length > 0; }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    public static byte[] ReadAllBytesShared(string path)
    {
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new MemoryStream();
        input.CopyTo(output);
        return output.ToArray();
    }

    public static string DecodeUtf8(byte[] bytes)
    {
        var offset = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        return new UTF8Encoding(false, true).GetString(bytes, offset, bytes.Length - offset);
    }

    private static Dictionary<string, string> ReadDisplayNames(string localState)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var document = JsonDocument.Parse(DecodeUtf8(ReadAllBytesShared(localState)), new JsonDocumentOptions { MaxDepth = 64 });
            if (!document.RootElement.TryGetProperty("profile", out var profile)
                || !profile.TryGetProperty("info_cache", out var cache)
                || cache.ValueKind is not JsonValueKind.Object) return result;
            foreach (var pair in cache.EnumerateObject())
            {
                if (pair.Value.ValueKind is not JsonValueKind.Object) continue;
                var name = pair.Value.TryGetProperty("name", out var nameValue) && nameValue.ValueKind is JsonValueKind.String
                    ? nameValue.GetString()
                    : pair.Value.TryGetProperty("shortcut_name", out var shortcut) && shortcut.ValueKind is JsonValueKind.String
                        ? shortcut.GetString()
                        : pair.Name;
                result[pair.Name] = string.IsNullOrWhiteSpace(name) ? pair.Name : name;
            }
        }
        catch (Exception) when (!Debugger.IsAttached)
        {
            // Profile directories remain discoverable when Local State is missing or malformed.
        }
        return result;
    }

    private static string ReadLastUsedProfile(string localState)
    {
        try
        {
            using var document = JsonDocument.Parse(DecodeUtf8(ReadAllBytesShared(localState)), new JsonDocumentOptions { MaxDepth = 64 });
            return document.RootElement.TryGetProperty("profile", out var profile)
                   && profile.TryGetProperty("last_used", out var lastUsed)
                   && lastUsed.ValueKind is JsonValueKind.String
                ? lastUsed.GetString() ?? string.Empty
                : string.Empty;
        }
        catch (Exception) when (!Debugger.IsAttached)
        {
            return string.Empty;
        }
    }

    private static void AddStore(
        ICollection<BookmarkStore> stores,
        string directoryName,
        string displayName,
        string profilePath,
        string fileName,
        string kind)
    {
        var path = Path.Combine(profilePath, fileName);
        if (File.Exists(path)) stores.Add(new BookmarkStore(directoryName, displayName, kind, path));
    }
}
