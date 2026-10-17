using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cloudig.Bookmarks;

public static partial class BookmarkPackageLoader
{
    private const int ExpectedPlatformCount = 12;
    private const int ExpectedVariantCount = 32;
    private const int ExpectedEffectiveCount = 12;
    private const int ExpectedFallbackCount = 4;
    private const int MaximumCharacters = 480 * 1024;

    public static async Task<BookmarkPackage> LoadAsync(
        string manifestPath,
        string artifactRoot,
        CancellationToken cancellationToken = default)
    {
        await using var manifestStream = File.OpenRead(Path.GetFullPath(manifestPath));
        using var manifest = await JsonDocument.ParseAsync(
            manifestStream,
            new JsonDocumentOptions { MaxDepth = 24, CommentHandling = JsonCommentHandling.Disallow },
            cancellationToken);
        var root = manifest.RootElement;
        if (RequiredString(root, "format") != "cloudig/bookmark-package" || RequiredString(root, "version") != "0.2.0")
        {
            throw new InvalidDataException("Unsupported Cloudig bookmark package manifest.");
        }

        var setVersion = RequiredString(root, "bookmark_set_version");
        var defaultProfile = RequiredString(root, "default_profile");
        var profiles = RequiredStringArray(root, "profiles");
        if (!profiles.SequenceEqual(BookmarkProfiles.All, StringComparer.Ordinal)
            || defaultProfile != BookmarkProfiles.Light)
        {
            throw new InvalidDataException("Cloudig bookmark package must declare light, full, all_branches with light as its default.");
        }
        if (RequiredInt(root, "platform_count") != ExpectedPlatformCount
            || RequiredInt(root, "variant_count") != ExpectedVariantCount
            || RequiredInt(root, "effective_count_per_profile") != ExpectedEffectiveCount)
        {
            throw new InvalidDataException("Cloudig bookmark package count contract is not 12 platforms / 32 variants / 12 effective.");
        }

        if (!root.TryGetProperty("platforms", out var platformElements)
            || platformElements.ValueKind is not JsonValueKind.Array
            || platformElements.GetArrayLength() != ExpectedPlatformCount)
        {
            throw new InvalidDataException($"Cloudig bookmark package must contain {ExpectedPlatformCount} platforms.");
        }

        var platformIds = new HashSet<string>(StringComparer.Ordinal);
        var variantIds = new HashSet<string>(StringComparer.Ordinal);
        var artifactPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var platforms = new List<BookmarkPlatform>(ExpectedPlatformCount);
        var variantCount = 0;
        var fallbackCount = 0;
        foreach (var platformElement in platformElements.EnumerateArray())
        {
            var id = RequiredString(platformElement, "id");
            if (!StableId().IsMatch(id) || !platformIds.Add(id))
            {
                throw new InvalidDataException($"Invalid or duplicate Cloudig bookmark platform id: {id}");
            }
            var label = RequiredString(platformElement, "label");
            var titleZh = RequiredString(platformElement, "title_zh");
            var titleEn = RequiredString(platformElement, "title_en");
            if (!titleZh.EndsWith("-Cloudig", StringComparison.Ordinal)
                || !titleEn.EndsWith("-Cloudig", StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Cloudig bookmark display names must end in -Cloudig: {id}");
            }

            if (!platformElement.TryGetProperty("variants", out var variantElements)
                || variantElements.ValueKind is not JsonValueKind.Array
                || variantElements.GetArrayLength() is < 2 or > 3)
            {
                throw new InvalidDataException($"Cloudig bookmark platform must contain two or three variants: {id}");
            }
            var variants = new List<BookmarkDefinition>(variantElements.GetArrayLength());
            var platformProfiles = new HashSet<string>(StringComparer.Ordinal);
            foreach (var variantElement in variantElements.EnumerateArray())
            {
                var profile = RequiredString(variantElement, "profile");
                if (!profiles.Contains(profile, StringComparer.Ordinal) || !platformProfiles.Add(profile))
                {
                    throw new InvalidDataException($"Invalid or duplicate Cloudig bookmark profile for {id}: {profile}");
                }
                var variantId = RequiredString(variantElement, "id");
                if (variantId != $"{id}:{profile}" || !variantIds.Add(variantId))
                {
                    throw new InvalidDataException($"Invalid or duplicate Cloudig bookmark variant id: {variantId}");
                }
                var artifact = RequiredString(variantElement, "artifact");
                if (!artifactPaths.Add(artifact))
                {
                    throw new InvalidDataException($"Duplicate Cloudig bookmark artifact path: {artifact}");
                }
                var artifactPath = ResolveArtifactPath(artifactRoot, artifact);
                if ((File.GetAttributes(artifactPath) & FileAttributes.ReparsePoint) != 0)
                {
                    throw new InvalidDataException($"Cloudig bookmark artifact cannot be a link: {artifact}");
                }
                var bytes = await File.ReadAllBytesAsync(artifactPath, cancellationToken);
                var expectedBytes = RequiredLong(variantElement, "bytes");
                if (bytes.LongLength != expectedBytes)
                {
                    throw new InvalidDataException($"Cloudig bookmark artifact size drifted: {artifact}");
                }
                var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                var expectedHash = RequiredString(variantElement, "sha256");
                if (!LowerSha256().IsMatch(expectedHash)
                    || !FixedAsciiEquals(hash, expectedHash))
                {
                    throw new InvalidDataException($"Cloudig bookmark artifact hash drifted: {artifact}");
                }
                var url = new UTF8Encoding(false, true).GetString(bytes);
                var expectedCharacters = RequiredLong(variantElement, "characters");
                if (url.Length != expectedCharacters
                    || url.Length > MaximumCharacters
                    || !url.StartsWith("javascript:", StringComparison.Ordinal)
                    || url.Contains('\r')
                    || url.Contains('\n'))
                {
                    throw new InvalidDataException($"Cloudig bookmark artifact is not an accepted strict one-line URL: {artifact}");
                }
                variants.Add(new BookmarkDefinition(
                    id,
                    variantId,
                    profile,
                    label,
                    titleZh,
                    titleEn,
                    RequiredString(variantElement, "version"),
                    artifact,
                    hash,
                    expectedBytes,
                    expectedCharacters,
                    url));
                variantCount += 1;
            }
            if (!platformProfiles.Contains(BookmarkProfiles.Light)
                || !platformProfiles.Contains(BookmarkProfiles.Full))
            {
                throw new InvalidDataException($"Cloudig bookmark platform requires light and full variants: {id}");
            }

            var fallbacks = ReadFallbacks(platformElement);
            if (platformProfiles.Contains(BookmarkProfiles.AllBranches))
            {
                if (fallbacks.Count != 0)
                {
                    throw new InvalidDataException($"Cloudig bookmark platform cannot declare a fallback when all_branches exists: {id}");
                }
            }
            else
            {
                if (fallbacks.Count != 1
                    || !fallbacks.TryGetValue(BookmarkProfiles.AllBranches, out var target)
                    || target != BookmarkProfiles.Full)
                {
                    throw new InvalidDataException($"Cloudig bookmark platform without all_branches must fall back exactly to full: {id}");
                }
                fallbackCount += 1;
            }
            platforms.Add(new BookmarkPlatform(id, label, titleZh, titleEn, variants, fallbacks));
        }

        if (variantCount != ExpectedVariantCount || fallbackCount != ExpectedFallbackCount)
        {
            throw new InvalidDataException("Cloudig bookmark package does not contain exactly 32 variants and four all_branches fallbacks.");
        }
        var package = new BookmarkPackage(
            "cloudig/bookmark-package",
            "0.2.0",
            setVersion,
            defaultProfile,
            profiles,
            platforms,
            variantCount,
            ExpectedEffectiveCount);
        foreach (var profile in profiles)
        {
            var effective = package.Resolve(profile);
            if (effective.Bookmarks.Count != ExpectedEffectiveCount
                || effective.Bookmarks.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() != ExpectedEffectiveCount)
            {
                throw new InvalidDataException($"Cloudig bookmark profile does not resolve to exactly 12 platforms: {profile}");
            }
        }
        return package;
    }

    private static string ResolveArtifactPath(string rootPath, string artifact)
    {
        if (string.IsNullOrWhiteSpace(artifact)
            || Path.IsPathRooted(artifact)
            || artifact.Contains('\\')
            || artifact.Split('/').Any(segment => segment is "" or "." or "..")
            || !artifact.EndsWith(".min.js", StringComparison.Ordinal))
        {
            throw new InvalidDataException($"Unsafe Cloudig project-relative artifact path: {artifact}");
        }

        var root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var projectRelative = artifact.Replace('/', Path.DirectorySeparatorChar);
        var candidates = new List<string> { Path.Combine(root, projectRelative) };
        const string bookmarkletsPrefix = "bookmarklets/";
        if (artifact.StartsWith(bookmarkletsPrefix, StringComparison.Ordinal))
        {
            // Development passes the project root. Compatibility callers may still pass the
            // bookmarklets directory; packaged builds pass an artifacts root that contains the
            // preserved bookmarklets tree.
            candidates.Add(Path.Combine(root, artifact[bookmarkletsPrefix.Length..].Replace('/', Path.DirectorySeparatorChar)));
        }

        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var full = Path.GetFullPath(candidate);
            var relative = Path.GetRelativePath(root, full);
            if (relative == ".."
                || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                || Path.IsPathRooted(relative))
            {
                continue;
            }
            if (File.Exists(full)) return full;
        }
        throw new FileNotFoundException($"Cloudig bookmark artifact is missing: {artifact}");
    }

