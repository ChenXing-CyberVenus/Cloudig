using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

if (args is ["--sync-chrome", var chromePath])
{
    await BookmarkSyncBrowserProbe.Run(chromePath);
    return;
}

if (args is ["--sync-only"])
{
    Console.WriteLine(JsonSerializer.Serialize(new {ok=true, assertions=BookmarkSyncTests.Run()}));
    return;
}

if (args is ["--sync-inspect", var inspectPath])
{
    var json = JsonNode.Parse(await File.ReadAllTextAsync(inspectPath, Encoding.UTF8))!.AsObject();
    var encoded = json["sync_metadata"]?.GetValue<string>() ?? "";
    var syncBytes = Convert.FromBase64String(encoded);
    var sync = ChromeSyncMessage.Parse(syncBytes);
    var records = sync.Fields(2).Select(f => ChromeSyncMessage.Parse(f.Data)).ToArray();
    var nodes = new Dictionary<long, JsonObject>();
    var parents = new Dictionary<long, string>();
    void Visit(JsonObject node, string parent = "")
    {
        if (long.TryParse(node["id"]?.GetValue<string>(), out var id)) nodes.Add(id, node);
        parents.Add(id, parent);
        if (node["children"] is JsonArray children) foreach (var child in children.OfType<JsonObject>()) Visit(child, node["guid"]!.GetValue<string>());
    }
    foreach (var root in json["roots"]!.AsObject().Select(p => p.Value).OfType<JsonObject>()) Visit(root);
    var ids = records.Where(r => r.Has(1)).Select(r => r.Number(1)).ToHashSet();
    var own = nodes.Where(p => p.Value["meta_info"] is JsonObject meta && meta.Any(k => k.Key.StartsWith("cloudig", StringComparison.Ordinal))).Select(p => p.Key).ToHashSet();
    var ownRecords = records.Where(r => own.Contains(r.Number(1, -1))).Select(r => ChromeSyncMessage.Parse(r.Bytes(2)!)).ToArray();
    Console.WriteLine(JsonSerializer.Serialize(new { nodes=nodes.Count, metadata_bytes=syncBytes.Length, records=records.Length,
        missing_metadata=nodes.Keys.Count(id=>!ids.Contains(id)), missing_nodes=ids.Count(id=>!nodes.ContainsKey(id)), own_nodes=own.Count,
        own_records=ownRecords.Length, own_nonzero_favicon=ownRecords.Count(r=>r.Fixed32(12)!=0),
        client_tag_matches=records.Where(r=>r.Has(1)).Count(r=>ChromeSyncMessage.Parse(r.Bytes(2)!).Text(1)==ChromeBookmarkSync.ClientTag(nodes[r.Number(1)]["guid"]!.GetValue<string>())),
        own_specifics_matches=records.Where(r=>own.Contains(r.Number(1,-1))).Count(r=>{
            var id=r.Number(1);var m=ChromeSyncMessage.Parse(r.Bytes(2)!);return m.Text(9)==Convert.ToBase64String(SHA1.HashData(ChromeBookmarkSync.Specifics(nodes[id],parents[id],m.Bytes(11)!)));}),
        state_fields=ChromeSyncMessage.Parse(sync.Bytes(1)??[]).Encode().Length,
        metadata_sha256=Convert.ToHexString(SHA256.HashData(syncBytes)) }));
    return;
}

var projectRoot = FindProjectRoot(AppContext.BaseDirectory);
var manifest = Path.Combine(projectRoot, "manager", "bookmarks", "bookmark-package.json");
var frozenArtifactRoot = Path.Combine(projectRoot, "manager", "bookmarks", "artifacts");
var changelogPath = Path.Combine(projectRoot, "BOOKMARKLET_CHANGELOG.md");
var bookmarkletRoot = Path.Combine(projectRoot, "bookmarklets");
if (args.Contains("--transaction-audit", StringComparer.Ordinal))
{
    var auditPackage = await BookmarkPackageLoader.LoadAsync(manifest, frozenArtifactRoot);
    Console.WriteLine(JsonSerializer.Serialize(new { ok=true, assertions=BookmarkTransactionAudit.Run(projectRoot, auditPackage), real_chrome_writes=0 }));
    return;
}
var assertions = BookmarkSyncTests.Run();
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    assertions += 1;
}

var rawManifest = JsonNode.Parse(await File.ReadAllTextAsync(manifest, Encoding.UTF8))!.AsObject();
var changelogPlatforms = rawManifest["platforms"]!.AsArray().Select(node =>
{
    var item = node!.AsObject();
    return new BookmarkPlatform(
        item["id"]!.GetValue<string>(),
        item["label"]!.GetValue<string>(),
        string.Empty,
        string.Empty,
        Array.Empty<BookmarkDefinition>(),
        new Dictionary<string, string>(StringComparer.Ordinal));
}).ToArray();
var changelog = await BookmarkChangelog.LoadAsync(changelogPath, changelogPlatforms);
Check(changelog.GetUpgradeNotes("claude", BookmarkProfiles.Full, ["1.1.48"], "1.1.49").Count > 0
      && changelog.GetUpgradeNotes("claude", BookmarkProfiles.AllBranches, ["1.1.48"], "1.1.49").Count > 0,
    "one shared Full/Tree version must provide both upgrade notes");
var lightUpgradeNotes = changelog.GetUpgradeNotes(
    "chatgpt",
    BookmarkProfiles.Light,
    ["3.7.21-light"],
    "3.7.23-light");
