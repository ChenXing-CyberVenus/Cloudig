using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace Cloudig.Desktop;

internal sealed record AppPaths(
    string ProjectRoot,
    string WebRoot,
    string CommandScript,
    string NodeExecutable,
    string BookmarkManifest,
    string BookmarkArtifactRoot,
    string BookmarkChangelog,
    string LocalDataRoot,
    string WebViewDataRoot,
    string SettingsFile)
{
    internal static IReadOnlyList<string> RequiredPackagedFiles { get; } = Array.AsReadOnly(new[]
    {
        "Cloudig.exe",
        "BOOKMARKLET_CHANGELOG.md",
        "runtime-lock.json",
        "runtime/node/node.exe",
        "runtime/node/LICENSE.node.txt",
        "payload/bookmarks/bookmark-package.json",
        "web/index.html",
        "web/app.js",
        "web/modules/native-bridge.js",
        "web/modules/conversation-info-editor.js",
        "web/modules/time-editor.js",
        "web/modules/time-node-editor.js",
        "web/modules/time-range-editor.js",
        "web/app.css",
        "web/archiver.css",
        "web/time-editor.css",
        "web/shared/cloudig-tokens.css",
        "web/shared/cloudig-foundation.css",
        "web/shared/cloudig-docs.css",
        "web/shared/cloudig-docs.js",
        "web/shared/cloudig-docs.json",
        "web/shared/cloudig-tooltip.js",
        "web/shared/cloudig-viewport.js",
        "web/shared/manifest.json",
        "web/assets/brand/Cloudig-Slogan-Chinese-Grey-Dark-1024.png",
        "web/assets/brand/Cloudig-Slogan-Chinese-Grey-Light-1024.png",
        "web/assets/brand/Cloudig-Title-Chinese-Grey-Dark-1024.png",
        "web/assets/brand/Cloudig-Title-Chinese-Grey-Light-1024.png",
        "web/assets/brand/OsisLogo-Cloudig-PurpleBackOrangeAbyss.svg",
        "web/assets/brand/OsisLogo-Cloudig-RedBackWhiteAbyss.svg",
        "web/assets/brand/Waiting-Sun.gif",
        "web/assets/welcome/Back-Abyss-1920.png",
        "web/assets/welcome/Back-Horizon-1920.png",
        "web/assets/welcome/Back-Light-1920.png",
        "web/assets/welcome/Back-Light-start-1920.png",
        "web/assets/welcome/Cloudig-Logo-Title-Slogan.svg",
        "web/assets/welcome/Cover-PhotoFrame-Dawn.svg",
        "web/assets/welcome/Cover-PhotoFrame-StarNight.svg",
        "web/assets/welcome/OsisLogo-Cloudig-1024.png",
        "web/assets/welcome/OsisLogo-Main-1024.png",
        "web/assets/welcome/OsisLogo-Simple-Mono-Orange.svg",
        "web/assets/welcome/OsisLogo-Simple-Mono-Purple.svg",
        "web/assets/welcome/OsisLogo-Simple.svg",
        "web/assets/archiver/Astronaut.svg",
        "web/assets/archiver/Button-Name-Flower.svg",
        "web/assets/archiver/Button-Time-Clock.svg",
        "web/assets/archiver/Button-Time-LightCone.svg",
        "web/assets/archiver/Button-Time-Tea.svg",
        "web/assets/archiver/ChenXing-Avatar.png",
        "web/assets/archiver/Cock.svg",
        "web/assets/archiver/GirlInForest.svg",
        "web/assets/archiver/Phoenix.svg",
        "web/assets/archiver/PinkGreenTrees.svg",
        "web/assets/archiver/Pushpin-Purple.svg",
        "web/assets/archiver/Pushpin-Red.svg",
        "web/assets/archiver/RockStage.svg",
        "web/assets/archiver/Rocket.svg",
        "web/assets/archiver/SailboatWithShadow.svg",
        "web/assets/archiver/Ship.svg",
        "web/assets/archiver/Sunflower.svg",
        "web/assets/archiver/TitleDec-Explosion.svg",
        "web/assets/archiver/TitleDec-Garden.svg",
        "web/assets/archiver/TitleDec-Homeland.svg",
        "web/assets/archiver/TitleDec-Pompeii.svg",
        "web/assets/archiver/Village-Dusk.svg",
        "web/assets/archiver/Village-Night.svg",
        "web/assets/archiver/Wave-Blue.svg",
        "web/assets/archiver/Wave-Green.svg",
        "web/assets/archiver/WildTree.svg",
        "web/assets/time/ContentTimeTitleBack-Dawn.svg",
        "web/assets/time/ContentTimeTitleBack-StarNight.svg",
        "web/assets/time/TimeCloud-Blue.svg",
        "web/assets/time/TimeCloud-DarkGrey.svg",
        "web/assets/time/TimeCloud-LightGrey.svg",
        "web/assets/time/TimeCloud-Red.svg",
        "web/assets/time/TimeLOGO-Sovereign.svg",
        "web/assets/time/TimeLOGO-Terran.svg",
        "web/assets/time/terran-cloudig-1.0.0.json",
        "web/locales/en.json",
        "web/locales/zh-CN.json",
        "engine/manager/src/command.mjs",
        "engine/manager/src/archive-library.mjs",
        "engine/manager/src/conversation-catalog.mjs",
        "engine/manager/src/library-move.mjs",
        "engine/manager/src/parse-batch.mjs",
        "engine/manager/src/service.mjs",
        "engine/manager/src/user-state-history.mjs",
        "engine/manager/src/content-time-service.mjs",
        "engine/library/core.js",
        "engine/library/v1.mjs",
        "engine/library/domain-v1.mjs",
        "engine/library/compat.mjs",
        "engine/library/src/init.mjs",
        "engine/library/cloudig-library-0.1.4.schema.json",
        "engine/library/cloudig-library-1.0.0.schema.json",
        "engine/parser/source-families.json",
        "engine/parser/version-policy.json",
        "engine/parser/src/index.mjs",
        "engine/parser/src/contract.mjs",
        "engine/parser/src/registry.mjs",
        "engine/parser/src/input-adapters.mjs",
        "engine/parser/src/library-orchestrator.mjs",
        "engine/parser/src/claude-json-adapter.mjs",
        "engine/parser/src/claude-library.mjs",
        "engine/parser/src/json-array-stream.mjs",
        "engine/parser/src/atomic.mjs",
        "engine/parser/src/output-transaction.mjs",
        "engine/parser/src/parse-state.mjs",
        "engine/parser/src/parse-state-v1.mjs",
        "engine/parser/src/envelope-v1.mjs",
        "engine/parser/src/v1-write-transaction.mjs",
        "engine/parser/parse-state-1.0.0.schema.json",
        "engine/parser/src/semver.mjs",
        "engine/parser/src/time.mjs",
        "engine/parser/src/html.mjs",
        "engine/parser/src/adapters/branches.mjs",
        "engine/parser/src/adapters/chatglm.mjs",
        "engine/parser/src/adapters/chatgpt.mjs",
        "engine/parser/src/adapters/claude-web.mjs",
        "engine/parser/src/adapters/common.mjs",
        "engine/parser/src/adapters/deepseek.mjs",
        "engine/parser/src/adapters/doubao.mjs",
        "engine/parser/src/adapters/full.mjs",
        "engine/parser/src/adapters/gemini.mjs",
        "engine/parser/src/adapters/grok.mjs",
        "engine/parser/src/adapters/kimi.mjs",
        "engine/parser/src/adapters/mistral.mjs",
        "engine/parser/src/adapters/qwen.mjs",
        "engine/parser/src/adapters/yuanbao.mjs",
        "engine/parser/src/adapters/zai.mjs",
        "engine/schema/conversation-0.1.3.schema.json",
        "engine/schema/conversation-0.1.4.schema.json",
        "engine/schema/conversation-0.1.5.schema.json",
        "engine/schema/conversation-0.2.3.schema.json",
        "engine/schema/conversation-0.2.4.schema.json",
        "engine/schema/conversation-0.2.5.schema.json",
        "engine/schema/serialize.mjs",
        "engine/schema/validate.mjs",
        "engine/schema/validate-v1.mjs",
        "engine/schema/canonical-v1.mjs",
        "engine/schema/conversation-1.0.0.schema.json",
        "engine/time/limits-1.0.0.json",
        "engine/time/core.js",
        "engine/time/system.js",
        "engine/time/content-time-1.0.0.schema.json",
        "engine/time/content-time-system-1.0.0.schema.json",
        "engine/time/sovereign-time-snapshot-1.0.0.schema.json",
        "engine/time/presets/terran-cloudig-1.0.0.json",
        "engine/reader/build.mjs",
        "engine/reader/src/core.js",
        "engine/reader/src/i18n.js",
        "engine/reader/src/index.html",
        "engine/reader/src/reader-cover.css",
        "engine/reader/src/reader-cover.js",
        "engine/reader/src/reader.css",
        "engine/reader/src/reader.js",
        "engine/reader/vendor/markdown-it-14.3.0.min.js",
        "engine/reader/vendor/osis-temml-runtime.js",
        "engine/reader/vendor/temml-render-0.13.3.min.js",
        "engine/reader/vendor/katex/katex-static-0.18.0.min.css"
    });

    public static AppPaths Discover()
    {
        var baseDirectory = Path.GetFullPath(AppContext.BaseDirectory);
        var packagedWeb = Path.Combine(baseDirectory, "web");
        var packagedEngine = Path.Combine(baseDirectory, "engine");
        var bundledNode = Path.Combine(baseDirectory, "runtime", "node", "node.exe");
        var packagedBookmarkManifest = Path.Combine(baseDirectory, "payload", "bookmarks", "bookmark-package.json");
        var packagedBookmarkArtifacts = Path.Combine(baseDirectory, "payload", "bookmarks", "artifacts");
        var completePackagedLayout = IsCompletePackagedLayout(baseDirectory);
        string projectRoot;
        string webRoot;

        if (completePackagedLayout)
        {
            projectRoot = packagedEngine;
            webRoot = packagedWeb;
        }
        else
        {
            var cursor = new DirectoryInfo(baseDirectory);
            while (cursor is not null
                   && !File.Exists(Path.Combine(cursor.FullName, "manager", "web", "index.html")))
            {
                cursor = cursor.Parent;
            }

            if (cursor is null)
            {
                throw new DirectoryNotFoundException("Cloudig could not locate its local web and parser files.");
            }

            projectRoot = cursor.FullName;
            webRoot = Path.Combine(projectRoot, "manager", "web");
        }

        var commandScript = Path.Combine(projectRoot, "manager", "src", "command.mjs");
        if (!File.Exists(commandScript))
        {
            throw new FileNotFoundException("Cloudig Manager command service is missing.", commandScript);
        }

        var configuredNode = Environment.GetEnvironmentVariable("CLOUDIG_NODE");
        var nodeExecutable = completePackagedLayout
            ? bundledNode
            : !string.IsNullOrWhiteSpace(configuredNode) && File.Exists(configuredNode)
                ? Path.GetFullPath(configuredNode)
                : "node.exe";

        var localDataRoot = ResolveLocalDataRoot();
        var bookmarkManifest = completePackagedLayout
            ? packagedBookmarkManifest
            : Path.Combine(projectRoot, "manager", "bookmarks", "bookmark-package.json");
        var bookmarkArtifactRoot = completePackagedLayout
            ? packagedBookmarkArtifacts
            : Path.Combine(projectRoot, "manager", "bookmarks", "artifacts");
        var bookmarkChangelog = completePackagedLayout
            ? Path.Combine(baseDirectory, "BOOKMARKLET_CHANGELOG.md")
            : Path.Combine(projectRoot, "BOOKMARKLET_CHANGELOG.md");
        if (!File.Exists(bookmarkManifest)) throw new FileNotFoundException("Cloudig bookmark package manifest is missing.", bookmarkManifest);
        if (!Directory.Exists(bookmarkArtifactRoot)) throw new DirectoryNotFoundException($"Cloudig frozen bookmark artifacts are missing: {bookmarkArtifactRoot}");
        if (!File.Exists(bookmarkChangelog)) throw new FileNotFoundException("Cloudig bookmark changelog is missing.", bookmarkChangelog);
        return new AppPaths(
            projectRoot,
            webRoot,
            commandScript,
            nodeExecutable,
            bookmarkManifest,
            bookmarkArtifactRoot,
            bookmarkChangelog,
            localDataRoot,
            Path.Combine(localDataRoot, "WebView2"),
            Path.Combine(localDataRoot, "settings.json"));
    }

    internal static bool IsCompletePackagedLayout(string baseDirectory)
    {
        try
        {
            var resolvedBase = Path.GetFullPath(baseDirectory)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var releaseManifestPath = Path.Combine(resolvedBase, "release-manifest.json");
            if (!IsPlainDirectory(resolvedBase)
                || !IsPlainFile(releaseManifestPath)
                || !HasNoReparseComponents(resolvedBase, releaseManifestPath))
            {
                return false;
            }

            using var releaseDocument = JsonDocument.Parse(File.ReadAllText(releaseManifestPath));
            var releaseRoot = releaseDocument.RootElement;
            if (!releaseRoot.TryGetProperty("format", out var releaseFormat)
                || releaseFormat.GetString() != "cloudig/windows-release-manifest"
                || !releaseRoot.TryGetProperty("version", out var releaseVersion)
                || releaseVersion.GetString() != "0.1.0"
                || !releaseRoot.TryGetProperty("architecture", out var architecture)
                || architecture.GetString() != "win-x64"
                || !releaseRoot.TryGetProperty("bookmark_variant_count", out var releaseVariantCount)
                || !releaseVariantCount.TryGetInt32(out var releaseVariants)
                || releaseVariants != 32
                || !releaseRoot.TryGetProperty("files", out var releaseFiles)
                || releaseFiles.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            if (!TryCollectPlainFiles(resolvedBase, out var actualFiles)) return false;

            var declaredFiles = new Dictionary<string, (long Bytes, string Sha256)>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in releaseFiles.EnumerateArray())
            {
                if (!entry.TryGetProperty("path", out var pathProperty)
                    || !entry.TryGetProperty("bytes", out var bytesProperty)
                    || !bytesProperty.TryGetInt64(out var declaredBytes)
                    || declaredBytes <= 0
                    || !entry.TryGetProperty("sha256", out var digestProperty)
                    || !IsLowerSha256(digestProperty.GetString())
                    || !TryResolvePackagedFile(resolvedBase, pathProperty.GetString(), out var resolvedFile, out var normalizedPath)
                    || declaredFiles.ContainsKey(normalizedPath)
                    || !IsPlainFile(resolvedFile)
                    || new FileInfo(resolvedFile).Length != declaredBytes
                    || !string.Equals(ComputeSha256(resolvedFile), digestProperty.GetString(), StringComparison.Ordinal))
                {
                    return false;
                }
                declaredFiles.Add(normalizedPath, (declaredBytes, digestProperty.GetString()!));
            }

            var expectedFiles = new HashSet<string>(declaredFiles.Keys, StringComparer.OrdinalIgnoreCase)
            {
                "release-manifest.json"
            };
            if (!actualFiles.SetEquals(expectedFiles))
            {
                return false;
            }

            foreach (var required in RequiredPackagedFiles)
            {
                if (!declaredFiles.ContainsKey(required)) return false;
            }

            var runtimeLockPath = Path.Combine(resolvedBase, "runtime-lock.json");
            using var runtimeDocument = JsonDocument.Parse(File.ReadAllText(runtimeLockPath));
            var runtimeRoot = runtimeDocument.RootElement;
            if (!runtimeRoot.TryGetProperty("format", out var runtimeFormat)
                || runtimeFormat.GetString() != "cloudig/windows-runtime-lock"
                || !runtimeRoot.TryGetProperty("node", out var nodePolicy)
                || !nodePolicy.TryGetProperty("node_exe_sha256", out var nodeDigestProperty)
                || !IsLowerSha256(nodeDigestProperty.GetString()))
            {
                return false;
            }

            var nodePath = Path.Combine(resolvedBase, "runtime", "node", "node.exe");
            if (!declaredFiles.TryGetValue("runtime/node/node.exe", out var declaredNode)
                || !string.Equals(
                    declaredNode.Sha256,
                    nodeDigestProperty.GetString(),
                    StringComparison.Ordinal))
            {
                return false;
            }

            var manifestPath = Path.Combine(resolvedBase, "payload", "bookmarks", "bookmark-package.json");
            var artifactRoot = Path.Combine(resolvedBase, "payload", "bookmarks", "artifacts");
            if (!Directory.Exists(artifactRoot)) return false;
            using var bookmarkDocument = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var bookmarkRoot = bookmarkDocument.RootElement;
            if (!bookmarkRoot.TryGetProperty("format", out var bookmarkFormat)
                || bookmarkFormat.GetString() != "cloudig/bookmark-package"
                || !bookmarkRoot.TryGetProperty("platform_count", out var platformCount)
                || !platformCount.TryGetInt32(out var declaredPlatforms)
                || declaredPlatforms != 12
                || !bookmarkRoot.TryGetProperty("variant_count", out var declaredCount)
                || !declaredCount.TryGetInt32(out var declaredVariants)
                || declaredVariants != 32
                || !bookmarkRoot.TryGetProperty("platforms", out var platforms)
                || platforms.ValueKind != JsonValueKind.Array
                || platforms.GetArrayLength() != declaredPlatforms)
            {
                return false;
            }

            var resolvedArtifactRoot = Path.GetFullPath(artifactRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var artifacts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var platform in platforms.EnumerateArray())
            {
                if (!platform.TryGetProperty("variants", out var variants) || variants.ValueKind != JsonValueKind.Array)
                {
                    return false;
                }
                foreach (var variant in variants.EnumerateArray())
                {
                    if (!variant.TryGetProperty("artifact", out var artifactProperty)
                        || !variant.TryGetProperty("bytes", out var artifactBytesProperty)
                        || !artifactBytesProperty.TryGetInt64(out var artifactBytes)
                        || artifactBytes <= 0
                        || !variant.TryGetProperty("sha256", out var artifactDigestProperty)
                        || !IsLowerSha256(artifactDigestProperty.GetString())
                        || !TryResolvePackagedFile(
                            resolvedArtifactRoot,
                            artifactProperty.GetString(),
                            out var resolvedArtifact,
                            out var normalizedArtifact)
                        || !artifacts.Add(resolvedArtifact)
                        || !declaredFiles.TryGetValue(
                            $"payload/bookmarks/artifacts/{normalizedArtifact}",
                            out var declaredArtifact)
                        || !IsPlainFile(resolvedArtifact)
                        || new FileInfo(resolvedArtifact).Length != artifactBytes
                        || !string.Equals(
                            declaredArtifact.Sha256,
                            artifactDigestProperty.GetString(),
                            StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
            }
            return artifacts.Count == 32;
        }
        catch (Exception error) when (error is IOException
                                      or UnauthorizedAccessException
                                      or JsonException
                                      or ArgumentException
                                      or InvalidOperationException
                                      or FormatException
                                      or OverflowException
                                      or CryptographicException)
        {
            return false;
        }
    }

    private static bool TryResolvePackagedFile(
        string root,
        string? relative,
        out string resolved,
        out string normalized)
    {
        resolved = string.Empty;
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) return false;
        var resolvedRoot = Path.GetFullPath(root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        resolved = Path.GetFullPath(Path.Combine(
            resolvedRoot,
            relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!resolved.StartsWith(resolvedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        normalized = Path.GetRelativePath(resolvedRoot, resolved).Replace(Path.DirectorySeparatorChar, '/');
        return normalized.Length > 0
               && normalized != "."
               && !normalized.StartsWith("../", StringComparison.Ordinal)
               && HasNoReparseComponents(resolvedRoot, resolved);
    }

    private static bool IsPlainFile(string path)
    {
        if (!File.Exists(path)) return false;
        var attributes = File.GetAttributes(path);
        return (attributes & FileAttributes.Directory) == 0
               && (attributes & FileAttributes.ReparsePoint) == 0;
    }

    private static bool IsPlainDirectory(string path)
    {
        if (!Directory.Exists(path)) return false;
        var attributes = File.GetAttributes(path);
        return (attributes & FileAttributes.Directory) != 0
               && (attributes & FileAttributes.ReparsePoint) == 0;
    }

    private static bool HasNoReparseComponents(string root, string target)
    {
        var resolvedRoot = Path.GetFullPath(root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var resolvedTarget = Path.GetFullPath(target);
        if (resolvedTarget != resolvedRoot
            && !resolvedTarget.StartsWith(resolvedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var current = resolvedRoot;
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
        var relative = Path.GetRelativePath(resolvedRoot, resolvedTarget);
        if (relative == ".") return true;
        foreach (var component in relative.Split(
                     new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                     StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
        }
        return true;
    }

    private static bool TryCollectPlainFiles(string root, out HashSet<string> files)
    {
        files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var resolvedRoot = Path.GetFullPath(root)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!IsPlainDirectory(resolvedRoot)) return false;

        var pending = new Queue<string>();
        pending.Enqueue(resolvedRoot);
        while (pending.Count > 0)
        {
            var current = pending.Dequeue();
            if (!IsPlainDirectory(current) || !HasNoReparseComponents(resolvedRoot, current)) return false;
            foreach (var entry in Directory.EnumerateFileSystemEntries(current))
            {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) return false;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    pending.Enqueue(entry);
                    continue;
                }
                if (!IsPlainFile(entry) || !HasNoReparseComponents(resolvedRoot, entry)) return false;
                var relative = Path.GetRelativePath(resolvedRoot, entry).Replace(Path.DirectorySeparatorChar, '/');
                if (!files.Add(relative)) return false;
            }
        }
        return true;
    }

    private static bool IsLowerSha256(string? value) =>
        value is { Length: 64 }
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string ComputeSha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string ResolveLocalDataRoot()
    {
        var smokeRoot = Environment.GetEnvironmentVariable("CLOUDIG_SMOKE_LOCAL_DATA_ROOT");
        if (!string.IsNullOrWhiteSpace(smokeRoot))
        {
            var resolved = Path.GetFullPath(smokeRoot).TrimEnd(Path.DirectorySeparatorChar);
            var temporaryRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
            if (!resolved.StartsWith(temporaryRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("CLOUDIG_SMOKE_LOCAL_DATA_ROOT must stay inside the Windows temporary directory.");
            }
            return resolved;
        }

        var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localData))
        {
            throw new DirectoryNotFoundException("Windows did not provide a LocalApplicationData directory.");
        }
        return Path.Combine(localData, "Cloudig");
    }
}
