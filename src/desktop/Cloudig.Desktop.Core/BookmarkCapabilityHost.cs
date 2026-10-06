using System.Security.Cryptography;
using System.Text.Json;
using Cloudig.Bookmarks;

namespace Cloudig.Desktop.Core;

public enum BookmarkBrowserState
{
    Closed,
    Open,
    Unknown
}

public sealed class BookmarkCapabilityException : Exception
{
    public BookmarkCapabilityException(string code, string message, Exception? inner = null) : base(message, inner)
    {
        Code = code;
    }

    public string Code { get; }
}

public sealed record BookmarkStoreView(string Capability, string Label, string Kind, bool Selected);
public sealed record BookmarkFolderView(string Capability, string Name, string Path, int Depth, bool Selectable, bool Selected);
public sealed record BookmarkTargetView(
    string Store,
    string Parent,
    string DisplayPath,
    string FolderName,
    bool PlaceFirst,
    bool Exists,
    IReadOnlyList<BookmarkFolderView> Folders);
public sealed record BookmarkPlatformView(
    string Id,
    string Label,
    string Version,
    string RequestedProfile,
    string EffectiveProfile,
    bool Fallback,
    string Status,
    string InstalledVersion,
    IReadOnlyList<BookmarkUpgradeNote> UpgradeNotes);
public sealed record BookmarkShellSummary(
    string BookmarkSetVersion,
    string RequestedProfile,
    string BrowserState,
    string ChangelogError,
    BookmarkTargetView? Target,
    IReadOnlyList<BookmarkStoreView> Stores,
    IReadOnlyList<BookmarkPlatformView> Platforms);
public sealed record BookmarkShellMutation(int Added, int Updated, int Removed, BookmarkShellSummary Summary);

public sealed class BookmarkCapabilityHost
{
    private readonly BookmarkManager _manager;
    private readonly CloudigDeviceSettingsStore _settings;
    private readonly Func<BookmarkBrowserState> _browserState;
    private readonly string _userDataDirectory;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, string> _stores = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _folders = new(StringComparer.Ordinal);
    private readonly string _sessionInstallationId = Guid.NewGuid().ToString("D").ToLowerInvariant();

    public BookmarkCapabilityHost(
        string manifestPath,
        string artifactRoot,
        string backupRoot,
        string settingsFile,
        string? userDataDirectory = null,
        string? changelogPath = null,
        Func<BookmarkBrowserState>? browserState = null)
        : this(
            manifestPath,
            artifactRoot,
            backupRoot,
            new CloudigDeviceSettingsStore(settingsFile),
            userDataDirectory,
            changelogPath,
            browserState)
    {
    }

    public BookmarkCapabilityHost(
        string manifestPath,
        string artifactRoot,
        string backupRoot,
        CloudigDeviceSettingsStore settingsStore,
        string? userDataDirectory = null,
        string? changelogPath = null,
        Func<BookmarkBrowserState>? browserState = null)
    {
        _userDataDirectory = Path.GetFullPath(userDataDirectory ?? ChromeProfileDiscovery.DefaultUserDataDirectory);
        _manager = new BookmarkManager(manifestPath, artifactRoot, backupRoot, _userDataDirectory, changelogPath);
        _settings = settingsStore;
        _browserState = browserState ?? DetectBrowserState;
    }

    public async Task<BookmarkShellSummary> QueryAsync(string profile, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try { return await QueryCoreAsync(NormalizeProfile(profile), cancellationToken); }
        finally { _gate.Release(); }
    }