Check(lightUpgradeNotes.Count == 1
      && lightUpgradeNotes[0].Version == "3.7.23"
      && lightUpgradeNotes[0].FromVersions.SequenceEqual(["3.7.21-light"])
      && lightUpgradeNotes[0].Summary.Contains("Scheduled", StringComparison.Ordinal)
      && lightUpgradeNotes[0].ReexportGuidance.StartsWith("无需普遍重下。", StringComparison.Ordinal),
    "the accepted ChatGPT Light changelog row did not become a version-scoped update note");
Check(changelog.GetUpgradeNotes(
          "chatgpt",
          BookmarkProfiles.Full,
          ["1.0.18-full"],
          "1.0.19-full").Single().Version == "1.0.19"
      && changelog.GetUpgradeNotes(
          "chatgpt",
          BookmarkProfiles.AllBranches,
          ["1.0.18-all-branches"],
          "1.0.19-all-branches").Single().Version == "1.0.19",
    "Full or AllBranches changelog versions were not mapped to their real profiles");
var canonicalProfileNames = BookmarkChangelog.Parse(
    """
    | 日期 | 平台与版本 | 本次升级 | 旧 HTML 是否重下 |
    | --- | --- | --- | --- |
    | 2026-08-13 | ChatGPT 轻量（Light） `4.0.0`、全量（Full） `2.0.0`、整树（Tree） `2.0.0` | 正式名称测试。 | 无需重下。 |
    """,
    changelogPlatforms);
Check(canonicalProfileNames.GetUpgradeNotes("chatgpt", BookmarkProfiles.Light, ["3.9.9-light"], "4.0.0-light").Count == 1
      && canonicalProfileNames.GetUpgradeNotes("chatgpt", BookmarkProfiles.Full, ["1.9.9-full"], "2.0.0-full").Count == 1
      && canonicalProfileNames.GetUpgradeNotes("chatgpt", BookmarkProfiles.AllBranches, ["1.9.9-all-branches"], "2.0.0-all-branches").Count == 1,
    "the formal Light / Full / Tree names were not mapped to the stable internal profiles");
var renamedLightProfile = BookmarkChangelog.Parse(
    """
    | 日期 | 平台与版本 | 本次升级 | 旧 HTML 是否重下 |
    | --- | --- | --- | --- |
    | 2026-09-08 | ChatGPT 轻装（Light） `4.0.1` | 新称呼。 | 无需重下。 |
    """, changelogPlatforms);
Check(renamedLightProfile.GetUpgradeNotes("chatgpt", BookmarkProfiles.Light, ["4.0.0-light"], "4.0.1-light").Count == 1,
    "New 轻装 changelog entries must resolve to the existing light profile");
var collectionNotes = BookmarkChangelog.Parse("""
    | 日期 | 平台与版本 | 本次升级 | 旧 HTML 是否重下 |
    | --- | --- | --- | --- |
    | 2026-09-15 | 集合`2026.09.15.2`全部32轨验收；本次升级：ChatGPT Light3.7.41/Full1.0.37/Tree1.0.38；DeepSeek Light2.8.10/Full、Tree1.0.7（Light=轻装，Full=全量，Tree=整树）。 | 保留真实格式。 | 按需重下。 |
    """, changelogPlatforms);
foreach (var (platform, profile, version) in new[] {
    ("chatgpt", BookmarkProfiles.Light, "3.7.41"), ("chatgpt", BookmarkProfiles.Full, "1.0.37"), ("chatgpt", BookmarkProfiles.AllBranches, "1.0.38"),
    ("deepseek", BookmarkProfiles.Light, "2.8.10"), ("deepseek", BookmarkProfiles.Full, "1.0.7"), ("deepseek", BookmarkProfiles.AllBranches, "1.0.7") })
    Check(collectionNotes.GetUpgradeNotes(platform, profile, ["1.0.0"], version).Single().Version == version, "A compact collection row lost an explicit platform/profile version");
Check(changelog.GetUpgradeNotes(
          "chatgpt",
          BookmarkProfiles.Light,
          ["3.7.23-light"],
          "3.7.23-light").Count == 0
      && changelog.GetUpgradeNotes(
          "chatgpt",
          BookmarkProfiles.Light,
          ["3.7.13-light"],
          "3.7.14-light").Count == 0
      && changelog.GetUpgradeNotes(
          "chatgpt",
          BookmarkProfiles.Light,
          ["legacy-version"],
          "3.7.23-light").Count == 0,
    "the changelog fabricated an upgrade for a current, older packaged, or uncomparable bookmark");
if (args.Contains("--changelog-only", StringComparer.Ordinal))
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        ok = true,
        assertions,
        changelog = Path.GetFileName(changelogPath)
    }, new JsonSerializerOptions { WriteIndented = true }));
    return;
}

var package = await BookmarkPackageLoader.LoadAsync(manifest, frozenArtifactRoot);
var sourceHashes = Directory.EnumerateFiles(bookmarkletRoot, "*.min.js", SearchOption.AllDirectories)
    .ToDictionary(path => Path.GetRelativePath(bookmarkletRoot, path), FileHash, StringComparer.Ordinal);
Check(package.Format == "cloudig/bookmark-package" && package.Version == "0.2.0", "bookmark package contract is not 0.2.0");
Check(package.Platforms.Count == 12 && package.VariantCount == 32, "bookmark package is not 12 platforms / 32 variants");
Check(package.Bookmarks.Count == 12, "flat compatibility surface did not resolve exactly 12 default bookmarks");
foreach (var profile in BookmarkProfiles.All)
{
    var selection = package.Resolve(profile);
    Check(selection.Bookmarks.Count == 12
          && selection.Bookmarks.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() == 12,
        $"{profile} did not resolve exactly one bookmark per platform");
}
var allBranches = package.Resolve(BookmarkProfiles.AllBranches);
Check(allBranches.Bookmarks.Count(item => item.Fallback) == 4
      && allBranches.Bookmarks.Where(item => item.Fallback).All(item => item.EffectiveProfile == BookmarkProfiles.Full),
    "all_branches did not resolve exactly four full fallbacks");