    private static Dictionary<string, string> ReadFallbacks(JsonElement platform)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!platform.TryGetProperty("fallback", out var fallback)) return result;
        if (fallback.ValueKind is not JsonValueKind.Object)
        {
            throw new InvalidDataException("Cloudig bookmark fallback must be an object.");
        }
        foreach (var property in fallback.EnumerateObject())
        {
            if (property.Value.ValueKind is not JsonValueKind.String
                || string.IsNullOrWhiteSpace(property.Value.GetString())
                || !result.TryAdd(property.Name, property.Value.GetString()!))
            {
                throw new InvalidDataException($"Invalid Cloudig bookmark fallback: {property.Name}");
            }
        }
        return result;
    }

    private static IReadOnlyList<string> RequiredStringArray(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind is not JsonValueKind.Array)
        {
            throw new InvalidDataException($"Cloudig bookmark package requires array {property}.");
        }
        var result = value.EnumerateArray().Select(item =>
        {
            if (item.ValueKind is not JsonValueKind.String || string.IsNullOrWhiteSpace(item.GetString()))
            {
                throw new InvalidDataException($"Cloudig bookmark package requires non-empty strings in {property}.");
            }
            return item.GetString()!;
        }).ToArray();
        if (result.Distinct(StringComparer.Ordinal).Count() != result.Length)
        {
            throw new InvalidDataException($"Cloudig bookmark package contains duplicates in {property}.");
        }
        return result;
    }

    private static string RequiredString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)
            || value.ValueKind is not JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"Cloudig bookmark package requires {property}.");
        }
        return value.GetString()!;
    }

    private static int RequiredInt(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || !value.TryGetInt32(out var result) || result < 0)
        {
            throw new InvalidDataException($"Cloudig bookmark package requires non-negative integer {property}.");
        }
        return result;
    }

    private static long RequiredLong(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || !value.TryGetInt64(out var result) || result < 0)
        {
            throw new InvalidDataException($"Cloudig bookmark package requires non-negative integer {property}.");
        }
        return result;
    }

    private static bool FixedAsciiEquals(string left, string right)
    {
        var leftBytes = Encoding.ASCII.GetBytes(left);
        var rightBytes = Encoding.ASCII.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
               && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    [GeneratedRegex("^[a-z][a-z0-9-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex StableId();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex LowerSha256();
}