    public async Task<BookmarkShellSummary> QueryTargetAsync(string profile, string storeCapability, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var storePath = Resolve(_stores, storeCapability, "CLOUDIG_BOOKMARK_STORE_STALE", "Chrome profile selection is stale.");
            return await QueryCoreAsync(NormalizeProfile(profile), cancellationToken, storePath);
        }
        finally { _gate.Release(); }
    }

    public async Task<BookmarkShellSummary> SaveTargetAsync(
        string profile,
        string storeCapability,
        string parentCapability,
        string folderName,
        bool placeFirst,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var storePath = Resolve(_stores, storeCapability, "CLOUDIG_BOOKMARK_STORE_STALE", "Chrome profile selection is stale.");
            var parentGuid = Resolve(_folders, parentCapability, "CLOUDIG_BOOKMARK_FOLDER_STALE", "Chrome bookmark folder selection is stale.");
            var current = await LoadSettingsAsync(cancellationToken);
            var sameStore = SamePath(current.StorePath, storePath);
            var next = current with
            {
                StorePath = storePath,
                ParentGuid = parentGuid,
                FolderName = folderName,
                PlaceFirst = placeFirst,
                InstallationId = string.IsNullOrEmpty(current.InstallationId) ? _sessionInstallationId : current.InstallationId,
                ManagedFolderGuid = sameStore ? current.ManagedFolderGuid : string.Empty,
                PlacementPending = true
            };
            await _settings.SaveAsync(next, cancellationToken);
            return await QueryCoreAsync(NormalizeProfile(profile), cancellationToken);
        }
        finally { _gate.Release(); }
    }

    public async Task<string> ReadSourceAsync(string platform, string profile, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await _manager.ReadSourceAsync(NormalizePlatform(platform), NormalizeProfile(profile), cancellationToken);
        }
        catch (BookmarkCapabilityException) { throw; }
        catch (Exception error) { throw Wrap(error); }
        finally { _gate.Release(); }
    }

    public Task<BookmarkShellMutation> InstallAsync(
        string profile,
        IEnumerable<string> platforms,
        CancellationToken cancellationToken = default) =>
        MutateAsync(BookmarkOperation.InstallOrRepair, profile, platforms, cancellationToken);

    public Task<BookmarkShellMutation> RemoveAsync(
        string profile,
        IEnumerable<string> platforms,
        CancellationToken cancellationToken = default) =>
        MutateAsync(BookmarkOperation.Remove, profile, platforms, cancellationToken);

    private async Task<BookmarkShellMutation> MutateAsync(
        BookmarkOperation operation,
        string profile,
        IEnumerable<string> platforms,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            RequireClosedBrowser();
            var normalizedProfile = NormalizeProfile(profile);
            var selectedPlatforms = platforms.Select(NormalizePlatform).Distinct(StringComparer.Ordinal).ToArray();
            if (selectedPlatforms.Length is < 1 or > 12)
            {
                throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_SELECTION_INVALID", "Select between one and twelve bookmark platforms.");
            }
            var snapshot = await PrepareAsync(normalizedProfile, cancellationToken);
            if (snapshot.SelectedStore is null || snapshot.Target is null)
            {
                throw new BookmarkCapabilityException("CLOUDIG_CHROME_PROFILE_MISSING", "No writable Chrome bookmark profile is available.");
            }
            // Chrome must never receive an installation ID that only lives in
            // this process. Persist its target first so a later settings failure
            // or restart can recognize the already-written folder on retry.
            var prepared = snapshot.Settings with
            {
                StorePath = snapshot.SelectedStore.Path,
                ParentGuid = snapshot.Target.ParentGuid,
                FolderName = snapshot.Target.FolderName,
                PlaceFirst = snapshot.Target.PlaceFirst,
                InstallationId = snapshot.Target.InstallationId,
                ManagedFolderGuid = snapshot.Target.ManagedFolderGuid,
                PlacementPending = snapshot.Target.PlacementPending
            };
            if (prepared != snapshot.Settings) await _settings.SaveAsync(prepared, cancellationToken);
            var result = await _manager.ExecuteAsync(
                [snapshot.SelectedStore.Path],
                operation,
                normalizedProfile,
                selectedPlatforms,
                snapshot.Target,
                requireChromeClosed: false,
                cancellationToken: cancellationToken);
            var managedFolderGuid = result.Stores.Single().Mutation.ManagedFolderGuid;
            var saved = prepared with
            {
                ManagedFolderGuid = managedFolderGuid,
                PlacementPending = false
            };
            try
            {
                if (saved != prepared) await _settings.SaveAsync(saved, cancellationToken);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED",
                    "Chrome bookmarks were updated, but Cloudig could not finish saving the installation settings. Retry the same operation to complete them.", error);
            }
            return new BookmarkShellMutation(
                result.AddedCount,
                result.UpdatedCount,
                result.RemovedCount,
                await QueryCoreAsync(normalizedProfile, cancellationToken));
        }
        catch (BookmarkCapabilityException) { throw; }
        catch (Exception error) { throw Wrap(error); }
        finally { _gate.Release(); }
    }

    private async Task<BookmarkShellSummary> QueryCoreAsync(string profile, CancellationToken cancellationToken, string? preferredStorePath = null)
    {
        try
        {
            var snapshot = await PrepareAsync(profile, cancellationToken, preferredStorePath);
            _stores.Clear();
            _folders.Clear();
            var storeViews = new List<BookmarkStoreView>();
            foreach (var store in snapshot.Stores)
            {
                var capability = Capability("bs_");
                _stores.Add(capability, store.Path);
                storeViews.Add(new BookmarkStoreView(
                    capability,
                    $"{store.ProfileDisplayName} · {(store.Kind == "account" ? "Chrome Account" : "Chrome Local")}",
                    store.Kind,
                    snapshot.SelectedStore is not null && SamePath(snapshot.SelectedStore.Path, store.Path)));
            }

            BookmarkTargetView? targetView = null;
            if (snapshot.SelectedStore is not null && snapshot.Target is not null)
            {
                var targetContext = await _manager.DescribeTargetAsync(snapshot.SelectedStore.Path, snapshot.Target, cancellationToken);
                var storeCapability = storeViews.Single(item => item.Selected).Capability;
                var folderViews = new List<BookmarkFolderView>();
                var parentCapability = string.Empty;
                // Discovery already enforces the bookmark-tree capacity. Do
                // not make valid later folders unreachable in the only chooser.
                foreach (var folder in targetContext.Folders)
                {
                    var capability = Capability("bf_");
                    _folders.Add(capability, folder.Guid);
                    var selected = folder.Guid.Equals(targetContext.Target.ParentGuid, StringComparison.OrdinalIgnoreCase);
                    if (selected) parentCapability = capability;
                    folderViews.Add(new BookmarkFolderView(capability, DisplayText(folder.Name, 160), DisplayPath(folder.Path), folder.Depth, folder.Selectable, selected));
                }
                if (string.IsNullOrEmpty(parentCapability))
                {
                    throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_FOLDER_STALE", "The selected Chrome bookmark folder no longer exists.");
                }
                targetView = new BookmarkTargetView(
                    storeCapability,
                    parentCapability,
                    DisplayPath($"{snapshot.SelectedStore.ProfileDisplayName} / {targetContext.DisplayPath}"),
                    targetContext.Target.FolderName,
                    targetContext.Target.PlaceFirst,
                    targetContext.Exists,
                    folderViews);
            }

            var selectedStatus = snapshot.SelectedStore is null
                ? null
                : snapshot.Summary.Stores.FirstOrDefault(item => SamePath(item.Store.Path, snapshot.SelectedStore.Path));
            var platforms = snapshot.Summary.Bookmarks.Select(entry =>
            {
                var installed = selectedStatus?.Bookmarks.FirstOrDefault(item => item.Id == entry.Id);
                var status = selectedStatus is null ? "unavailable" : selectedStatus.Status == "invalid" ? "invalid" : installed?.Status ?? "missing";
                return new BookmarkPlatformView(
                    entry.Id,
                    entry.Label,
                    entry.Version,
                    DisplayProfile(entry.RequestedProfile),
                    DisplayProfile(entry.EffectiveProfile),
                    entry.Fallback,
                    status,
                    installed?.Version ?? string.Empty,
                    entry.UpgradeNotes.Take(3).ToArray());
            }).ToArray();
            return new BookmarkShellSummary(
                snapshot.Summary.BookmarkSetVersion,
                DisplayProfile(profile),
                BrowserStateText(SafeBrowserState()),
                snapshot.Summary.BookmarkChangelogError,
                targetView,
                storeViews,
                platforms);
        }
        catch (BookmarkCapabilityException) { throw; }
        catch (Exception error) { throw Wrap(error); }
    }

    private async Task<Prepared> PrepareAsync(string profile, CancellationToken cancellationToken, string? preferredStorePath = null)
    {
        var settings = await LoadSettingsAsync(cancellationToken);
        var discoveredProfiles = ChromeProfileDiscovery.Discover(_userDataDirectory);
        var stores = discoveredProfiles
            .OrderByDescending(item => item.IsLastUsed)
            .ThenBy(item => item.DirectoryName.Equals("Default", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .SelectMany(item => item.Stores.OrderBy(store => store.Kind == "account" ? 0 : 1))
            .ToArray();
        var selected = !string.IsNullOrWhiteSpace(preferredStorePath)
            ? stores.FirstOrDefault(store => SamePath(store.Path, preferredStorePath))
            : stores.FirstOrDefault(store => SamePath(store.Path, settings.StorePath)) ?? stores.FirstOrDefault();
        if (selected is null)
        {
            try
            {
                var emptySummary = await _manager.SummarizeAsync(profile, cancellationToken);
                return new Prepared(settings, emptySummary, stores, null, null);
            }
            catch (Exception error) { throw Wrap(error); }
        }
        var sameStore = SamePath(selected.Path, settings.StorePath);
        var target = new BookmarkInstallTarget(
            selected.Path,
            sameStore ? settings.ParentGuid : string.Empty,
            settings.FolderName,
            settings.PlaceFirst,
            string.IsNullOrEmpty(settings.InstallationId) ? _sessionInstallationId : settings.InstallationId,
            sameStore ? settings.ManagedFolderGuid : string.Empty,
            sameStore && settings.PlacementPending);
        BookmarkManagerSummary summary;
        try { summary = await _manager.SummarizeAsync(profile, target, cancellationToken); }
        catch (Exception error) { throw Wrap(error); }
        return new Prepared(settings, summary, stores, selected, target);
    }

    private async Task<BookmarkDeviceSettings> LoadSettingsAsync(CancellationToken cancellationToken)
    {
        try { return await _settings.LoadAsync(cancellationToken); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or JsonException)
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_SETTINGS_INVALID", "Cloudig bookmark settings are unavailable or use an unsupported version.", error);
        }
    }

    private void RequireClosedBrowser()
    {
        var state = SafeBrowserState();
        if (state == BookmarkBrowserState.Open)
        {
            throw new BookmarkCapabilityException("CLOUDIG_CHROME_OPEN", "Close every Google Chrome window before changing bookmarks.");
        }
        if (state == BookmarkBrowserState.Unknown)
        {
            throw new BookmarkCapabilityException("CLOUDIG_CHROME_STATE_UNKNOWN", "Cloudig could not verify that Chrome is closed, so no bookmark file was changed.");
        }
    }

    private BookmarkBrowserState SafeBrowserState()
    {
        try { return _browserState(); }
        catch { return BookmarkBrowserState.Unknown; }
    }

    private static BookmarkBrowserState DetectBrowserState()
    {
        try { return ChromeProfileDiscovery.IsChromeRunning() ? BookmarkBrowserState.Open : BookmarkBrowserState.Closed; }
        catch { return BookmarkBrowserState.Unknown; }
    }

    private static BookmarkCapabilityException Wrap(Exception error) => error switch
    {
        AggregateException => new("CLOUDIG_BOOKMARK_RECOVERY_REQUIRED", FirstLine(error), error),
        UnauthorizedAccessException => new("CLOUDIG_BOOKMARK_ACCESS_DENIED", "Chrome bookmark files are not writable.", error),
        FileNotFoundException => new("CLOUDIG_BOOKMARK_PACKAGE_MISSING", "Cloudig bookmark package or Chrome bookmark file is missing.", error),
        InvalidDataException => new("CLOUDIG_BOOKMARK_DATA_INVALID", FirstLine(error), error),
        ArgumentException => new("CLOUDIG_BOOKMARK_REQUEST_INVALID", FirstLine(error), error),
        IOException => new("CLOUDIG_BOOKMARK_IO_FAILED", FirstLine(error), error),
        _ => new("CLOUDIG_BOOKMARK_OPERATION_FAILED", "Cloudig could not complete the bookmark operation.", error)
    };

    private static string NormalizeProfile(string value) => value switch
    {
        "light" => BookmarkProfiles.Light,
        "full" => BookmarkProfiles.Full,
        "tree" or "all_branches" or "all-branches" => BookmarkProfiles.AllBranches,
        _ => throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_PROFILE_INVALID", "Cloudig received an unknown bookmark profile.")
    };

    private static string DisplayProfile(string value) => value == BookmarkProfiles.AllBranches ? "tree" : value;

    private static string NormalizePlatform(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32 || !value.All(character => char.IsAsciiLetterOrDigit(character) || character == '-'))
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_PLATFORM_INVALID", "Cloudig received an invalid bookmark platform.");
        }
        return value;
    }

    private static string Resolve(IReadOnlyDictionary<string, string> values, string capability, string code, string message) =>
        !string.IsNullOrWhiteSpace(capability) && values.TryGetValue(capability, out var value)
            ? value
            : throw new BookmarkCapabilityException(code, message);

    private static string Capability(string prefix)
    {
        var value = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return prefix + value;
    }

    private static bool SamePath(string left, string right) =>
        !string.IsNullOrWhiteSpace(left)
        && !string.IsNullOrWhiteSpace(right)
        && Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar).Equals(
            Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);

    private static string BrowserStateText(BookmarkBrowserState value) => value switch
    {
        BookmarkBrowserState.Closed => "closed",
        BookmarkBrowserState.Open => "open",
        _ => "unknown"
    };

    private static string FirstLine(Exception error) => error.Message
        .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .FirstOrDefault() ?? "Cloudig bookmark operation failed.";

    private static string DisplayPath(string value)
    {
        if (value.Length <= 300) return value;
        return $"{value[..120]} … {value[^160..]}";
    }

    private static string DisplayText(string value, int maximum) => value.Length <= maximum ? value : $"{value[..(maximum - 1)]}…";

    private sealed record Prepared(
        BookmarkDeviceSettings Settings,
        BookmarkManagerSummary Summary,
        IReadOnlyList<BookmarkStore> Stores,
        BookmarkStore? SelectedStore,
        BookmarkInstallTarget? Target);
}