Check(allBranches.Bookmarks.Count(item => !item.Fallback && item.EffectiveProfile == BookmarkProfiles.AllBranches) == 8,
    "all_branches did not resolve eight native variants");
var rootCompatibility = await BookmarkPackageLoader.LoadAsync(manifest, Path.Combine(frozenArtifactRoot, "bookmarklets"));
Check(rootCompatibility.VariantCount == 32, "frozen bookmarklets-root compatibility did not resolve package-relative artifacts");

var temporaryRoot = Path.Combine(projectRoot, "manager", ".test-temp", $"cloudig-bookmarks-{Guid.NewGuid():N}");
try
{
    var userData = Path.Combine(temporaryRoot, "User Data");
    var defaultProfile = Path.Combine(userData, "Default");
    var secondProfile = Path.Combine(userData, "Profile 1");
    Directory.CreateDirectory(defaultProfile);
    Directory.CreateDirectory(secondProfile);
    await File.WriteAllTextAsync(Path.Combine(userData, "Local State"), """
        {
          "profile": {
            "last_used": "Default",
            "info_cache": {
              "Default": { "name": "测试主配置" },
              "Profile 1": { "name": "测试备用配置" }
            }
          }
        }
        """, Encoding.UTF8);
    var firstStore = Path.Combine(defaultProfile, "Bookmarks");
    var secondStore = Path.Combine(secondProfile, "Bookmarks Account");
    var empty = CreateEmptyBookmarks();
    await File.WriteAllTextAsync(firstStore, empty, new UTF8Encoding(false));
    await File.WriteAllTextAsync(secondStore, empty, new UTF8Encoding(false));
    var backupRoot = Path.Combine(temporaryRoot, "Backups");
    var manager = new BookmarkManager(manifest, frozenArtifactRoot, backupRoot, userData, changelogPath);
    var platformIds = package.Platforms.Select(item => item.Id).ToArray();
    Check(platformIds.Length == 12, "one-click platform selection is not explicit 12");

    var initial = await manager.SummarizeAsync(BookmarkProfiles.Light);
    Check(initial.RequestedProfile == BookmarkProfiles.Light
          && initial.AvailableProfiles.SequenceEqual(BookmarkProfiles.All)
          && initial.Profiles.Count == 2
          && initial.Stores.Count == 2,
        "profile-aware initial summary is incomplete");
    Check(initial.Bookmarks.Count == 12
          && initial.Bookmarks.All(item => item.RequestedProfile == BookmarkProfiles.Light
                                          && item.EffectiveProfile == BookmarkProfiles.Light
                                          && !item.Fallback
                                          && item.UpgradeNotes.Count == 0)
          && initial.BookmarkChangelogError.Length == 0,
        "Light summary did not expose 12 effective platform entries");
    Check(initial.Stores.All(item => item.Status == "missing"
                                     && item.Bookmarks.Count == 12
                                     && item.Bookmarks.All(bookmark => bookmark.Status == "missing")),
        "empty stores did not expose 12 missing platforms");
    Check(await manager.ReadSourceAsync("chatgpt", BookmarkProfiles.Full)
          == package.Resolve(BookmarkProfiles.Full).Bookmarks.Single(item => item.Id == "chatgpt").Definition.Url,
        "profile-aware source read did not return the exact Full URL");
    await ExpectFailure(() => manager.ReadSourceAsync("unknown", BookmarkProfiles.Light), "unknown bookmark id");
    var fixedTime = new DateTime(2026, 7, 31, 12, 0, 0, DateTimeKind.Utc);

    // A configured formal folder is the only ownership boundary. A test folder may contain
    // a byte-identical, Cloudig-tagged copy and must remain invisible to formal operations.
    var scopedProfile = Path.Combine(userData, "Profile 2");
    Directory.CreateDirectory(scopedProfile);
    var scopedStore = Path.Combine(scopedProfile, "Bookmarks");
    var scopedDocument = JsonNode.Parse(empty)!.AsObject();
    var scopedBar = scopedDocument["roots"]!["bookmark_bar"]!.AsObject();
    var formalInstallationId = Guid.NewGuid().ToString("D").ToLowerInvariant();
    var testFolder = SyntheticFolder("40", "书签测试", testFolder: true);
    var testBookmark = TestBookmark(
        "41",
        "测试版 ChatGPT",
        package.Resolve(BookmarkProfiles.Light).Bookmarks.Single(item => item.Id == "chatgpt").Definition.Url,
        "chatgpt:light",
        formalInstallationId);
    testFolder["children"]!.AsArray().Add(testBookmark);
    scopedBar["children"]!.AsArray().Add(testFolder);
    RefreshChecksums(scopedDocument);
    WriteDocument(scopedStore, scopedDocument);
    var rootGuid = scopedBar["guid"]!.GetValue<string>();
    var formalTarget = new BookmarkInstallTarget(
        scopedStore,
        rootGuid,
        "采云 Cloudig",
        true,
        formalInstallationId,
        string.Empty,
        true);
    var scopedInstall = await manager.ExecuteAsync(
        [scopedStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Light,
        platformIds,
        formalTarget,
        requireChromeClosed: false,
        utcNow: fixedTime);
    var formalFolderGuid = scopedInstall.Stores.Single().Mutation.ManagedFolderGuid;
    var afterScopedInstall = ReadDocument(scopedStore);
    var afterScopedBar = afterScopedInstall["roots"]!["bookmark_bar"]!.AsObject();
    var directFolders = afterScopedBar["children"]!.AsArray().Select(node => node!.AsObject()).ToArray();
    var formalFolder = directFolders.Single(node => node["guid"]!.GetValue<string>() == formalFolderGuid);
    Check(scopedInstall.AddedCount == 13
          && directFolders[0]["guid"]!.GetValue<string>() == formalFolderGuid
          && formalFolder["name"]!.GetValue<string>() == "采云 Cloudig"
          && formalFolder["children"]!.AsArray().Count == 12
          && formalFolder["children"]!.AsArray().All(node => node!["type"]!.GetValue<string>() == "url")
          && Meta(directFolders.Single(node => node["name"]!.GetValue<string>() == "书签测试"), "cloudig_folder") is null
          && directFolders.Single(node => node["name"]!.GetValue<string>() == "书签测试")["children"]!.AsArray().Single()!["name"]!.GetValue<string>() == "测试版 ChatGPT",
        "formal install was not flat, first, or isolated from the test folder");

    // PlaceFirst applies to every install, not just folder creation or settings save.
    var installTarget = formalTarget with { ManagedFolderGuid = formalFolderGuid, PlacementPending = false };
    afterScopedBar["children"]!.AsArray().Remove(formalFolder);
    afterScopedBar["children"]!.AsArray().Add(formalFolder);
    RefreshChecksums(afterScopedInstall);
    WriteDocument(scopedStore, afterScopedInstall);
    await manager.ExecuteAsync([scopedStore], BookmarkOperation.InstallOrRepair, BookmarkProfiles.Light, platformIds,
        installTarget with { PlaceFirst = false }, requireChromeClosed: false, utcNow: fixedTime.AddSeconds(20));
    Check(ReadDocument(scopedStore)["roots"]!["bookmark_bar"]!["children"]!.AsArray()[0]!["name"]!.GetValue<string>() == "书签测试",
        "install reordered the folder after PlaceFirst was disabled");
    await manager.ExecuteAsync([scopedStore], BookmarkOperation.InstallOrRepair, BookmarkProfiles.Light, platformIds,
        installTarget, requireChromeClosed: false, utcNow: fixedTime.AddSeconds(40));
    afterScopedInstall = ReadDocument(scopedStore);
    afterScopedBar = afterScopedInstall["roots"]!["bookmark_bar"]!.AsObject();
    formalFolder = afterScopedBar["children"]!.AsArray()[0]!.AsObject();
    Check(formalFolder["guid"]!.GetValue<string>() == formalFolderGuid,
        "repeat installation did not put the managed folder first");

    // Renaming and moving the formal folder keeps its GUID. Routine updates follow it in place
    // and do not force it back to the saved default path.
    var customParent = SyntheticFolder("42", "老婆的自定义目录");
    var scopedChildren = afterScopedBar["children"]!.AsArray();
    scopedChildren.Remove(formalFolder);
    formalFolder["name"] = "老婆改名的采云书签";
    customParent["children"]!.AsArray().Add(formalFolder);
    scopedChildren.Add(customParent);
    RefreshChecksums(afterScopedInstall);
    WriteDocument(scopedStore, afterScopedInstall);
    formalTarget = formalTarget with { ManagedFolderGuid = formalFolderGuid, PlacementPending = false };
    var scopedFull = await manager.ExecuteAsync(
        [scopedStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Full,
        platformIds,
        formalTarget,
        requireChromeClosed: false,
        utcNow: fixedTime.AddMinutes(1));
    var afterScopedFull = ReadDocument(scopedStore);
    var movedFormal = Walk(afterScopedFull).Single(node => node["guid"]?.GetValue<string>() == formalFolderGuid);
    var targetContext = await manager.DescribeTargetAsync(scopedStore, formalTarget);
    Check(scopedFull.AddedCount == 12
          && movedFormal["name"]!.GetValue<string>() == "老婆改名的采云书签"
          && movedFormal["children"]!.AsArray().Count == 24
          && targetContext.Exists
          && targetContext.DisplayPath.EndsWith("老婆的自定义目录 / 老婆改名的采云书签", StringComparison.Ordinal),
        "a routine update failed to respect the user-renamed and moved formal folder");

    // A formal bookmark moved out of the selected folder becomes user-owned. Uninstall removes
    // only registered direct children and never touches the test copy or the moved bookmark.
    var movedChildren = movedFormal["children"]!.AsArray();
    var escaped = movedChildren.Select(node => node!.AsObject())
        .Single(node => ManagedVariantId(node) == "chatgpt:full");
    movedChildren.Remove(escaped);
    afterScopedFull["roots"]!["other"]!["children"]!.AsArray().Add(escaped);
    RefreshChecksums(afterScopedFull);
    WriteDocument(scopedStore, afterScopedFull);
    var scopedRemove = await manager.ExecuteAsync(
        [scopedStore],
        BookmarkOperation.Remove,
        BookmarkProfiles.Full,
        platformIds,
        formalTarget,
        requireChromeClosed: false,
        utcNow: fixedTime.AddMinutes(2));
    var afterScopedRemove = ReadDocument(scopedStore);
    var preservedTest = Walk(afterScopedRemove).Single(node => node["name"]?.GetValue<string>() == "书签测试");
    Check(scopedRemove.RemovedCount == 11
          && Walk(afterScopedRemove).Any(node => node["guid"]?.GetValue<string>() == escaped["guid"]!.GetValue<string>())
          && preservedTest["children"]!.AsArray().Single()!["name"]!.GetValue<string>() == "测试版 ChatGPT"
          && Walk(afterScopedRemove).Single(node => node["guid"]?.GetValue<string>() == formalFolderGuid)["children"]!.AsArray().Count == 12,
        "formal uninstall escaped its selected folder or changed the test set");

    var stores = initial.Stores.Select(item => item.Store.Path).ToArray();
    var installed = await manager.ExecuteAsync(
        stores,
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Light,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime);
    Check(installed.ChangedStoreCount == 2 && installed.AddedCount == 26,
        "Light first install did not add one folder plus 12 bookmarks per store");
    var lightDocument = ReadDocument(firstStore);
    var lightNodes = ManagedNodes(lightDocument).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(lightNodes.Count == 12
          && lightNodes.Keys.All(id => id.EndsWith(":light", StringComparison.Ordinal))
          && lightNodes.Values.All(node => Meta(node, "cloudig_profile") == BookmarkProfiles.Light)
          && lightNodes.Values.All(node => node["name"]!.GetValue<string>().Contains("（轻装）· ", StringComparison.Ordinal)),
        "Light install did not create one distinct, labelled physical variant per platform");
    var stableNodeIds = lightNodes.ToDictionary(pair => pair.Key, pair => pair.Value["id"]!.GetValue<string>(), StringComparer.Ordinal);

    // User titles are never package state. Installing another profile must add a sibling
    // physical variant without rewriting or removing the already installed Light node.
    lightNodes["chatgpt:light"]["name"] = "老婆改过的 ChatGPT 书签名";
    RefreshChecksums(lightDocument);
    WriteDocument(firstStore, lightDocument);
    var beforeFull = await manager.SummarizeAsync(BookmarkProfiles.Full);
    var beforeFullStore = beforeFull.Stores.Single(item => item.Store.Path == firstStore);
    Check(beforeFullStore.Status == "missing"
          && beforeFullStore.ManagedCount == 12
          && beforeFullStore.Bookmarks.All(item => item.Status == "missing"),
        "an installed Light set was incorrectly treated as the mutually exclusive Full slot");
    var installedFull = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Full,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(1));
    Check(installedFull.AddedCount == 12 && installedFull.UpdatedCount == 0,
        "Full incremental install replaced Light instead of adding 12 physical variants");
    var fullDocument = ReadDocument(firstStore);
    var fullNodes = ManagedNodes(fullDocument).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(fullNodes.Count == 24
          && BookmarkProfiles.All.Take(2).All(profile => platformIds.All(id => fullNodes.ContainsKey($"{id}:{profile}")))
          && stableNodeIds.All(pair => fullNodes[pair.Key]["id"]!.GetValue<string>() == pair.Value)
          && fullNodes.Where(pair => pair.Key.EndsWith(":full", StringComparison.Ordinal))
              .All(pair => Meta(pair.Value, "cloudig_profile") == BookmarkProfiles.Full),
        "Full incremental install did not preserve all Light nodes and add all Full nodes");
    Check(fullNodes["chatgpt:light"]["name"]!.GetValue<string>() == "老婆改过的 ChatGPT 书签名"
          && fullNodes["chatgpt:full"]["name"]!.GetValue<string>().Contains("（全量）· ", StringComparison.Ordinal),
        "Full incremental install overwrote a user-renamed Light bookmark or failed to distinguish its title");
    Check((await manager.SummarizeAsync(BookmarkProfiles.Light)).Stores.Single(item => item.Store.Path == firstStore).Status == "current"
          && (await manager.SummarizeAsync(BookmarkProfiles.Full)).Stores.Single(item => item.Store.Path == firstStore).Status == "current",
        "installing Full made the independent Light summary non-current");

    var installedBranches = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.AllBranches,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(2));
    Check(installedBranches.AddedCount == 8 && installedBranches.UpdatedCount == 0,
        "Tree incremental install did not add exactly eight native physical variants while reusing four Full fallbacks");
    var branchDocument = ReadDocument(firstStore);
    var branchNodes = ManagedNodes(branchDocument).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(branchNodes.Count == 32
          && package.Platforms.SelectMany(item => item.Variants).All(item => branchNodes.ContainsKey(item.VariantId)),
        "installing Light, Full, and Tree did not produce the package's exact 32 physical variants");
    foreach (var expected in allBranches.Bookmarks)
    {
        Check(Meta(branchNodes[expected.Definition.VariantId], "cloudig_profile") == expected.EffectiveProfile,
            $"AllBranches installed the wrong effective profile for {expected.Id}");
    }
    var branchSummary = await manager.SummarizeAsync(BookmarkProfiles.AllBranches);
    var firstBranchStatus = branchSummary.Stores.Single(item => item.Store.Path == firstStore);
    Check(firstBranchStatus.Status == "current"
          && firstBranchStatus.ManagedCount == 32
          && firstBranchStatus.Bookmarks.Count(item => item.Fallback) == 4
          && firstBranchStatus.Bookmarks.All(item => item.Status == "current"),
        "AllBranches summary did not expose current/effective/fallback state");
    Check((await manager.SummarizeAsync(BookmarkProfiles.Light)).Stores.Single(item => item.Store.Path == firstStore).Status == "current"
          && (await manager.SummarizeAsync(BookmarkProfiles.Full)).Stores.Single(item => item.Store.Path == firstStore).Status == "current",
        "installing Tree invalidated an already installed Light or Full set");

    var branchBytes = await File.ReadAllBytesAsync(firstStore);
    var encodedDocument = ReadDocument(firstStore);
    foreach (var node in ManagedNodes(encodedDocument))
    {
        var url = node["url"]!.GetValue<string>();
        node["url"] = string.Concat(url.EnumerateRunes().Select(rune => rune.Value > 127 || rune.Value is 32 or 34 or 60 or 62
            ? Uri.EscapeDataString(rune.ToString()) : rune.ToString()));
    }
    RefreshChecksums(encodedDocument);
    WriteDocument(firstStore, encodedDocument);
    Check((await manager.SummarizeAsync(BookmarkProfiles.AllBranches)).Stores.Single(item => item.Store.Path == firstStore).Bookmarks.All(item => item.Status == "current"), "Chrome URL escaping must not turn the current package into yellow update warnings");
    var encodedBytes = await File.ReadAllBytesAsync(firstStore);
    var encodedRepair = await manager.ExecuteAsync([firstStore], BookmarkOperation.InstallOrRepair, BookmarkProfiles.AllBranches, platformIds, requireChromeClosed: false, utcNow: fixedTime.AddHours(3));
    Check(encodedRepair.ChangedStoreCount == 0 && (await File.ReadAllBytesAsync(firstStore)).SequenceEqual(encodedBytes), "an equivalent escaped URL must not cause repeated repair writes");
    await File.WriteAllBytesAsync(firstStore, branchBytes);
    var newerDocument = ReadDocument(firstStore);
    var newerNode = ManagedNodes(newerDocument).Single(node => ManagedVariantId(node) == "chatgpt:all_branches");
    newerNode["meta_info"]!["cloudig_version"] = "999.10.0-all-branches";
    newerNode["url"] = "javascript:void('newer fixture')";
    RefreshChecksums(newerDocument);
    WriteDocument(firstStore, newerDocument);
    var newerSummary = (await manager.SummarizeAsync(BookmarkProfiles.AllBranches)).Stores.Single(item => item.Store.Path == firstStore);
    Check(newerSummary.Status == "newer" && newerSummary.Bookmarks.Single(item => item.Id == "chatgpt").Status == "newer", "newer installed version must not be marked for downgrade");
    await manager.ExecuteAsync([firstStore], BookmarkOperation.InstallOrRepair, BookmarkProfiles.AllBranches, platformIds, requireChromeClosed: false, utcNow: fixedTime.AddHours(3));
    Check(ManagedNodes(ReadDocument(firstStore)).Single(node => ManagedVariantId(node) == "chatgpt:all_branches")["url"]!.GetValue<string>() == "javascript:void('newer fixture')", "install-all must preserve newer owned bytes");
    await File.WriteAllBytesAsync(firstStore, branchBytes);
    var driftedDocument = ReadDocument(firstStore);
    ManagedNodes(driftedDocument).Single(node => ManagedVariantId(node) == "chatgpt:all_branches")["url"] = "javascript:void 0";
    RefreshChecksums(driftedDocument);
    WriteDocument(firstStore, driftedDocument);
    var outdatedStatus = (await manager.SummarizeAsync(BookmarkProfiles.AllBranches))
        .Stores.Single(item => item.Store.Path == firstStore);
    Check(outdatedStatus.Status == "outdated"
          && outdatedStatus.Bookmarks.Single(item => item.Id == "chatgpt").Status == "outdated",
        "same-profile content drift was not reported as outdated");
    await File.WriteAllBytesAsync(firstStore, branchBytes);
    var invalidDocument = ReadDocument(firstStore);
    invalidDocument["checksum"] = new string('0', 32);
    WriteDocument(firstStore, invalidDocument);
    var invalidStatus = (await manager.SummarizeAsync(BookmarkProfiles.AllBranches))
        .Stores.Single(item => item.Store.Path == firstStore);
    Check(invalidStatus.Status == "invalid"
          && invalidStatus.Bookmarks.All(item => item.Status == "invalid"),
        "invalid Chrome checksum was not isolated as invalid status");
    await File.WriteAllBytesAsync(firstStore, branchBytes);

    var repeated = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.AllBranches,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(3));
    Check(repeated.ChangedStoreCount == 0
          && (await File.ReadAllBytesAsync(firstStore)).SequenceEqual(branchBytes),
        "AllBranches repair was not byte-idempotent");

    var removed = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.Remove,
        BookmarkProfiles.AllBranches,
        ["chatgpt"],
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(4));
    var afterTreeRemoval = ManagedNodes(ReadDocument(firstStore)).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(removed.RemovedCount == 1
          && afterTreeRemoval.Count == 31
          && !afterTreeRemoval.ContainsKey("chatgpt:all_branches")
          && afterTreeRemoval.ContainsKey("chatgpt:light")
          && afterTreeRemoval.ContainsKey("chatgpt:full"),
        "row uninstall removed another ChatGPT profile instead of only the selected Tree variant");
    var restored = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.AllBranches,
        ["chatgpt"],
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(5));
    Check(restored.AddedCount == 1 && ManagedNodes(ReadDocument(firstStore)).Count() == 32,
        "row install did not restore exactly one selected Tree variant");

    var removedFull = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.Remove,
        BookmarkProfiles.Full,
        ["chatgpt"],
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(5.5));
    var afterFullRemoval = ManagedNodes(ReadDocument(firstStore)).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(removedFull.RemovedCount == 1
          && !afterFullRemoval.ContainsKey("chatgpt:full")
          && afterFullRemoval.ContainsKey("chatgpt:light")
          && afterFullRemoval.ContainsKey("chatgpt:all_branches")
          && (await manager.SummarizeAsync(BookmarkProfiles.Full)).Stores.Single(item => item.Store.Path == firstStore)
              .Bookmarks.Single(item => item.Id == "chatgpt").Status == "missing"
          && (await manager.SummarizeAsync(BookmarkProfiles.AllBranches)).Stores.Single(item => item.Store.Path == firstStore)
              .Bookmarks.Single(item => item.Id == "chatgpt").Status == "current",
        "Full uninstall was not scoped independently from Light and native Tree");
    await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Full,
        ["chatgpt"],
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(5.75));

    // Reconstruct the old 11-item Light metadata contract: no Claude, no cloudig_profile,
    // and ai_chat_archive_* keys. One repair must migrate in place and add Claude.
    await File.WriteAllTextAsync(firstStore, empty, new UTF8Encoding(false));
    await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Light,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(6));
    SimulateLegacyEleven(firstStore);
    var legacyInspection = await manager.SummarizeAsync(BookmarkProfiles.Light);
    var legacyStatus = legacyInspection.Stores.Single(item => item.Store.Path == firstStore);
    Check(legacyStatus.ManagedCount == 11
          && legacyStatus.Bookmarks.Single(item => item.Id == "claude").Status == "missing"
          && legacyStatus.Bookmarks.Where(item => item.Id != "claude").All(item => item.InstalledProfile == BookmarkProfiles.Light),
        "legacy metadata was not recognized as the old Light profile");
    var migrated = await manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Light,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(7));
    Check(migrated.AddedCount == 1 && migrated.UpdatedCount == 11,
        "legacy 11-item Light set did not migrate and add Claude");
    var migratedDocument = ReadDocument(firstStore);
    Check(ManagedNodes(migratedDocument).Count() == 12
          && ManagedNodes(migratedDocument).All(node => Meta(node, "cloudig_profile") == BookmarkProfiles.Light)
          && ManagedNodes(migratedDocument).All(node => ManagedVariantId(node).EndsWith(":light", StringComparison.Ordinal))
          && ManagedNodes(migratedDocument).All(node => node["name"]!.GetValue<string>().Contains("（轻装）· ", StringComparison.Ordinal))
          && Walk(migratedDocument).All(node => node["meta_info"] is not JsonObject meta
                                                || !meta.Any(pair => pair.Key.StartsWith("ai_chat_archive_", StringComparison.Ordinal))),
        "legacy metadata migration left stale tags or wrong profiles");

    // A platform without a native Tree artifact has one physical Full slot. Installing
    // Tree first must create that slot once; later Full sees the same bookmark as current.
    await File.WriteAllTextAsync(secondStore, empty, new UTF8Encoding(false));
    var fallbackFirst = await manager.ExecuteAsync(
        [secondStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.AllBranches,
        ["gemini"],
        requireChromeClosed: false,
        utcNow: fixedTime.AddHours(8));
    var fallbackNodes = ManagedNodes(ReadDocument(secondStore)).ToDictionary(ManagedVariantId, StringComparer.Ordinal);
    Check(fallbackFirst.AddedCount == 2
          && fallbackNodes.Count == 1
          && fallbackNodes.ContainsKey("gemini:full")
          && (await manager.SummarizeAsync(BookmarkProfiles.Full)).Stores.Single(item => item.Store.Path == secondStore)
              .Bookmarks.Single(item => item.Id == "gemini").Status == "current"
          && (await manager.SummarizeAsync(BookmarkProfiles.AllBranches)).Stores.Single(item => item.Store.Path == secondStore)
              .Bookmarks.Single(item => item.Id == "gemini").Status == "current",
        "Tree fallback created a duplicate physical bookmark instead of reusing Gemini Full");

    // Transactional two-store rollback remains intact with an explicit 12-platform selection.
    await File.WriteAllTextAsync(firstStore, empty, new UTF8Encoding(false));
    await File.WriteAllTextAsync(secondStore, empty, new UTF8Encoding(false));
    var originalFirst = await File.ReadAllBytesAsync(firstStore);
    var originalSecond = await File.ReadAllBytesAsync(secondStore);
    await ExpectFailure(() => manager.ExecuteAsync(
        stores,
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Full,
        platformIds,
        requireChromeClosed: false,
        utcNow: fixedTime.AddDays(1),
        beforeWriteForTests: (index, _) =>
        {
            if (index == 1) throw new IOException("injected transaction failure");
        }), "restored");
    Check((await File.ReadAllBytesAsync(firstStore)).SequenceEqual(originalFirst)
          && (await File.ReadAllBytesAsync(secondStore)).SequenceEqual(originalSecond),
        "two-store profile install failure did not restore both originals");

    await ExpectFailure(() => manager.ExecuteAsync(
        [firstStore],
        BookmarkOperation.InstallOrRepair,
        BookmarkProfiles.Light,
        Array.Empty<string>(),
        requireChromeClosed: false), "at least one");
}
finally
{
    if (Directory.Exists(temporaryRoot)) Directory.Delete(temporaryRoot, recursive: true);
}

