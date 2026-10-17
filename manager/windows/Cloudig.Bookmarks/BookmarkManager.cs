using System.Text.Json.Nodes;

namespace Cloudig.Bookmarks;

public sealed class BookmarkManager
{
    private readonly string _manifestPath;
    private readonly string _artifactRoot;
    private readonly string _backupRoot;
    private readonly string _userDataDirectory;
    private readonly string? _changelogPath;

    public BookmarkManager(
        string manifestPath,
        string artifactRoot,
        string backupRoot,
        string? userDataDirectory = null,
        string? changelogPath = null)
    {
        _manifestPath = Path.GetFullPath(manifestPath);
        _artifactRoot = Path.GetFullPath(artifactRoot);
        _backupRoot = Path.GetFullPath(backupRoot);
        _userDataDirectory = Path.GetFullPath(userDataDirectory ?? ChromeProfileDiscovery.DefaultUserDataDirectory);
        _changelogPath = string.IsNullOrWhiteSpace(changelogPath) ? null : Path.GetFullPath(changelogPath);
    }

    // Compatibility entry point: null is expanded internally to the package's 12-platform default profile.
    public Task<BookmarkManagerSummary> SummarizeAsync(CancellationToken cancellationToken = default) =>
        SummarizeCoreAsync(null, null, cancellationToken);

    public Task<BookmarkManagerSummary> SummarizeAsync(
        string requestedProfile,
        CancellationToken cancellationToken = default) =>
        SummarizeCoreAsync(requestedProfile, null, cancellationToken);

    public Task<BookmarkManagerSummary> SummarizeAsync(
        string requestedProfile,
        BookmarkInstallTarget target,
        CancellationToken cancellationToken = default) =>
        SummarizeCoreAsync(requestedProfile, target, cancellationToken);

    private async Task<BookmarkManagerSummary> SummarizeCoreAsync(
        string? requestedProfile,
        BookmarkInstallTarget? target,
        CancellationToken cancellationToken)
    {
        var package = await BookmarkPackageLoader.LoadAsync(_manifestPath, _artifactRoot, cancellationToken);
        var selection = package.Resolve(requestedProfile);
        var changelog = BookmarkChangelog.Empty;
        var changelogError = string.Empty;
        if (_changelogPath is not null)
        {
            try
            {
                changelog = await BookmarkChangelog.LoadAsync(_changelogPath, package.Platforms, cancellationToken);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or ArgumentException)
            {
                changelogError = FirstLine(error);
            }
        }
        var profiles = ChromeProfileDiscovery.Discover(_userDataDirectory);
        var statuses = new List<BookmarkStoreStatus>();
        foreach (var store in profiles.SelectMany(profile => profile.Stores))
        {
            try
            {
                var json = ChromeProfileDiscovery.DecodeUtf8(ChromeProfileDiscovery.ReadAllBytesShared(store.Path));
                var editor = new BookmarkFileEditor(
                    package,
                    requestedProfile: selection.RequestedProfile,
                    target: TargetForStore(target, store.Path));
                var inspection = editor.Inspect(json);
                statuses.Add(new BookmarkStoreStatus(
                    store,
                    inspection.Status,
                    inspection.ManagedCount,
                    inspection.SetVersion,
                    string.Empty,
                    inspection.Bookmarks));
            }
            catch (Exception error)
            {
                statuses.Add(new BookmarkStoreStatus(
                    store,
                    "invalid",
                    0,
                    string.Empty,
                    FirstLine(error),
                    selection.Bookmarks.Select(item => new BookmarkEntryInspection(
                        item.Id,
                        "invalid",
                        string.Empty,
                        item.RequestedProfile,
                        item.EffectiveProfile,
                        item.Fallback,
                        string.Empty)).ToArray()));
            }
        }
        var catalog = selection.Bookmarks.Select(item =>
        {
            var installedVersions = statuses
                .SelectMany(status => status.Bookmarks)
                .Where(installed => installed.Id.Equals(item.Id, StringComparison.Ordinal)
                                    && installed.InstalledProfile.Equals(item.EffectiveProfile, StringComparison.Ordinal))
                .Select(installed => installed.Version)
                .Where(version => !string.IsNullOrWhiteSpace(version))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var upgradeNotes = changelog.GetUpgradeNotes(
                item.Id,
                item.EffectiveProfile,
                installedVersions,
                item.Definition.Version);
            return new BookmarkCatalogEntry(
                item.Id,
                item.Definition.Label,
                item.Definition.TitleZh,
                item.Definition.TitleEn,
                item.Definition.Version,
                item.RequestedProfile,
                item.EffectiveProfile,
                item.Fallback,
                upgradeNotes);
        }).ToArray();

        return new BookmarkManagerSummary(
            "Google Chrome",
            _userDataDirectory,
            package.BookmarkSetVersion,
            selection.RequestedProfile,
            package.DefaultProfile,
            package.Profiles,
            ChromeProfileDiscovery.IsChromeRunning(),
            changelogError,
            catalog,
            profiles,
            statuses);
    }

