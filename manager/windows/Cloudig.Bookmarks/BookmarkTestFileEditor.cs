using System.Globalization;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public sealed class BookmarkTestFileEditor : IBookmarkMutator
{
    private const string FolderTag = "cloudig_test_folder";
    private const string ManagedTag = "cloudig_test_managed";
    private const string IdTag = "cloudig_test_id";
    private const string VersionTag = "cloudig_test_version";
    private const string HashTag = "cloudig_test_sha256";
    private const string DefaultTitleTag = "cloudig_test_default_title";
    private const string SetVersionTag = "cloudig_test_set_version";
    private static readonly string[] RootNames = ["bookmark_bar", "other", "synced"];

    private readonly BookmarkPackage _package;
    private readonly string _folderName;
    private readonly HashSet<string> _packageIds;

    public BookmarkTestFileEditor(BookmarkPackage package, string folderName = "书签测试")
    {
        _package = package ?? throw new ArgumentNullException(nameof(package));
        _folderName = string.IsNullOrWhiteSpace(folderName)
            ? throw new ArgumentException("书签测试文件夹名称不能为空。", nameof(folderName))
            : folderName;
        _packageIds = package.Bookmarks.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        if (_packageIds.Count == 0 || _packageIds.Count != package.Bookmarks.Count)
        {
            throw new InvalidDataException("书签测试集合为空或包含重复稳定 ID。");
        }
    }

    public BookmarkMutation Mutate(string originalJson, BookmarkOperation operation, DateTime utcNow)
    {
        if (operation is not BookmarkOperation.InstallOrRepair)
        {
            throw new NotSupportedException("书签测试安装器只执行安装或更新。");
        }

        var document = BookmarkJson.ParseObject(originalJson);
        ValidateDocument(document);
        ChromeBookmarkChecksums.AssertValid(document);
        var counters = new Counters();
        var changed = InstallOrRepair(document, utcNow, counters);
        var managedFolderGuid = EnumerateAllNodes(BookmarkJson.RequiredObject(document, "roots"))
            .Where(IsManagedFolder).Select(node => BookmarkJson.RequiredString(node, "guid")).Single();
        var checksums = ChromeBookmarkChecksums.Compute(document);
        if (!changed)
        {
            return new BookmarkMutation(false, originalJson, 0, 0, 0, checksums.Md5, checksums.Sha256, managedFolderGuid);
        }
        document["checksum"] = checksums.Md5;
        document["checksum_sha256"] = checksums.Sha256;
        return new BookmarkMutation(
            true,
            BookmarkJson.Serialize(document),
            counters.Added,
            counters.Updated,
            counters.Removed,
            checksums.Md5,
            checksums.Sha256,
            managedFolderGuid);
    }

    private bool InstallOrRepair(JsonObject document, DateTime utcNow, Counters counters)
    {
        var roots = BookmarkJson.RequiredObject(document, "roots");
        var bookmarkBar = BookmarkJson.RequiredObject(roots, "bookmark_bar");
        var allNodes = EnumerateAllNodes(roots).ToList();
        var managedFolders = allNodes.Where(IsManagedFolder).ToArray();
        if (managedFolders.Length > 1)
        {
            throw new InvalidDataException("发现多个 cloudig_test 管理文件夹，已停止且未写入。");
        }

        var bookmarkBarChildren = BookmarkJson.RequiredArray(bookmarkBar, "children");
        if (managedFolders.Length == 1
            && !bookmarkBarChildren.OfType<JsonObject>().Any(node => ReferenceEquals(node, managedFolders[0])))
        {
            throw new InvalidDataException("cloudig_test 管理文件夹不在 Chrome 书签栏根目录，已停止且未写入。");
        }

        var unmanagedExactFolders = bookmarkBarChildren
            .OfType<JsonObject>()
            .Where(node => BookmarkJson.RequiredString(node, "type") == "folder"
                           && BookmarkJson.RequiredString(node, "name") == _folderName
                           && !IsManagedFolder(node))
            .ToArray();
        if (unmanagedExactFolders.Length > 0)
        {
            throw new InvalidDataException($"书签栏已有未托管的同名文件夹“{_folderName}”；安装器不会接管它。");
        }

        var now = ChromeTime(utcNow);
        var nextId = FindMaximumId(allNodes) + 1;
        var changed = false;
        JsonObject folder;
        if (managedFolders.Length == 0)
        {
            folder = NewFolder((nextId++).ToString(CultureInfo.InvariantCulture), _folderName, now);
            bookmarkBarChildren.Add((JsonNode)folder);
            bookmarkBar["date_modified"] = now;
            counters.Added += 1;
            changed = true;
        }
        else
        {
            folder = managedFolders[0];
            changed |= SetIfDifferent(folder, "name", _folderName);
        }

        var folderChildren = BookmarkJson.RequiredArray(folder, "children");
        var directChildren = folderChildren.OfType<JsonObject>().ToHashSet(ReferenceEqualityComparer.Instance);
        var managedBookmarks = allNodes.Where(IsManagedBookmark).ToArray();
        if (managedBookmarks.Any(node => !directChildren.Contains(node)))
        {
            throw new InvalidDataException("发现被移出“书签测试”文件夹的 cloudig_test 书签，已停止且未写入。");
        }

        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in managedBookmarks)
        {
            var id = ManagedId(node);
            if (!seenIds.Add(id)) throw new InvalidDataException($"cloudig_test 稳定 ID 重复：{id}");
        }

        for (var index = folderChildren.Count - 1; index >= 0; index--)
        {
            if (folderChildren[index] is not JsonObject node || !IsManagedBookmark(node)) continue;
            if (_packageIds.Contains(ManagedId(node))) continue;
            folderChildren.RemoveAt(index);
            counters.Removed += 1;
            changed = true;
        }

        var managedById = folderChildren
            .OfType<JsonObject>()
            .Where(IsManagedBookmark)
            .ToDictionary(ManagedId, StringComparer.Ordinal);
        foreach (var definition in _package.Bookmarks)
        {
            if (!managedById.TryGetValue(definition.Id, out var node))
            {
                node = NewBookmark((nextId++).ToString(CultureInfo.InvariantCulture), definition, now);
                folderChildren.Add((JsonNode)node);
                managedById.Add(definition.Id, node);
                counters.Added += 1;
                changed = true;
                continue;
            }

            if (BookmarkJson.RequiredString(node, "type") != "url")
            {
                throw new InvalidDataException($"cloudig_test 节点不是 URL：{definition.Id}");
            }
            var nodeChanged = SetIfDifferent(node, "url", definition.Url);
            var meta = GetOrCreateMeta(node);
            var previousDefault = BookmarkJson.OptionalString(meta, DefaultTitleTag);
            var currentTitle = BookmarkJson.RequiredString(node, "name");
            var oldAutomaticTitle = $"{definition.Label} · {BookmarkJson.OptionalString(meta, VersionTag) ?? definition.Version}";
            if (currentTitle == previousDefault
                || (previousDefault is null && (currentTitle == oldAutomaticTitle || currentTitle == definition.TitleZh)))
            {
                nodeChanged |= SetIfDifferent(node, "name", definition.TitleZh);
            }
            nodeChanged |= SetIfDifferent(meta, ManagedTag, "1");
            nodeChanged |= SetIfDifferent(meta, IdTag, definition.Id);
            nodeChanged |= SetIfDifferent(meta, VersionTag, definition.Version);
            nodeChanged |= SetIfDifferent(meta, HashTag, definition.Sha256);
            nodeChanged |= SetIfDifferent(meta, DefaultTitleTag, definition.TitleZh);
            if (!nodeChanged) continue;
            counters.Updated += 1;
            changed = true;
        }

        var folderMeta = GetOrCreateMeta(folder);
        changed |= SetIfDifferent(folderMeta, FolderTag, "1");
        changed |= SetIfDifferent(folderMeta, SetVersionTag, _package.BookmarkSetVersion);
        if (changed) folder["date_modified"] = now;
        return changed;
    }

    private static void ValidateDocument(JsonObject document)
    {
        if (document["version"] is not JsonValue version || !version.TryGetValue<int>(out var value) || value != 1)
        {
            throw new InvalidDataException("书签测试安装器仅支持 Chrome Bookmarks version 1。");
        }
        var roots = BookmarkJson.RequiredObject(document, "roots");
        foreach (var rootName in RootNames)
        {
            if (BookmarkJson.RequiredString(BookmarkJson.RequiredObject(roots, rootName), "type") != "folder")
            {
                throw new InvalidDataException($"Chrome 永久根节点不是文件夹：{rootName}");
            }
        }
        foreach (var property in roots)
        {
            if (!RootNames.Contains(property.Key, StringComparer.Ordinal))
            {
                throw new InvalidDataException($"未知 Chrome 永久根节点：{property.Key}");
            }
        }
    }

    private static IEnumerable<JsonObject> EnumerateAllNodes(JsonObject roots)
    {
        var stack = new Stack<(JsonObject Node, int Depth)>();
        for (var index = RootNames.Length - 1; index >= 0; index--)
        {
            stack.Push((BookmarkJson.RequiredObject(roots, RootNames[index]), 0));
        }
        var count = 0;
        while (stack.Count > 0)
        {
            var (node, depth) = stack.Pop();
            if (depth > 256 || ++count > 1_000_000)
            {
                throw new InvalidDataException("Chrome Bookmarks 超出安装器可处理范围。");
            }
            yield return node;
            if (BookmarkJson.RequiredString(node, "type") != "folder") continue;
            var children = BookmarkJson.RequiredArray(node, "children");
            for (var index = children.Count - 1; index >= 0; index--)
            {
                if (children[index] is not JsonObject child)
                {
                    throw new InvalidDataException("Chrome 书签子节点必须是对象。");
                }
                stack.Push((child, depth + 1));
            }
        }
    }

    private static long FindMaximumId(IEnumerable<JsonObject> nodes)
    {
        var maximum = 0L;
        foreach (var node in nodes)
        {
            if (long.TryParse(
                    BookmarkJson.RequiredString(node, "id"),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var value))
            {
                maximum = Math.Max(maximum, value);
            }
        }
        return maximum;
    }

    private static JsonObject NewFolder(string id, string name, string now) => new()
    {
        ["children"] = new JsonArray(),
        ["date_added"] = now,
        ["date_last_used"] = "0",
        ["date_modified"] = now,
        ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
        ["id"] = id,
        ["meta_info"] = new JsonObject { [FolderTag] = "1" },
        ["name"] = name,
        ["type"] = "folder"
    };

    private static JsonObject NewBookmark(string id, BookmarkDefinition definition, string now) => new()
    {
        ["date_added"] = now,
        ["date_last_used"] = "0",
        ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
        ["id"] = id,
        ["meta_info"] = new JsonObject
        {
            [ManagedTag] = "1",
            [IdTag] = definition.Id,
            [VersionTag] = definition.Version,
            [HashTag] = definition.Sha256,
            [DefaultTitleTag] = definition.TitleZh
        },
        ["name"] = definition.TitleZh,
        ["type"] = "url",
        ["url"] = definition.Url
    };

    private static bool IsManagedFolder(JsonObject node) =>
        BookmarkJson.RequiredString(node, "type") == "folder"
        && node["meta_info"] is JsonObject meta
        && BookmarkJson.OptionalString(meta, FolderTag) == "1";

    private static bool IsManagedBookmark(JsonObject node) =>
        BookmarkJson.RequiredString(node, "type") == "url"
        && node["meta_info"] is JsonObject meta
        && BookmarkJson.OptionalString(meta, ManagedTag) == "1";

    private static string ManagedId(JsonObject node) =>
        BookmarkJson.OptionalString(BookmarkJson.RequiredObject(node, "meta_info"), IdTag)
        ?? throw new InvalidDataException("cloudig_test 书签缺少稳定 ID。");

    private static JsonObject GetOrCreateMeta(JsonObject node)
    {
        if (node["meta_info"] is JsonObject meta) return meta;
        meta = new JsonObject();
        node["meta_info"] = meta;
        return meta;
    }

    private static bool SetIfDifferent(JsonObject target, string key, string value)
    {
        if (BookmarkJson.OptionalString(target, key) == value) return false;
        target[key] = value;
        return true;
    }

    private static string ChromeTime(DateTime utcNow)
    {
        var value = utcNow.Kind == DateTimeKind.Utc ? utcNow : utcNow.ToUniversalTime();
        return (value.ToFileTimeUtc() / 10L).ToString(CultureInfo.InvariantCulture);
    }

    private sealed class Counters
    {
        public int Added { get; set; }
        public int Updated { get; set; }
        public int Removed { get; set; }
    }
}