var finalHashes = Directory.EnumerateFiles(bookmarkletRoot, "*.min.js", SearchOption.AllDirectories)
    .ToDictionary(path => Path.GetRelativePath(bookmarkletRoot, path), FileHash, StringComparer.Ordinal);
Check(sourceHashes.Count == finalHashes.Count
      && sourceHashes.All(pair => finalHashes.GetValueOrDefault(pair.Key) == pair.Value),
    "bookmark tests modified protected bookmarklet artifacts");
assertions += BookmarkTransactionAudit.Run(projectRoot, package);

Console.WriteLine(JsonSerializer.Serialize(new
{
    ok = true,
    assertions,
    platforms = package.Platforms.Count,
    variants = package.VariantCount,
    effective_per_profile = package.EffectiveCountPerProfile,
    fallbacks = allBranches.Bookmarks.Count(item => item.Fallback),
    real_chrome_writes = 0
}, new JsonSerializerOptions { WriteIndented = true }));

static string FindProjectRoot(string start)
{
    var cursor = new DirectoryInfo(start);
    while (cursor is not null
           && !File.Exists(Path.Combine(cursor.FullName, "manager", "bookmarks", "bookmark-package.json")))
    {
        cursor = cursor.Parent;
    }
    return cursor?.FullName
           ?? throw new DirectoryNotFoundException("Cloudig bookmark test could not locate the repository root.");
}