    public Task<BookmarkTargetContext> DescribeTargetAsync(
        string storePath,
        BookmarkInstallTarget target,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var store = ResolveStore(storePath);
        var json = ChromeProfileDiscovery.DecodeUtf8(ChromeProfileDiscovery.ReadAllBytesShared(store.Path));
        var document = BookmarkJson.ParseObject(json);
        ChromeBookmarkChecksums.AssertValid(document);
        return Task.FromResult(DescribeTarget(document, TargetForStore(target, store.Path)));
    }

    public Task<string> ReadSourceAsync(
        string bookmarkId,
        CancellationToken cancellationToken = default) =>
        ReadSourceCoreAsync(bookmarkId, null, cancellationToken);

    public Task<string> ReadSourceAsync(
        string bookmarkId,
        string requestedProfile,
        CancellationToken cancellationToken = default) =>
        ReadSourceCoreAsync(bookmarkId, requestedProfile, cancellationToken);

    private async Task<string> ReadSourceCoreAsync(
        string bookmarkId,
        string? requestedProfile,
        CancellationToken cancellationToken)
    {
        var package = await BookmarkPackageLoader.LoadAsync(_manifestPath, _artifactRoot, cancellationToken);
        var bookmark = package.Resolve(requestedProfile).Bookmarks
            .FirstOrDefault(item => item.Id.Equals(bookmarkId, StringComparison.Ordinal));
        if (bookmark is null) throw new InvalidOperationException("Cloudig received an unknown bookmark id.");
        return bookmark.Definition.Url;
    }

    // Compatibility entry point. selectedBookmarkIds == null deliberately expands to the
    // 12 platform ids; it never expands to the 32 variant ids.
    public async Task<BookmarkTransactionResult> ExecuteAsync(
        IEnumerable<string> selectedStorePaths,
        BookmarkOperation operation,
        IEnumerable<string>? selectedBookmarkIds = null,
        bool requireChromeClosed = true,
        DateTime? utcNow = null,
        Action<int, BookmarkStore>? beforeWriteForTests = null,
        CancellationToken cancellationToken = default)
    {
        var package = await BookmarkPackageLoader.LoadAsync(_manifestPath, _artifactRoot, cancellationToken);
        var platformIds = selectedBookmarkIds?.ToArray()
                          ?? package.Platforms.Select(item => item.Id).ToArray();
        return await ExecuteCoreAsync(
            package,
            selectedStorePaths,
            operation,
            package.DefaultProfile,
            platformIds,
            requireChromeClosed,
            utcNow,
            beforeWriteForTests,
            null);
    }

    public async Task<BookmarkTransactionResult> ExecuteAsync(
        IEnumerable<string> selectedStorePaths,
        BookmarkOperation operation,
        string requestedProfile,
        IEnumerable<string> selectedPlatformIds,
        bool requireChromeClosed = true,
        DateTime? utcNow = null,
        Action<int, BookmarkStore>? beforeWriteForTests = null,
        CancellationToken cancellationToken = default)
    {
        var package = await BookmarkPackageLoader.LoadAsync(_manifestPath, _artifactRoot, cancellationToken);
        return await ExecuteCoreAsync(
            package,
            selectedStorePaths,
            operation,
            requestedProfile,
            selectedPlatformIds,
            requireChromeClosed,
            utcNow,
            beforeWriteForTests,
            null);
    }

