using System.Text.Json.Serialization;

namespace Cloudig.Bookmarks;

public static class BookmarkProfiles
{
    public const string Light = "light";
    public const string Full = "full";
    public const string AllBranches = "all_branches";

    public static readonly IReadOnlyList<string> All = [Light, Full, AllBranches];

    public static string Normalize(string? profile, string defaultProfile)
    {
        var value = string.IsNullOrWhiteSpace(profile) ? defaultProfile : profile.Trim();
        if (!All.Contains(value, StringComparer.Ordinal))
        {
            throw new ArgumentException($"Unknown Cloudig bookmark profile: {value}", nameof(profile));
        }
        return value;
    }
}

public sealed record BookmarkDefinition(
    string Id,
    string VariantId,
    string Profile,
    string Label,
    string TitleZh,
    string TitleEn,
    string Version,
    string Artifact,
    string Sha256,
    long Bytes,
    long Characters,
    string Url)
{
    // Compatibility for the isolated bookmark acceptance installer.
    public BookmarkDefinition(
        string id,
        string label,
        string titleZh,
        string titleEn,
        string version,
        string artifact,
        string sha256,
        long bytes,
        long characters,
        string url)
        : this(id, id, BookmarkProfiles.Light, label, titleZh, titleEn, version, artifact, sha256, bytes, characters, url)
    {
    }
}

public sealed record BookmarkPlatform(
    string Id,
    string Label,
    string TitleZh,
    string TitleEn,
    IReadOnlyList<BookmarkDefinition> Variants,
    IReadOnlyDictionary<string, string> Fallbacks);

public sealed record ResolvedBookmark(
    BookmarkDefinition Definition,
    string RequestedProfile,
    string EffectiveProfile,
    bool Fallback)
{
    public string Id => Definition.Id;
}

public sealed record BookmarkProfileSelection(
    string RequestedProfile,
    IReadOnlyList<ResolvedBookmark> Bookmarks);

public sealed record BookmarkPackage(
    string Format,
    string Version,
    string BookmarkSetVersion,
    string DefaultProfile,
    IReadOnlyList<string> Profiles,
    IReadOnlyList<BookmarkPlatform> Platforms,
    int VariantCount,
    int EffectiveCountPerProfile)
{
    // The old flat surface remains the effective default profile, never all variants.
    [JsonIgnore]
    public IReadOnlyList<BookmarkDefinition> Bookmarks =>
        Resolve(DefaultProfile).Bookmarks.Select(item => item.Definition).ToArray();

    // Compatibility for isolated bookmark acceptance fixtures.
    public BookmarkPackage(
        string format,
        string version,
        string bookmarkSetVersion,
        IReadOnlyList<BookmarkDefinition> bookmarks)
        : this(
            format,
            version,
            bookmarkSetVersion,
            BookmarkProfiles.Light,
            [BookmarkProfiles.Light],
            bookmarks.Select(item => new BookmarkPlatform(
                item.Id,
                item.Label,
                item.TitleZh,
                item.TitleEn,
                [item],
                new Dictionary<string, string>(StringComparer.Ordinal))).ToArray(),
            bookmarks.Count,
            bookmarks.Count)
    {
    }

    public BookmarkProfileSelection Resolve(string? requestedProfile)
    {
        var requested = Profiles.Count == 1
            ? DefaultProfile
            : BookmarkProfiles.Normalize(requestedProfile, DefaultProfile);
        if (!Profiles.Contains(requested, StringComparer.Ordinal))
        {
            throw new ArgumentException($"Cloudig bookmark package does not provide profile: {requested}", nameof(requestedProfile));
        }

        var resolved = Platforms.Select(platform =>
        {
            var effective = requested;
            var variant = platform.Variants.SingleOrDefault(item => item.Profile == effective);
            var fallback = false;
            if (variant is null)
            {
                if (!platform.Fallbacks.TryGetValue(requested, out effective))
                {
                    throw new InvalidDataException($"Cloudig bookmark platform {platform.Id} cannot resolve profile {requested}.");
                }
                variant = platform.Variants.SingleOrDefault(item => item.Profile == effective)
                          ?? throw new InvalidDataException($"Cloudig bookmark platform {platform.Id} fallback target is missing: {effective}");
                fallback = true;
            }
            return new ResolvedBookmark(variant, requested, effective, fallback);
        }).ToArray();
        return new BookmarkProfileSelection(requested, resolved);
    }
}

