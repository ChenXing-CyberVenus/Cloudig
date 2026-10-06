using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;

var projectRoot = FindProjectRoot(AppContext.BaseDirectory);
var temporaryRoot = Path.Combine(projectRoot, "manager", ".test-temp", $"bookmark-test-installer-{Guid.NewGuid():N}");
var assertions = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    assertions += 1;
}

try
{
    Directory.CreateDirectory(temporaryRoot);
    Check(BookmarkTestStoragePolicy.ResolveDataRoot(Path.Combine(projectRoot, "bookmarklets", "candidate", "test"), []) == Path.GetFullPath(Path.Combine(projectRoot, "..", "Cloudig-Test")), "repository installer shares the explicit continuous test data root");
    Check(BookmarkTestStoragePolicy.ResolveDataRoot(temporaryRoot, []) is null, "standalone installer asks instead of guessing an AppData folder");
    Check(BookmarkTestStoragePolicy.ResolveDataRoot(temporaryRoot, ["--data-root", temporaryRoot]) == temporaryRoot, "explicit installer data root is preserved");
    var artifacts = Path.Combine(temporaryRoot, "candidate-test");
    Directory.CreateDirectory(artifacts);
    var firstName = "01-1_ChatGPT_轻量（Light）_1.0.0-light.min.js";
    var secondName = "02-2_DeepSeek_全量（Full）_2.0.0-full.min.js";
    File.WriteAllText(Path.Combine(artifacts, firstName), "javascript:(()=>{return'one'})()", new UTF8Encoding(false));
    File.WriteAllText(Path.Combine(artifacts, secondName), "javascript:(()=>{return'two'})()", new UTF8Encoding(false));

    var package = BookmarkTestDirectoryLoader.Load(artifacts);
    Check(package.Bookmarks.Count == 2
          && package.Bookmarks.Select(item => item.Id).SequenceEqual(["candidate-test-01-1", "candidate-test-02-2"]),
        "dynamic loader did not derive stable acceptance slot ids");
    Check(package.Bookmarks.All(item => item.Url.StartsWith("javascript:", StringComparison.Ordinal)
                                        && !item.Url.Contains('\n')),
        "dynamic loader accepted a non-bookmarklet artifact");
    Check(package.Bookmarks.Select(item=>item.TitleZh).SequenceEqual(["ChatGPT（轻装）· 1.0.0-Light · Cloudig","DeepSeek（全量）· 2.0.0-Full · Cloudig"]),
        "Standalone installer did not use the bilingual numeric-version naming rule");

    var storePath = Path.Combine(temporaryRoot, "User Data", "Default", "Bookmarks");
    Directory.CreateDirectory(Path.GetDirectoryName(storePath)!);
    File.WriteAllText(storePath, CreateEmptyBookmarks(), new UTF8Encoding(false));
    var store = new BookmarkStore("Default", "隔离测试配置", "local", storePath);
    var backupRoot = Path.Combine(temporaryRoot, "Backups");
    var fixedTime = new DateTime(2026, 7, 29, 12, 0, 0, DateTimeKind.Utc);

    var formalUrl = "javascript:(()=>{return'formal'})()";
    var formalPackage = new BookmarkPackage(
        "cloudig/bookmark-package",
        "0.1.0",
        "formal-fixture",
        [
            new BookmarkDefinition(
                "formal-fixture",
                "Formal",
                "正式 Cloudig 测试书签",
                "Formal Cloudig fixture",
                "1.0.0",
                "formal.min.js",
                Sha256(Encoding.UTF8.GetBytes(formalUrl)),
                Encoding.UTF8.GetByteCount(formalUrl),
                formalUrl.Length,
                formalUrl)
        ]);
    new BookmarkTransaction(new BookmarkFileEditor(formalPackage), Path.Combine(backupRoot, "formal"))
        .Execute([store], BookmarkOperation.InstallOrRepair, fixedTime);
    var formalBefore = JsonNode.Parse(File.ReadAllText(storePath, Encoding.UTF8))!.AsObject();
    var formalNodesBefore = Walk(formalBefore)
        .Where(node => node["meta_info"]?["cloudig_managed"]?.GetValue<string>() == "1")
        .Select(node => node.ToJsonString())
        .ToArray();

    var transaction = new BookmarkTransaction(new BookmarkTestFileEditor(package), Path.Combine(backupRoot, "test"));
    var installed = transaction.Execute([store], BookmarkOperation.InstallOrRepair, fixedTime.AddDays(1));
    Check(installed.AddedCount == 3
          && installed.UpdatedCount == 0
          && installed.RemovedCount == 0
          && Directory.Exists(installed.BackupDirectory),
        "first test install did not add one folder plus two bookmarks with a backup");
    var backupManifest = JsonNode.Parse(File.ReadAllText(
        Path.Combine(installed.BackupDirectory!, "backup-manifest.json"),
        Encoding.UTF8))!.AsObject();
    Check(backupManifest["format"]?.GetValue<string>() == "cloudig/chrome-bookmark-backup"
          && backupManifest["files"]?.AsArray().Count == 1,
        "transaction did not retain a readable one-store backup manifest");
    var installedBytes = File.ReadAllBytes(storePath);
    var installedDocument = JsonNode.Parse(installedBytes)!.AsObject();
    Check(Walk(installedDocument).Count(node => node["meta_info"]?["cloudig_test_managed"]?.GetValue<string>() == "1") == 2
          && Walk(installedDocument).Single(node => node["meta_info"]?["cloudig_test_folder"]?.GetValue<string>() == "1")["name"]?.GetValue<string>() == "书签测试",
        "test editor did not create the isolated bookmark-bar folder");
    Check(Walk(installedDocument)
            .Where(node => node["meta_info"]?["cloudig_managed"]?.GetValue<string>() == "1")
            .Select(node => node.ToJsonString())
            .SequenceEqual(formalNodesBefore),
        "test editor changed formal cloudig_* nodes");

    var oldNames=installedDocument.DeepClone().AsObject();
    var oldNamed=Walk(oldNames).Single(node=>node["meta_info"]?["cloudig_test_id"]?.GetValue<string>()=="candidate-test-01-1");
    var oldTitle=$"{package.Bookmarks[0].Label} · {package.Bookmarks[0].Version}";
    oldNamed["name"]=oldTitle;oldNamed["meta_info"]!["cloudig_test_default_title"]=oldTitle;RefreshChecksums(oldNames);
    var nameRepair=new BookmarkTestFileEditor(package).Mutate(oldNames.ToJsonString(),BookmarkOperation.InstallOrRepair,fixedTime);
    Check(Walk(JsonNode.Parse(nameRepair.Json)!.AsObject()).Single(node=>node["meta_info"]?["cloudig_test_id"]?.GetValue<string>()=="candidate-test-01-1")["name"]!.GetValue<string>()=="ChatGPT（轻装）· 1.0.0-Light · Cloudig",
        "Previous standalone automatic name was not replaced");
    oldNamed["name"]="老婆的测试别名";oldNamed["meta_info"]!.AsObject().Remove("cloudig_test_default_title");RefreshChecksums(oldNames);
    var customRepair=new BookmarkTestFileEditor(package).Mutate(oldNames.ToJsonString(),BookmarkOperation.InstallOrRepair,fixedTime);
    Check(Walk(JsonNode.Parse(customRepair.Json)!.AsObject()).Single(node=>node["meta_info"]?["cloudig_test_id"]?.GetValue<string>()=="candidate-test-01-1")["name"]!.GetValue<string>()=="老婆的测试别名",
        "Standalone custom name was overwritten");

    var repeated = transaction.Execute([store], BookmarkOperation.InstallOrRepair, fixedTime.AddDays(2));
    Check(repeated.ChangedStoreCount == 0
          && repeated.BackupDirectory is null
          && File.ReadAllBytes(storePath).SequenceEqual(installedBytes),
        "repeated test install was not byte-idempotent");

    File.Delete(Path.Combine(artifacts, firstName));
    var updatedFirstName = "01-1_ChatGPT_轻装（Light）_1.0.1-light.min.js";
    File.WriteAllText(Path.Combine(artifacts, updatedFirstName), "javascript:(()=>{return'updated'})()", new UTF8Encoding(false));
    var updatedPackage = BookmarkTestDirectoryLoader.Load(artifacts);
    var updated = new BookmarkTransaction(new BookmarkTestFileEditor(updatedPackage), Path.Combine(backupRoot, "test"))
        .Execute([store], BookmarkOperation.InstallOrRepair, fixedTime.AddDays(3));
    Check(updated.UpdatedCount == 1
          && Walk(JsonNode.Parse(File.ReadAllText(storePath, Encoding.UTF8))!.AsObject())
              .Count(node => node["meta_info"]?["cloudig_test_id"]?.GetValue<string>() == "candidate-test-01-1") == 1,
        "version change did not update the stable slot in place");

    File.Delete(Path.Combine(artifacts, secondName));
    var reducedPackage = BookmarkTestDirectoryLoader.Load(artifacts);
    var reduced = new BookmarkTransaction(new BookmarkTestFileEditor(reducedPackage), Path.Combine(backupRoot, "test"))
        .Execute([store], BookmarkOperation.InstallOrRepair, fixedTime.AddDays(4));
    Check(reduced.RemovedCount == 1
          && Walk(JsonNode.Parse(File.ReadAllText(storePath, Encoding.UTF8))!.AsObject())
              .Count(node => node["meta_info"]?["cloudig_test_managed"]?.GetValue<string>() == "1") == 1,
        "removed source slot left a stale cloudig_test bookmark");
    Check(!Directory.Exists(installed.BackupDirectory)
          && Directory.Exists(updated.BackupDirectory)
          && Directory.Exists(reduced.BackupDirectory)
          && Directory.GetDirectories(Path.Combine(backupRoot, "test")).Length == 2,
        "third changed install did not retire only the oldest backup group");
    Check(Directory.GetDirectories(Path.Combine(backupRoot, "formal")).Length == 1,
        "test retention touched a separate formal installer backup root");

    // Repeated real transactions, including two physical stores, must plateau.
    var retentionRoot = Path.Combine(backupRoot, "retention");
    var retentionPaths = new[] { Path.Combine(temporaryRoot, "retention-a.json"), Path.Combine(temporaryRoot, "retention-b.json") };
    foreach (var file in retentionPaths) File.WriteAllText(file, CreateEmptyBookmarks(), new UTF8Encoding(false));
    var retentionStores = retentionPaths.Select((file, index) => new BookmarkStore($"R{index}", "Retention fixture", "local", file)).ToArray();
    for (var iteration = 0; iteration < 24; iteration++)
    {
        var nextPackage = iteration % 2 == 0 ? package : updatedPackage;
        var result = new BookmarkTransaction(new BookmarkTestFileEditor(nextPackage), retentionRoot)
            .Execute(retentionStores, BookmarkOperation.InstallOrRepair, fixedTime.AddMinutes(iteration));
        var groups = Directory.GetDirectories(retentionRoot);
        Check(result.ChangedStoreCount == 2 && groups.Length == Math.Min(iteration + 1, 2)
              && groups.All(group => Directory.GetFiles(group).Length == 3),
            $"repeated multi-store transactions exceeded two complete backup groups: iteration={iteration}, changed={result.ChangedStoreCount}, groups={groups.Length}, files={string.Join(',', groups.Select(group => Directory.GetFiles(group).Length))}");
    }
    var stableGroups = Directory.GetDirectories(retentionRoot);
    var oldGroup = Path.Combine(retentionRoot, "20200101T000000Z-abcdef01");
    Directory.CreateDirectory(oldGroup);
    foreach (var file in Directory.GetFiles(stableGroups[0])) File.Copy(file, Path.Combine(oldGroup, Path.GetFileName(file)));
    var oldManifestFile = Path.Combine(oldGroup, "backup-manifest.json");
    var oldManifest = JsonNode.Parse(File.ReadAllText(oldManifestFile))!.AsObject();
    oldManifest["created_at"] = "2020-01-01T00:00:00Z";
    File.WriteAllText(oldManifestFile, oldManifest.ToJsonString());
    var noChange = new BookmarkTransaction(new BookmarkTestFileEditor(updatedPackage), retentionRoot)
        .Execute(retentionStores, BookmarkOperation.InstallOrRepair, fixedTime.AddHours(1));
    Check(noChange.BackupDirectory is null && Directory.GetDirectories(retentionRoot).SequenceEqual(stableGroups),
        "a no-op install did not retire old backups without creating a new one");
    File.WriteAllText(Path.Combine(retentionRoot, "Bookmarks.bak"), "Not an installer group");
    var extraGroup = Path.Combine(retentionRoot, "20200101T000000Z-12345678");
    Directory.CreateDirectory(extraGroup);
    foreach (var file in Directory.GetFiles(stableGroups[0])) File.Copy(file, Path.Combine(extraGroup, Path.GetFileName(file)));
    File.WriteAllText(Path.Combine(extraGroup, "user-note.txt"), "Leave this alone");
    new BookmarkTransaction(new BookmarkTestFileEditor(package), retentionRoot)
        .Execute(retentionStores, BookmarkOperation.InstallOrRepair, fixedTime.AddHours(2));
    Check(File.ReadAllText(Path.Combine(retentionRoot, "Bookmarks.bak")) == "Not an installer group"
          && File.ReadAllText(Path.Combine(extraGroup, "user-note.txt")) == "Leave this alone",
        "retention deleted an unowned backup or an altered backup directory");
    var priorStoreBytes = retentionPaths.Select(File.ReadAllBytes).ToArray();
    var retentionTransaction = new BookmarkTransaction(new BookmarkTestFileEditor(updatedPackage), retentionRoot);
    retentionTransaction.BeforeWriteForTests = (index, _) => { if (index == 1) throw new IOException("retention rollback fixture"); };
    ExpectFailure(() => retentionTransaction.Execute(retentionStores, BookmarkOperation.InstallOrRepair, fixedTime.AddHours(3)), "restored");
    Check(retentionPaths.Select((file, index) => File.ReadAllBytes(file).SequenceEqual(priorStoreBytes[index])).All(value => value)
          && Directory.GetDirectories(retentionRoot).Length == 3,
        "failed transaction lost rollback data or accumulated extra complete backups");
    Check(!File.Exists(Path.Combine(retentionRoot, ".transaction.lock")), "transaction lock remained after rollback");

    var collisionPath = Path.Combine(temporaryRoot, "User Data", "Collision", "Bookmarks");
    Directory.CreateDirectory(Path.GetDirectoryName(collisionPath)!);
    var collisionDocument = JsonNode.Parse(CreateEmptyBookmarks())!.AsObject();
    collisionDocument["roots"]!["bookmark_bar"]!["children"]!.AsArray().Add(NewFolder("10", "书签测试"));
    RefreshChecksums(collisionDocument);
    File.WriteAllText(collisionPath, Serialize(collisionDocument), new UTF8Encoding(false));
    var collisionStore = new BookmarkStore("Collision", "同名冲突配置", "local", collisionPath);
    ExpectFailure(
        () => new BookmarkTransaction(new BookmarkTestFileEditor(reducedPackage), Path.Combine(backupRoot, "collision"))
            .Execute([collisionStore], BookmarkOperation.InstallOrRepair, fixedTime.AddDays(5)),
        "不会接管");
    Check(!Walk(JsonNode.Parse(File.ReadAllText(collisionPath, Encoding.UTF8))!.AsObject())
            .Any(node => node["meta_info"]?["cloudig_test_folder"]?.GetValue<string>() == "1"),
        "unmanaged same-name folder was taken over");

    var rollbackFirst = Path.Combine(temporaryRoot, "rollback-first.json");
    var rollbackSecond = Path.Combine(temporaryRoot, "rollback-second.json");
    File.WriteAllText(rollbackFirst, CreateEmptyBookmarks(), new UTF8Encoding(false));
    File.WriteAllText(rollbackSecond, CreateEmptyBookmarks(), new UTF8Encoding(false));
    var rollbackFirstBytes = File.ReadAllBytes(rollbackFirst);
    var rollbackSecondBytes = File.ReadAllBytes(rollbackSecond);
    var rollbackTransaction = new BookmarkTransaction(new BookmarkTestFileEditor(reducedPackage), Path.Combine(backupRoot, "rollback"))
    {
        BeforeWriteForTests = (index, _) =>
        {
            if (index == 1) throw new IOException("injected test installer failure");
        }
    };
    ExpectFailure(
        () => rollbackTransaction.Execute(
            [
                new BookmarkStore("A", "回滚 A", "local", rollbackFirst),
                new BookmarkStore("B", "回滚 B", "local", rollbackSecond)
            ],
            BookmarkOperation.InstallOrRepair,
            fixedTime.AddDays(6)),
        "restored");
    Check(File.ReadAllBytes(rollbackFirst).SequenceEqual(rollbackFirstBytes)
          && File.ReadAllBytes(rollbackSecond).SequenceEqual(rollbackSecondBytes),
        "multi-store injected failure did not restore both original files");

    File.WriteAllText(
        Path.Combine(artifacts, "03-1_Gemini_轻量（Light）_1.0.0-light.min.js"),
        "javascript:alert(1)\n",
        new UTF8Encoding(false));
    ExpectFailure(() => BookmarkTestDirectoryLoader.Load(artifacts), "严格单行");

    var actualTestDirectory = Path.Combine(projectRoot, "bookmarklets", "candidate", "test");
    var actualPackage = BookmarkTestDirectoryLoader.Load(actualTestDirectory);
    Check(actualPackage.Bookmarks.Count == Directory.EnumerateFiles(actualTestDirectory, "*.min.js", SearchOption.TopDirectoryOnly).Count(),
        "installer did not dynamically load every current candidate/test .min.js file");
    Check(actualPackage.Bookmarks.All(item=>System.Text.RegularExpressions.Regex.IsMatch(item.TitleZh,@"^.+（(轻装|全量|整树)）· [0-9.]+-(Light|Full|Tree) · Cloudig$")),
        "A real handoff entry bypassed the new naming format");
}
finally
{
    if (Directory.Exists(temporaryRoot)) Directory.Delete(temporaryRoot, recursive: true);
}