    public async Task<BookmarkTransactionResult> ExecuteAsync(
        IEnumerable<string> selectedStorePaths,
        BookmarkOperation operation,
        string requestedProfile,
        IEnumerable<string> selectedPlatformIds,
        BookmarkInstallTarget target,
        bool requireChromeClosed = true,
        DateTime? utcNow = null,
        Action<int, BookmarkStore>? beforeWriteForTests = null,
        CancellationToken cancellationToken = default)
    {
        var package = await BookmarkPackageLoader.LoadAsync(_manifestPath, _artifactRoot, cancellationToken);
        return await ExecuteCoreAsync(
            package,
            selectedStorePaths,
            operation,
            requestedProfile,
            selectedPlatformIds,
            requireChromeClosed,
            utcNow,
            beforeWriteForTests,
            target);
    }

    private Task<BookmarkTransactionResult> ExecuteCoreAsync(
        BookmarkPackage package,
        IEnumerable<string> selectedStorePaths,
        BookmarkOperation operation,
        string requestedProfile,
        IEnumerable<string> selectedPlatformIds,
        bool requireChromeClosed,
        DateTime? utcNow,
        Action<int, BookmarkStore>? beforeWriteForTests,
        BookmarkInstallTarget? target)
    {
        if (requireChromeClosed && ChromeProfileDiscovery.IsChromeRunning())
        {
            throw new InvalidOperationException("Please close every Google Chrome window before Cloudig changes bookmarks.");
        }
        var discovered = ChromeProfileDiscovery.Discover(_userDataDirectory)
            .SelectMany(profile => profile.Stores)
            .ToDictionary(store => Normalize(store.Path), StringComparer.OrdinalIgnoreCase);
        var selectedStores = (selectedStorePaths ?? Array.Empty<string>())
            .Select(Normalize)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(path => discovered.TryGetValue(path, out var store)
                ? store
                : throw new InvalidOperationException("Cloudig will change only a Chrome bookmark store discovered in the current profile list."))
            .ToArray();
        if (selectedStores.Length == 0) throw new InvalidOperationException("Select at least one Chrome bookmark store.");

        var selection = package.Resolve(requestedProfile);
        var requestedIds = (selectedPlatformIds ?? Array.Empty<string>())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (requestedIds.Length == 0)
        {
            throw new InvalidOperationException("Select at least one Cloudig bookmark platform.");
        }
        var availableIds = selection.Bookmarks.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        var unknown = requestedIds.Where(item => !availableIds.Contains(item)).Order(StringComparer.Ordinal).ToArray();
        if (unknown.Length > 0)
        {
            throw new InvalidOperationException($"Cloudig received unknown bookmark platform ids: {string.Join(", ", unknown)}");
        }

        if (selectedStores.Length > 1 && target is not null)
        {
            throw new InvalidOperationException("A configured Cloudig bookmark folder belongs to exactly one Chrome bookmark store.");
        }
        var transaction = new BookmarkTransaction(
            new BookmarkFileEditor(
                package,
                selectedBookmarkIds: requestedIds,
                requestedProfile: selection.RequestedProfile,
                target: TargetForStore(target, selectedStores[0].Path)),
            _backupRoot)
        {
            BeforeWriteForTests = beforeWriteForTests
        };
        return Task.FromResult(transaction.Execute(
            selectedStores,
            operation,
            utcNow ?? DateTime.UtcNow));
    }

    private BookmarkStore ResolveStore(string storePath)
    {
        var normalized = Normalize(storePath);
        return ChromeProfileDiscovery.Discover(_userDataDirectory)
                   .SelectMany(profile => profile.Stores)
                   .FirstOrDefault(store => Normalize(store.Path).Equals(normalized, StringComparison.OrdinalIgnoreCase))
               ?? throw new InvalidOperationException("Cloudig will inspect only a Chrome bookmark store discovered in the current profile list.");
    }

    private static BookmarkInstallTarget TargetForStore(BookmarkInstallTarget? target, string storePath)
    {
        var normalizedStore = Normalize(storePath);
        if (target is null
            || (!string.IsNullOrWhiteSpace(target.StorePath)
                && !Normalize(target.StorePath).Equals(normalizedStore, StringComparison.OrdinalIgnoreCase)))
        {
            return BookmarkInstallTarget.Default(normalizedStore);
        }
        return target with { StorePath = normalizedStore };
    }