static string FileHash(string path)
{
    using var stream = File.OpenRead(path);
    return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
}

static JsonObject SyntheticFolder(string id, string name, bool testFolder = false)
{
    var node = new JsonObject
    {
        ["children"] = new JsonArray(),
        ["date_added"] = "0",
        ["date_last_used"] = "0",
        ["date_modified"] = "0",
        ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
        ["id"] = id,
        ["name"] = name,
        ["type"] = "folder"
    };
    if (testFolder) node["meta_info"] = new JsonObject { ["cloudig_test_folder"] = "1" };
    return node;
}

static JsonObject TestBookmark(string id, string name, string url, string variantId, string installationId) => new()
{
    ["date_added"] = "0",
    ["date_last_used"] = "0",
    ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
    ["id"] = id,
    ["meta_info"] = new JsonObject
    {
        ["cloudig_managed"] = "1",
        ["cloudig_id"] = variantId,
        ["cloudig_profile"] = BookmarkProfiles.Light,
        ["cloudig_installation_id"] = installationId
    },
    ["name"] = name,
    ["type"] = "url",
    ["url"] = url
};

static string CreateEmptyBookmarks()
{
    static JsonObject Root(string id, string name) => new()
    {
        ["children"] = new JsonArray(),
        ["date_added"] = "0",
        ["date_last_used"] = "0",
        ["date_modified"] = "0",
        ["guid"] = Guid.NewGuid().ToString("D").ToLowerInvariant(),
        ["id"] = id,
        ["name"] = name,
        ["type"] = "folder"
    };
    var document = new JsonObject
    {
        ["checksum"] = "",
        ["checksum_sha256"] = "",
        ["roots"] = new JsonObject
        {
            ["bookmark_bar"] = Root("1", "Bookmarks bar"),
            ["other"] = Root("2", "Other bookmarks"),
            ["synced"] = Root("3", "Mobile bookmarks")
        },
        ["version"] = 1
    };
    RefreshChecksums(document);
    return Serialize(document);
}

