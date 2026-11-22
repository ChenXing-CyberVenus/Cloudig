using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

// Chrome assigns GUIDs and owns its on-disk tree. These receipts bind only
// nodes created through its UI to the installation and the original slot.
internal sealed class NativeBookmarkOwnership
{
    public string Store { get; init; } = "";
    public string Installation { get; init; } = "";
    public string Folder { get; set; } = "";
    public string FolderDraft { get; set; } = "";
    public Dictionary<string, Item> Items { get; init; } = new();
    internal sealed record Item(string Guid, string Draft, string Title, string Version, string Hash, string Profile);

    private static string PathFor(string root, BookmarkInstallTarget target)
    {
        var directory = Path.GetFullPath(Path.GetDirectoryName(target.StorePath)!).ToUpperInvariant();
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(directory)));
        return Path.Combine(root, "Live", key, Guid.Parse(target.InstallationId).ToString("D") + ".json");
    }
    internal static NativeBookmarkOwnership? Load(string? root, BookmarkInstallTarget target)
    {
        if (root == null || !Guid.TryParse(target.InstallationId, out _) || string.IsNullOrEmpty(target.StorePath)) return null;
        var file = PathFor(root, target);
        if (!File.Exists(file)) return null;
        var saved = JsonSerializer.Deserialize<NativeBookmarkOwnership>(File.ReadAllBytes(file));
        if (saved == null || saved.Installation != target.InstallationId) throw new InvalidDataException("安装记录身份不一致。");
        return ChromeProfileDiscovery.SameLogicalStore(saved.Store, target.StorePath) ? saved : null;
    }
    internal void Save(string root, BookmarkInstallTarget target)
    {
        var path = PathFor(root, target);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using (var f = new FileStream(path + ".pending", FileMode.Create, FileAccess.Write, FileShare.None))
        { JsonSerializer.Serialize(f, this); f.Flush(true); }
        File.Move(path + ".pending", path, true);
    }
    internal static void Retire(string? root, BookmarkInstallTarget target)
    {
        if (Load(root, target) != null) File.Delete(PathFor(root!, target));
    }
    internal static IEnumerable<JsonObject> Folders(JsonObject roots)
    {
        var pending = new Stack<JsonObject>(roots.Select(entry => entry.Value).OfType<JsonObject>());
        while (pending.TryPop(out var folder))
        {
            yield return folder;
            foreach (var child in folder["children"]!.AsArray().OfType<JsonObject>().Where(n => (string?)n["type"] == "folder")) pending.Push(child);
        }
    }
    internal void Project(JsonObject roots)
    {
        if (Folder.Length == 0) return;
        var folder = Folders(roots).SingleOrDefault(node => (string?)node["guid"] == Folder);
        if (folder == null) return;
        var meta = Metadata(folder);
        if (meta["cloudig_installation_id"] is { } owner && (string?)owner != Installation) return;
        meta["cloudig_folder"] = "1"; meta["cloudig_installation_id"] = Installation;
        var children = folder["children"]!.AsArray().OfType<JsonObject>().ToDictionary(n => (string)n["guid"]!);
        foreach (var (slot, receipt) in Items)
        {
            if (!children.TryGetValue(receipt.Guid, out var node) || (string?)node["type"] != "url") continue;
            var m = Metadata(node);
            if (m.ContainsKey("cloudig_managed") || m.ContainsKey("ai_chat_archive_managed")) continue;
            m["cloudig_managed"] = "1"; m["cloudig_id"] = slot; m["cloudig_installation_id"] = Installation;
            m["cloudig_default_title"] = receipt.Title; m["cloudig_version"] = receipt.Version;
            m["cloudig_profile"] = receipt.Profile; m["cloudig_sha256"] = receipt.Hash;
        }
    }
    private static JsonObject Metadata(JsonObject node)
    {
        if (node["meta_info"] is JsonObject meta) return meta;
        var added = new JsonObject(); node["meta_info"] = added; return added;
    }
}
