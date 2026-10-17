using System.Globalization;
using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public sealed class BookmarkFileEditor : IBookmarkMutator
{
    private const string FolderTag = "cloudig_folder";
    private const string ManagedTag = "cloudig_managed";
    private const string IdTag = "cloudig_id";
    private const string VersionTag = "cloudig_version";
    private const string HashTag = "cloudig_sha256";
    private const string ProfileTag = "cloudig_profile";
    private const string DefaultTitleTag = "cloudig_default_title";
    private const string SetVersionTag = "cloudig_set_version";
    private const string InstallationTag = "cloudig_installation_id";
    private const string LegacyFolderTag = "ai_chat_archive_folder";
    private const string LegacyManagedTag = "ai_chat_archive_managed";
    private const string LegacyIdTag = "ai_chat_archive_id";
    private const string LegacyVersionTag = "ai_chat_archive_version";
    private const string LegacyHashTag = "ai_chat_archive_sha256";
    private const string LegacySetVersionTag = "ai_chat_archive_set_version";
    private static readonly string[] RootNames = ["bookmark_bar", "other", "synced"];

    private readonly BookmarkPackage _package;
    private readonly BookmarkProfileSelection _selection;
    private readonly BookmarkInstallTarget _target;
    private readonly HashSet<string> _packagePlatformIds;
    private readonly HashSet<string> _packageVariantIds;
    private readonly HashSet<string> _selectedPlatformIds;
    private readonly HashSet<string> _selectedVariantIds;

    public BookmarkFileEditor(
        BookmarkPackage package,
        string preferredFolderName = "采云 Cloudig",
        IEnumerable<string>? selectedBookmarkIds = null,
        string? requestedProfile = null,
        BookmarkInstallTarget? target = null)
    {
        _package = package ?? throw new ArgumentNullException(nameof(package));
        _selection = package.Resolve(requestedProfile);
        if (string.IsNullOrWhiteSpace(preferredFolderName)) throw new ArgumentException("Cloudig bookmark folder name is required.", nameof(preferredFolderName));
        var requestedTarget = target ?? BookmarkInstallTarget.Default();
        _target = requestedTarget with
        {
            FolderName = string.IsNullOrWhiteSpace(requestedTarget.FolderName)
                ? preferredFolderName.Trim()
                : requestedTarget.FolderName.Trim()
        };
        if (_target.FolderName.Length > 160 || _target.FolderName.Any(char.IsControl))
        {
            throw new ArgumentException("Cloudig bookmark folder name is invalid.", nameof(target));
        }
        _packagePlatformIds = package.Platforms.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        _packageVariantIds = package.Platforms
            .SelectMany(item => item.Variants)
            .Select(item => item.VariantId)
            .ToHashSet(StringComparer.Ordinal);
        _selectedPlatformIds = selectedBookmarkIds is null
            ? new HashSet<string>(_packagePlatformIds, StringComparer.Ordinal)
            : selectedBookmarkIds.Where(item => !string.IsNullOrWhiteSpace(item)).ToHashSet(StringComparer.Ordinal);
        if (_selectedPlatformIds.Count == 0) throw new ArgumentException("Select at least one Cloudig bookmark.", nameof(selectedBookmarkIds));
        var unknown = _selectedPlatformIds.Where(item => !_packagePlatformIds.Contains(item)).Order(StringComparer.Ordinal).ToArray();
        if (unknown.Length > 0) throw new ArgumentException($"Unknown Cloudig bookmark id: {string.Join(", ", unknown)}", nameof(selectedBookmarkIds));
        _selectedVariantIds = _selection.Bookmarks
            .Where(item => _selectedPlatformIds.Contains(item.Id))
            .Select(item => item.Definition.VariantId)
            .ToHashSet(StringComparer.Ordinal);
    }

    public BookmarkMutation Mutate(string originalJson, BookmarkOperation operation, DateTime utcNow)
    {
        var document = BookmarkJson.ParseObject(originalJson);
        ValidateDocument(document);
        ChromeBookmarkChecksums.AssertValid(document);
        var counters = new Counters();
        string managedFolderGuid;
        var changed = operation is BookmarkOperation.InstallOrRepair
            ? InstallOrRepair(document, utcNow, counters, out managedFolderGuid)
            : Remove(document, counters, out managedFolderGuid);
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

    public BookmarkInspection Inspect(string json)
    {
        var document = BookmarkJson.ParseObject(json);
        ValidateDocument(document);
        ChromeBookmarkChecksums.AssertValid(document);
        var roots = BookmarkJson.RequiredObject(document, "roots");
        var folder = LocateTargetFolder(roots, allowUnownedContainer: false);
        var managed = folder is null
            ? Array.Empty<JsonObject>()
            : DirectChildren(folder).Where(IsOwnedBookmark).ToArray();
        var managedByVariantId = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var node in managed)
        {
            var variantId = ManagedVariantId(node);
            if (!_packageVariantIds.Contains(variantId)) throw new InvalidDataException($"Unknown managed Cloudig bookmark variant id: {variantId}");
            if (!managedByVariantId.TryAdd(variantId, node)) throw new InvalidDataException($"Duplicate managed Cloudig bookmark variant id: {variantId}");
        }
        var entries = _selection.Bookmarks.Select(expected =>
        {
            var definition = expected.Definition;
            if (!managedByVariantId.TryGetValue(definition.VariantId, out var node))
            {
                return new BookmarkEntryInspection(
                    definition.Id,
                    "missing",
                    string.Empty,
                    expected.RequestedProfile,
                    expected.EffectiveProfile,
                    expected.Fallback,
                    string.Empty);
            }
            var meta = BookmarkJson.RequiredObject(node, "meta_info");
            var installedVersion = MetaValue(meta, VersionTag, LegacyVersionTag) ?? string.Empty;
            var installedProfile = InstalledProfile(meta);
            var status = installedProfile != expected.EffectiveProfile
                ? "different_profile"
                : BookmarkChangelog.IsNewerVersion(installedVersion, definition.Version)
                    ? "newer"
                : EquivalentBookmarkUrl(BookmarkJson.RequiredString(node, "url"), definition.Url)
                  && installedVersion == definition.Version
                  && MetaValue(meta, HashTag, LegacyHashTag) == definition.Sha256
                    ? "current"
                    : "outdated";
            return new BookmarkEntryInspection(
                definition.Id,
                status,
                installedVersion,
                expected.RequestedProfile,
                expected.EffectiveProfile,
                expected.Fallback,
                installedProfile);
        }).ToArray();
        var setVersion = folder?["meta_info"] is JsonObject folderMeta
            ? MetaValue(folderMeta, SetVersionTag, LegacySetVersionTag) ?? string.Empty
            : string.Empty;
        var allCurrent = entries.All(item => item.Status is "current" or "newer");
        var status = managed.Length == 0
            ? "missing"
            : allCurrent
                ? entries.Any(item => item.Status == "newer") ? "newer" : "current"
                : entries.Any(item => item.Status == "different_profile")
                    ? "different_profile"
                    : entries.All(item => item.Status == "missing")
                        ? "missing"
                        : entries.All(item => item.Status is "current" or "newer" or "outdated")
                            ? "outdated"
                            : "partial";
        return new BookmarkInspection(status, managed.Length, setVersion, entries, folder is null ? string.Empty : FolderGuid(folder));
    }

    private bool InstallOrRepair(JsonObject document, DateTime utcNow, Counters counters, out string managedFolderGuid)
    {
        var roots = BookmarkJson.RequiredObject(document, "roots");
        var allNodes = EnumerateAllNodes(roots).ToList();
        var changed = false;
        var now = ChromeTime(utcNow);
        var nextId = FindMaximumId(allNodes) + 1;
        var parent = ResolveTargetParent(roots);
        var folder = LocateTargetFolder(roots, allowUnownedContainer: true);
        var adoptingUnownedFolder = folder is not null && !FolderBelongsToInstallation(folder);
        if (folder is null)
        {
            folder = NewFolder(
                (nextId++).ToString(CultureInfo.InvariantCulture),
                _target.FolderName,
                _target.InstallationId,
                now);
            InsertChild(parent, folder, _target.PlaceFirst);
            parent["date_modified"] = now;
            counters.Added += 1;
            changed = true;
        }
        else if (_target.PlacementPending)
        {
            changed |= ApplyTargetPlacement(roots, parent, folder, now, counters);
        }
        else if (_target.PlaceFirst && TryFindParent(roots, folder, out var currentParent))
        {
            // Routine installs sort the chosen folder but preserve a user rename
            // or move. Only an explicit settings change relocates/renames it.
            if (MoveFolderFirst(currentParent, folder, now))
            {
                changed = true;
                counters.Updated += 1;
            }
        }

        var folderMeta = GetOrCreateMeta(folder);
        var existingInstallation = BookmarkJson.OptionalString(folderMeta, InstallationTag);
        if (!string.IsNullOrWhiteSpace(existingInstallation)
            && !string.IsNullOrWhiteSpace(_target.InstallationId)
            && !existingInstallation.Equals(_target.InstallationId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The selected bookmark folder belongs to another Cloudig installation.");
        }
        changed |= MigrateMeta(folderMeta, FolderTag, LegacyFolderTag, "1");
        changed |= MigrateMeta(folderMeta, SetVersionTag, LegacySetVersionTag, _package.BookmarkSetVersion);
        if (!string.IsNullOrWhiteSpace(_target.InstallationId))
        {
            changed |= SetIfDifferent(folderMeta, InstallationTag, _target.InstallationId);
        }

        var managedByVariantId = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var node in DirectChildren(folder).Where(IsManagedBookmark))
        {
            var meta = BookmarkJson.RequiredObject(node, "meta_info");
            var nodeInstallation = BookmarkJson.OptionalString(meta, InstallationTag);
            var belongs = string.IsNullOrWhiteSpace(_target.InstallationId)
                          || nodeInstallation == _target.InstallationId
                          || (adoptingUnownedFolder && string.IsNullOrWhiteSpace(nodeInstallation));
            if (!belongs) continue;
            var variantId = ManagedVariantId(node);
            if (!_packageVariantIds.Contains(variantId)) throw new InvalidDataException($"Unknown managed Cloudig bookmark variant id in the selected folder: {variantId}");
            if (!managedByVariantId.TryAdd(variantId, node)) throw new InvalidDataException($"Duplicate managed Cloudig bookmark variant id in the selected folder: {variantId}");
            if (!string.IsNullOrWhiteSpace(_target.InstallationId)
                && SetIfDifferent(meta, InstallationTag, _target.InstallationId))
            {
                counters.Updated += 1;
                changed = true;
            }
        }

        foreach (var expected in _selection.Bookmarks.Where(item => _selectedPlatformIds.Contains(item.Id)))
        {
            var definition = expected.Definition;
            var expectedTitle = DefaultTitle(definition, expected.EffectiveProfile);
            if (!managedByVariantId.TryGetValue(definition.VariantId, out var node))
            {
                node = NewBookmark(
                    (nextId++).ToString(CultureInfo.InvariantCulture),
                    definition,
                    expected.EffectiveProfile,
                    _target.InstallationId,
                    now);
                AppendChild(folder, node);
                managedByVariantId.Add(definition.VariantId, node);
                counters.Added += 1;
                changed = true;
                continue;
            }
            if (BookmarkJson.RequiredString(node, "type") != "url") throw new InvalidDataException($"Managed Cloudig node is not a URL: {definition.Id}");
            var meta = GetOrCreateMeta(node);
            // A frozen bundle may update an automatic label without downgrading
            // newer installed code or displaying the bundle's older version.
            var installedVersion = MetaValue(meta, VersionTag, LegacyVersionTag) ?? string.Empty;
            var keepNewer = InstalledProfile(meta) == expected.EffectiveProfile
                && BookmarkChangelog.IsNewerVersion(installedVersion, definition.Version);
            if (keepNewer) expectedTitle = BookmarkDisplayName.Format(definition.Label, expected.EffectiveProfile, installedVersion);
            var nodeChanged = !keepNewer && !EquivalentBookmarkUrl(BookmarkJson.RequiredString(node, "url"), definition.Url)
                && SetIfDifferent(node, "url", definition.Url);
            var currentTitle = BookmarkJson.RequiredString(node, "name");
            var previousDefaultTitle = BookmarkJson.OptionalString(meta, DefaultTitleTag);
            if ((previousDefaultTitle is not null && currentTitle == previousDefaultTitle)
                || (previousDefaultTitle is null && (currentTitle == expectedTitle || IsKnownPreviousDefaultTitle(currentTitle, definition))))
            {
                nodeChanged |= SetIfDifferent(node, "name", expectedTitle);
            }
            if (!keepNewer)
            {
                nodeChanged |= MigrateMeta(meta, ManagedTag, LegacyManagedTag, "1");
                nodeChanged |= MigrateMeta(meta, IdTag, LegacyIdTag, definition.VariantId);
                nodeChanged |= MigrateMeta(meta, VersionTag, LegacyVersionTag, definition.Version);
                nodeChanged |= MigrateMeta(meta, HashTag, LegacyHashTag, definition.Sha256);
                nodeChanged |= SetIfDifferent(meta, ProfileTag, expected.EffectiveProfile);
            }
            nodeChanged |= SetIfDifferent(meta, DefaultTitleTag, expectedTitle);
            if (!string.IsNullOrWhiteSpace(_target.InstallationId))
            {
                nodeChanged |= SetIfDifferent(meta, InstallationTag, _target.InstallationId);
            }
            if (!nodeChanged) continue;
            counters.Updated += 1;
            changed = true;
        }
        if (changed) folder["date_modified"] = now;
        managedFolderGuid = FolderGuid(folder);
        return changed;
    }

    private bool Remove(JsonObject document, Counters counters, out string managedFolderGuid)
    {
        var roots = BookmarkJson.RequiredObject(document, "roots");
        var folder = LocateTargetFolder(roots, allowUnownedContainer: false);
        if (folder is null)
        {
            managedFolderGuid = string.Empty;
            return false;
        }
        var children = BookmarkJson.RequiredArray(folder, "children");
        var kept = new JsonArray();
        var changed = false;
        foreach (var raw in children.ToArray())
        {
            if (raw is not JsonObject node) throw new InvalidDataException("Chrome bookmark children must be objects.");
            if (IsOwnedBookmark(node) && _selectedVariantIds.Contains(ManagedVariantId(node)))
            {
                counters.Removed += 1;
                changed = true;
                continue;
            }
            kept.Add(node.DeepClone());
        }
        if (changed) folder["children"] = kept;
        if (!changed)
        {
            managedFolderGuid = FolderGuid(folder);
            return false;
        }
        if (DirectChildren(folder).Any(IsOwnedBookmark))
        {
            managedFolderGuid = FolderGuid(folder);
            return true;
        }

        StripManagedFolderMetadata(folder);
        if (BookmarkJson.RequiredArray(folder, "children").Count == 0
            && TryFindParent(roots, folder, out var parent))
        {
            RemoveChild(parent, folder);
            counters.Removed += 1;
        }
        managedFolderGuid = string.Empty;
        return true;
    }

    private JsonObject ResolveTargetParent(JsonObject roots)
    {
        if (string.IsNullOrWhiteSpace(_target.ParentGuid))
        {
            return BookmarkJson.RequiredObject(roots, "bookmark_bar");
        }
        return EnumerateAllNodes(roots).FirstOrDefault(node =>
                   BookmarkJson.RequiredString(node, "type") == "folder"
                   && FolderGuid(node).Equals(_target.ParentGuid, StringComparison.OrdinalIgnoreCase))
               ?? throw new InvalidDataException("The selected Chrome bookmark parent folder no longer exists.");
    }

    private JsonObject? LocateTargetFolder(JsonObject roots, bool allowUnownedContainer)
    {
        if (!string.IsNullOrWhiteSpace(_target.ManagedFolderGuid))
        {
            var exact = EnumerateAllNodes(roots).FirstOrDefault(node =>
                BookmarkJson.RequiredString(node, "type") == "folder"
                && FolderGuid(node).Equals(_target.ManagedFolderGuid, StringComparison.OrdinalIgnoreCase));
            if (exact is not null)
            {
                if (!allowUnownedContainer && !FolderBelongsToInstallation(exact)) return null;
                return exact;
            }
            if (!allowUnownedContainer) return null;
        }

        var parent = ResolveTargetParent(roots);
        var matches = DirectChildren(parent)
            .Where(node => BookmarkJson.RequiredString(node, "type") == "folder"
                           && BookmarkJson.RequiredString(node, "name").Equals(_target.FolderName, StringComparison.Ordinal))
            .ToArray();
        if (matches.Length > 1)
        {
            throw new InvalidDataException("The selected Chrome bookmark path contains duplicate folder names; choose another target.");
        }
        if (matches.Length == 0) return null;
        if (!allowUnownedContainer && !FolderBelongsToInstallation(matches[0])) return null;
        return matches[0];
    }

    private bool FolderBelongsToInstallation(JsonObject folder)
    {
        if (folder["meta_info"] is not JsonObject meta || !IsManagedFolder(folder)) return false;
        if (string.IsNullOrWhiteSpace(_target.InstallationId)) return true;
        return BookmarkJson.OptionalString(meta, InstallationTag) == _target.InstallationId;
    }

    private bool IsOwnedBookmark(JsonObject node)
    {
        if (!IsManagedBookmark(node)) return false;
        if (string.IsNullOrWhiteSpace(_target.InstallationId)) return true;
        return BookmarkJson.OptionalString(BookmarkJson.RequiredObject(node, "meta_info"), InstallationTag) == _target.InstallationId;
    }

    private bool ApplyTargetPlacement(
        JsonObject roots,
        JsonObject requestedParent,
        JsonObject folder,
        string now,
        Counters counters)
    {
        if (ReferenceEquals(folder, requestedParent) || IsDescendant(folder, requestedParent))
        {
            throw new InvalidDataException("A Cloudig bookmark folder cannot be moved inside itself.");
        }
        if (!TryFindParent(roots, folder, out var currentParent))
        {
            throw new InvalidDataException("The managed Cloudig bookmark folder has no valid Chrome parent.");
        }

        var changed = false;
        if (!ReferenceEquals(currentParent, requestedParent))
        {
            RemoveChild(currentParent, folder);
            InsertChild(requestedParent, folder, _target.PlaceFirst);
            currentParent["date_modified"] = now;
            requestedParent["date_modified"] = now;
            changed = true;
        }
        else if (_target.PlaceFirst)
        {
            changed |= MoveFolderFirst(requestedParent, folder, now);
        }
        changed |= SetIfDifferent(folder, "name", _target.FolderName);
        if (changed) counters.Updated += 1;
        return changed;
    }

    private static bool MoveFolderFirst(JsonObject parent, JsonObject folder, string now)
    {
        var children = BookmarkJson.RequiredArray(parent, "children");
        var index = IndexOfReference(children, folder);
        if (index <= 0) return false;
        children.RemoveAt(index);
        children.Insert(0, folder);
        parent["date_modified"] = now;
        return true;
    }

    private static bool TryFindParent(JsonObject roots, JsonObject target, out JsonObject parent)
    {
        foreach (var rootName in RootNames)
        {
            var root = BookmarkJson.RequiredObject(roots, rootName);
            var stack = new Stack<JsonObject>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var candidate = stack.Pop();
                foreach (var child in DirectChildren(candidate))
                {
                    if (ReferenceEquals(child, target))
                    {
                        parent = candidate;
                        return true;
                    }
                    if (BookmarkJson.RequiredString(child, "type") == "folder") stack.Push(child);
                }
            }
        }
        parent = null!;
        return false;
    }

    private static bool IsDescendant(JsonObject ancestor, JsonObject possibleDescendant)
    {
        var stack = new Stack<JsonObject>();
        stack.Push(ancestor);
        while (stack.Count > 0)
        {
            foreach (var child in DirectChildren(stack.Pop()))
            {
                if (ReferenceEquals(child, possibleDescendant)) return true;
                if (BookmarkJson.RequiredString(child, "type") == "folder") stack.Push(child);
            }
        }
        return false;
    }

    private static IEnumerable<JsonObject> DirectChildren(JsonObject folder)
    {
        if (BookmarkJson.RequiredString(folder, "type") != "folder") yield break;
        foreach (var raw in BookmarkJson.RequiredArray(folder, "children"))
        {
            if (raw is not JsonObject child) throw new InvalidDataException("Chrome bookmark children must be objects.");
            yield return child;
        }
    }

    private static string FolderGuid(JsonObject folder) => BookmarkJson.RequiredString(folder, "guid");

    private static void StripManagedFolderMetadata(JsonObject folder)
    {
        if (folder["meta_info"] is not JsonObject meta) return;
        foreach (var key in new[] { FolderTag, SetVersionTag, InstallationTag, LegacyFolderTag, LegacySetVersionTag }) meta.Remove(key);
        if (meta.Count == 0) folder.Remove("meta_info");
    }

    private static int IndexOfReference(JsonArray children, JsonObject target)
    {
        for (var index = 0; index < children.Count; index++)
        {
            if (ReferenceEquals(children[index], target)) return index;
        }
        return -1;
    }

    private static void RemoveChild(JsonObject parent, JsonObject child)
    {
        var children = BookmarkJson.RequiredArray(parent, "children");
        var index = IndexOfReference(children, child);
        if (index < 0) throw new InvalidDataException("Chrome bookmark parent does not contain the expected child.");
        children.RemoveAt(index);
    }

    private static void InsertChild(JsonObject parent, JsonObject child, bool first)
    {
        var children = BookmarkJson.RequiredArray(parent, "children");
        if (first) children.Insert(0, child);
        else children.Add(child);
    }

    private static void ValidateDocument(JsonObject document)
    {
        if (document["version"] is not JsonValue version || !version.TryGetValue<int>(out var value) || value != 1)
        {
            throw new InvalidDataException("Cloudig supports Chrome Bookmarks version 1 only.");
        }
        var roots = BookmarkJson.RequiredObject(document, "roots");
        foreach (var rootName in RootNames)
        {
            if (BookmarkJson.RequiredString(BookmarkJson.RequiredObject(roots, rootName), "type") != "folder")
            {
                throw new InvalidDataException($"Chrome permanent root is not a folder: {rootName}");
            }
        }
        foreach (var property in roots)
        {
            if (!RootNames.Contains(property.Key, StringComparer.Ordinal)) throw new InvalidDataException($"Unknown Chrome permanent root: {property.Key}");
        }
    }

    private static IEnumerable<JsonObject> EnumerateAllNodes(JsonObject roots)
    {
        var stack = new Stack<(JsonObject Node, int Depth)>();
        for (var index = RootNames.Length - 1; index >= 0; index--) stack.Push((BookmarkJson.RequiredObject(roots, RootNames[index]), 0));
        var count = 0;
        while (stack.Count > 0)
        {
            var (node, depth) = stack.Pop();
            if (depth > 256 || ++count > 1_000_000) throw new InvalidDataException("Chrome Bookmarks exceeds Cloudig safety limits.");
            yield return node;
            if (BookmarkJson.RequiredString(node, "type") != "folder") continue;
            var children = BookmarkJson.RequiredArray(node, "children");
            for (var index = children.Count - 1; index >= 0; index--)
            {
                if (children[index] is not JsonObject child) throw new InvalidDataException("Chrome bookmark children must be objects.");
                stack.Push((child, depth + 1));
            }
        }
    }

    private static long FindMaximumId(IEnumerable<JsonObject> nodes)
    {
        var maximum = 0L;
        foreach (var node in nodes)
        {
            if (long.TryParse(BookmarkJson.RequiredString(node, "id"), NumberStyles.None, CultureInfo.InvariantCulture, out var value)) maximum = Math.Max(maximum, value);
        }
        return maximum;
    }

    private static JsonObject NewFolder(string id, string name, string installationId, string now)
    {
        var meta = new JsonObject { [FolderTag] = "1" };
        if (!string.IsNullOrWhiteSpace(installationId)) meta[InstallationTag] = installationId;
        return new JsonObject
        {
            ["children"] = new JsonArray(),
            ["date_added"] = now,
            ["date_last_used"] = "0",
            ["date_modified"] = now,
            ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
            ["id"] = id,
            ["meta_info"] = meta,
            ["name"] = name,
            ["type"] = "folder"
        };
    }

    private static JsonObject NewBookmark(
        string id,
        BookmarkDefinition definition,
        string effectiveProfile,
        string installationId,
        string now)
    {
        var title = DefaultTitle(definition, effectiveProfile);
        var meta = new JsonObject
        {
            [ManagedTag] = "1",
            [IdTag] = definition.VariantId,
            [VersionTag] = definition.Version,
            [HashTag] = definition.Sha256,
            [ProfileTag] = effectiveProfile,
            [DefaultTitleTag] = title
        };
        if (!string.IsNullOrWhiteSpace(installationId)) meta[InstallationTag] = installationId;
        return new JsonObject
        {
            ["date_added"] = now,
            ["date_last_used"] = "0",
            ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
            ["id"] = id,
            ["meta_info"] = meta,
            ["name"] = title,
            ["type"] = "url",
            ["url"] = definition.Url
        };
    }

    private static JsonObject GetOrCreateMeta(JsonObject node)
    {
        if (node["meta_info"] is JsonObject meta) return meta;
        meta = new JsonObject();
        node["meta_info"] = meta;
        return meta;
    }

    private static bool IsManagedFolder(JsonObject node)
    {
        if (BookmarkJson.RequiredString(node, "type") != "folder" || node["meta_info"] is not JsonObject meta) return false;
        return MetaValue(meta, FolderTag, LegacyFolderTag) == "1";
    }

    private static bool IsManagedBookmark(JsonObject node)
    {
        if (BookmarkJson.RequiredString(node, "type") != "url" || node["meta_info"] is not JsonObject meta) return false;
        return MetaValue(meta, ManagedTag, LegacyManagedTag) == "1";
    }

    private static string ManagedVariantId(JsonObject node)
    {
        var meta = BookmarkJson.RequiredObject(node, "meta_info");
        var id = MetaValue(meta, IdTag, LegacyIdTag)
                 ?? throw new InvalidDataException("A managed Cloudig bookmark is missing its stable id.");
        return id.Contains(':')
            ? id
            : $"{id}:{InstalledProfile(meta)}";
    }

    private static bool EquivalentBookmarkUrl(string installed, string bundled) =>
        installed.StartsWith("javascript:", StringComparison.Ordinal)
        && bundled.StartsWith("javascript:", StringComparison.Ordinal)
        && (installed == bundled || Uri.UnescapeDataString(installed) == Uri.UnescapeDataString(bundled));

    private static string? MetaValue(JsonObject meta, string current, string legacy) =>
        BookmarkJson.OptionalString(meta, current) ?? BookmarkJson.OptionalString(meta, legacy);

    private static string InstalledProfile(JsonObject meta)
    {
        var profile = BookmarkJson.OptionalString(meta, ProfileTag);
        if (!string.IsNullOrWhiteSpace(profile)) return profile;
        // Version 0.1 managed only the lightweight 11-item set and had no profile tag.
        return MetaValue(meta, ManagedTag, LegacyManagedTag) == "1"
            ? BookmarkProfiles.Light
            : string.Empty;
    }

    private static bool MigrateMeta(JsonObject meta, string current, string legacy, string value)
    {
        var changed = SetIfDifferent(meta, current, value);
        if (meta.Remove(legacy)) changed = true;
        return changed;
    }

    private static string DefaultTitle(BookmarkDefinition definition, string effectiveProfile)
        => BookmarkDisplayName.Format(definition.Label, effectiveProfile, definition.Version);

    private static string PreviousProfileTitle(BookmarkDefinition definition, string effectiveProfile)
    {
        var profile = effectiveProfile switch
        {
            BookmarkProfiles.Light => "轻量",
            BookmarkProfiles.Full => "全量",
            BookmarkProfiles.AllBranches => "整树",
            _ => throw new InvalidDataException($"Unknown Cloudig bookmark profile title: {effectiveProfile}")
        };
        const string suffix = "-Cloudig";
        return definition.TitleZh.EndsWith(suffix, StringComparison.Ordinal)
            ? $"{definition.TitleZh[..^suffix.Length]}（{profile}）{suffix}"
            : $"{definition.TitleZh}（{profile}）";
    }

    private static bool IsKnownPreviousDefaultTitle(string title, BookmarkDefinition definition) =>
        title == $"保存 {definition.Label} 会话"
        || title == $"Save {definition.Label} conversation"
        || title == definition.TitleZh
        || title == definition.TitleEn
        || BookmarkProfiles.All.Any(profile => title == PreviousProfileTitle(definition, profile));

    private static bool SetIfDifferent(JsonObject target, string key, string value)
    {
        if (BookmarkJson.OptionalString(target, key) == value) return false;
        target[key] = value;
        return true;
    }

    private static void AppendChild(JsonObject parent, JsonObject child) => BookmarkJson.RequiredArray(parent, "children").Add((JsonNode)child);

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