static void SimulateLegacyEleven(string path)
{
    var document = ReadDocument(path);
    var folder = Walk(document).Single(node => Meta(node, "cloudig_folder") == "1");
    var children = folder["children"]!.AsArray();
    var kept = new JsonArray();
    foreach (var raw in children.ToArray())
    {
        var node = raw!.AsObject();
        if (node["meta_info"] is not JsonObject meta
            || Meta(node, "cloudig_managed") != "1")
        {
            kept.Add(node.DeepClone());
            continue;
        }
        var platformId = (Meta(node, "cloudig_id") ?? throw new InvalidDataException("managed test node has no id"))
            .Split(':', 2, StringSplitOptions.None)[0];
        if (platformId == "claude") continue;
        meta["cloudig_id"] = platformId;
        meta.Remove("cloudig_profile");
        var previousTitle = node["name"]!.GetValue<string>().Replace("（轻量）-Cloudig", "-Cloudig", StringComparison.Ordinal);
        node["name"] = previousTitle;
        meta["cloudig_default_title"] = previousTitle;
        MoveMeta(meta, "cloudig_managed", "ai_chat_archive_managed");
        MoveMeta(meta, "cloudig_id", "ai_chat_archive_id");
        MoveMeta(meta, "cloudig_version", "ai_chat_archive_version");
        MoveMeta(meta, "cloudig_sha256", "ai_chat_archive_sha256");
        kept.Add(node.DeepClone());
    }
    folder["children"] = kept;
    var folderMeta = folder["meta_info"]!.AsObject();
    MoveMeta(folderMeta, "cloudig_folder", "ai_chat_archive_folder");
    MoveMeta(folderMeta, "cloudig_set_version", "ai_chat_archive_set_version");
    RefreshChecksums(document);
    WriteDocument(path, document);
}