    private static BookmarkTargetContext DescribeTarget(JsonObject document, BookmarkInstallTarget target)
    {
        var roots = BookmarkJson.RequiredObject(document, "roots");
        var rows = new List<(JsonObject Node, JsonObject? Parent, string Path, int Depth)>();
        foreach (var rootName in new[] { "bookmark_bar", "other" })
        {
            var root = BookmarkJson.RequiredObject(roots, rootName);
            CollectFolders(root, null, BookmarkJson.RequiredString(root, "name"), 0, rows);
        }

        var bookmarkBar = BookmarkJson.RequiredObject(roots, "bookmark_bar");
        var parentGuid = string.IsNullOrWhiteSpace(target.ParentGuid)
            ? BookmarkJson.RequiredString(bookmarkBar, "guid")
            : target.ParentGuid;
        var managed = string.IsNullOrWhiteSpace(target.ManagedFolderGuid)
            ? null
            : rows.Select(row => row.Node).FirstOrDefault(node =>
                BookmarkJson.RequiredString(node, "guid").Equals(target.ManagedFolderGuid, StringComparison.OrdinalIgnoreCase));
        var blocked = managed is null
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : DescendantFolderGuids(managed);
        if (managed is not null) blocked.Add(BookmarkJson.RequiredString(managed, "guid"));

        var options = rows.Select(row => new BookmarkFolderOption(
            BookmarkJson.RequiredString(row.Node, "guid"),
            BookmarkJson.RequiredString(row.Node, "name"),
            row.Path,
            row.Depth,
            !blocked.Contains(BookmarkJson.RequiredString(row.Node, "guid")))).ToArray();

        var selectedParent = rows.FirstOrDefault(row =>
            BookmarkJson.RequiredString(row.Node, "guid").Equals(parentGuid, StringComparison.OrdinalIgnoreCase));
        if (selectedParent.Node is null)
        {
            selectedParent = rows.First(row => ReferenceEquals(row.Node, bookmarkBar));
            parentGuid = BookmarkJson.RequiredString(bookmarkBar, "guid");
        }

        var exists = managed is not null && FolderMatchesInstallation(managed, target.InstallationId);
        var effective = target with { ParentGuid = parentGuid };
        string displayPath;
        if (exists && !target.PlacementPending)
        {
            var actual = rows.First(row => ReferenceEquals(row.Node, managed));
            effective = effective with
            {
                ParentGuid = actual.Parent is null ? parentGuid : BookmarkJson.RequiredString(actual.Parent, "guid"),
                FolderName = BookmarkJson.RequiredString(managed!, "name")
            };
            displayPath = actual.Path;
        }
        else
        {
            displayPath = $"{selectedParent.Path} / {effective.FolderName}";
        }
        return new BookmarkTargetContext(effective, displayPath, exists, options);
    }

    private static bool FolderMatchesInstallation(JsonObject folder, string installationId)
    {
        if (folder["meta_info"] is not JsonObject meta) return false;
        if (string.IsNullOrWhiteSpace(installationId))
        {
            return BookmarkJson.OptionalString(meta, "cloudig_folder") == "1"
                   || BookmarkJson.OptionalString(meta, "ai_chat_archive_folder") == "1";
        }
        return BookmarkJson.OptionalString(meta, "cloudig_installation_id") == installationId;
    }

    private static void CollectFolders(
        JsonObject folder,
        JsonObject? parent,
        string path,
        int depth,
        ICollection<(JsonObject Node, JsonObject? Parent, string Path, int Depth)> rows)
    {
        if (depth > 256 || rows.Count > 100_000) throw new InvalidDataException("Chrome bookmark folders exceed Cloudig safety limits.");
        rows.Add((folder, parent, path, depth));
        foreach (var child in BookmarkJson.RequiredArray(folder, "children").OfType<JsonObject>())
        {
            if (BookmarkJson.RequiredString(child, "type") != "folder") continue;
            CollectFolders(child, folder, $"{path} / {BookmarkJson.RequiredString(child, "name")}", depth + 1, rows);
        }
    }

    private static HashSet<string> DescendantFolderGuids(JsonObject folder)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<JsonObject>();
        stack.Push(folder);
        while (stack.Count > 0)
        {
            foreach (var child in BookmarkJson.RequiredArray(stack.Pop(), "children").OfType<JsonObject>())
            {
                if (BookmarkJson.RequiredString(child, "type") != "folder") continue;
                result.Add(BookmarkJson.RequiredString(child, "guid"));
                stack.Push(child);
            }
        }
        return result;
    }

    private static string Normalize(string value) =>
        Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static string FirstLine(Exception error) => error.Message
        .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .FirstOrDefault() ?? "Unknown Chrome bookmark error.";
}