Console.WriteLine(JsonSerializer.Serialize(new
{
    ok = true,
    assertions,
    real_chrome_writes = 0,
    network_calls = 0
}, new JsonSerializerOptions { WriteIndented = true }));

static string FindProjectRoot(string start)
{
    var cursor = new DirectoryInfo(start);
    while (cursor is not null && !File.Exists(Path.Combine(cursor.FullName, "AGENTS.md"))) cursor = cursor.Parent;
    return cursor?.FullName ?? throw new DirectoryNotFoundException("Installer tests could not locate the repository root.");
}

static string CreateEmptyBookmarks()
{
    var document = new JsonObject
    {
        ["checksum"] = "",
        ["checksum_sha256"] = "",
        ["roots"] = new JsonObject
        {
            ["bookmark_bar"] = NewFolder("1", "Bookmarks bar"),
            ["other"] = NewFolder("2", "Other bookmarks"),
            ["synced"] = NewFolder("3", "Mobile bookmarks")
        },
        ["version"] = 1
    };
    RefreshChecksums(document);
    return Serialize(document);
}

static JsonObject NewFolder(string id, string name) => new()
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

static IEnumerable<JsonObject> Walk(JsonObject document)
{
    var roots = document["roots"]!.AsObject();
    var stack = new Stack<JsonObject>([roots["synced"]!.AsObject(), roots["other"]!.AsObject(), roots["bookmark_bar"]!.AsObject()]);
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

static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

static void ExpectFailure(Action action, string messageFragment)
{
    try
    {
        action();
        throw new InvalidOperationException($"Expected failure containing: {messageFragment}");
    }
    catch (Exception error) when (error.Message.Contains(messageFragment, StringComparison.OrdinalIgnoreCase))
    {
        return;
    }
}