public sealed record BookmarkStore(
    string ProfileDirectory,
    string ProfileDisplayName,
    string Kind,
    string Path);

public sealed record ChromeProfile(
    string DirectoryName,
    string DisplayName,
    bool IsLastUsed,
    IReadOnlyList<BookmarkStore> Stores);

public enum BookmarkOperation
{
    InstallOrRepair,
    Remove
}

public sealed record BookmarkInstallTarget(
    string StorePath,
    string ParentGuid,
    string FolderName,
    bool PlaceFirst,
    string InstallationId,
    string ManagedFolderGuid,
    bool PlacementPending)
{
    public const string DefaultFolderName = "采云 Cloudig";

    public static BookmarkInstallTarget Default(string storePath = "") => new(
        storePath,
        string.Empty,
        DefaultFolderName,
        true,
        string.Empty,
        string.Empty,
        false);
}

public sealed record BookmarkFolderOption(
    string Guid,
    string Name,
    string Path,
    int Depth,
    bool Selectable);

public sealed record BookmarkTargetContext(
    BookmarkInstallTarget Target,
    string DisplayPath,
    bool Exists,
    IReadOnlyList<BookmarkFolderOption> Folders);

public sealed record BookmarkMutation(
    bool Changed,
    string Json,
    int Added,
    int Updated,
    int Removed,
    string Md5Checksum,
    string Sha256Checksum,
    string ManagedFolderGuid = "");

public sealed record BookmarkStoreResult(
    BookmarkStore Store,
    BookmarkMutation Mutation,
    string OriginalSha256,
    string ResultSha256,
    string? BackupPath);

public sealed record BookmarkTransactionResult(
    string? BackupDirectory,
    IReadOnlyList<BookmarkStoreResult> Stores)
{
    public int ChangedStoreCount => Stores.Count(item => item.Mutation.Changed);
    public int AddedCount => Stores.Sum(item => item.Mutation.Added);
    public int UpdatedCount => Stores.Sum(item => item.Mutation.Updated);
    public int RemovedCount => Stores.Sum(item => item.Mutation.Removed);
}

public sealed record BookmarkStoreStatus(
    BookmarkStore Store,
    string Status,
    int ManagedCount,
    string SetVersion,
    string Error,
    IReadOnlyList<BookmarkEntryInspection> Bookmarks);

public sealed record BookmarkEntryInspection(
    string Id,
    string Status,
    string Version,
    string RequestedProfile,
    string EffectiveProfile,
    bool Fallback,
    string InstalledProfile);

public sealed record BookmarkInspection(
    string Status,
    int ManagedCount,
    string SetVersion,
    IReadOnlyList<BookmarkEntryInspection> Bookmarks,
    string ManagedFolderGuid = "");

public sealed record BookmarkUpgradeNote(
    string Date,
    string PlatformId,
    string Profile,
    string Version,
    IReadOnlyList<string> FromVersions,
    string Summary,
    string ReexportGuidance);

public sealed record BookmarkCatalogEntry(
    string Id,
    string Label,
    string TitleZh,
    string TitleEn,
    string Version,
    string RequestedProfile,
    string EffectiveProfile,
    bool Fallback,
    IReadOnlyList<BookmarkUpgradeNote> UpgradeNotes);

public sealed record BookmarkManagerSummary(
    string Browser,
    string UserDataDirectory,
    string BookmarkSetVersion,
    string RequestedProfile,
    string DefaultProfile,
    IReadOnlyList<string> AvailableProfiles,
    bool BrowserRunning,
    string BookmarkChangelogError,
    IReadOnlyList<BookmarkCatalogEntry> Bookmarks,
    IReadOnlyList<ChromeProfile> Profiles,
    IReadOnlyList<BookmarkStoreStatus> Stores)
{
    [JsonIgnore]
    public int StoreCount => Stores.Count;
}