static void MoveMeta(JsonObject meta, string current, string legacy)
{
    if (meta[current] is JsonNode value) meta[legacy] = value.DeepClone();
    meta.Remove(current);
}

static IEnumerable<JsonObject> ManagedNodes(JsonObject document) =>
    Walk(document).Where(node => Meta(node, "cloudig_managed") == "1"
                                 || Meta(node, "ai_chat_archive_managed") == "1");

static string ManagedVariantId(JsonObject node) =>
    Meta(node, "cloudig_id") ?? Meta(node, "ai_chat_archive_id")
    ?? throw new InvalidDataException("managed test node has no id");

static string? Meta(JsonObject node, string key) =>
    node["meta_info"] is JsonObject meta && meta[key] is JsonValue value && value.TryGetValue<string>(out var result)
        ? result
        : null;

static JsonObject ReadDocument(string path) => JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8))!.AsObject();

static void WriteDocument(string path, JsonObject document) =>
    File.WriteAllText(path, Serialize(document), new UTF8Encoding(false));

static IEnumerable<JsonObject> Walk(JsonObject document)
{
    var roots = document["roots"]!.AsObject();
    var stack = new Stack<JsonObject>(
        [roots["synced"]!.AsObject(), roots["other"]!.AsObject(), roots["bookmark_bar"]!.AsObject()]);
    while (stack.Count > 0)
    {
        var node = stack.Pop();
        yield return node;
        if (node["children"] is not JsonArray children) continue;
        for (var index = children.Count - 1; index >= 0; index--) stack.Push(children[index]!.AsObject());
    }
}

static void RefreshChecksums(JsonObject document)
{
    var value = ChromeBookmarkChecksums.Compute(document);
    document["checksum"] = value.Md5;
    document["checksum_sha256"] = value.Sha256;
}

static string Serialize(JsonObject document) =>
    document.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;

static async Task ExpectFailure(Func<Task> action, string messageFragment)
{
    try
    {
        await action();
        throw new InvalidOperationException($"Expected failure containing: {messageFragment}");
    }
    catch (Exception error) when (error.Message.Contains(messageFragment, StringComparison.OrdinalIgnoreCase))
    {
        return;
    }
}
