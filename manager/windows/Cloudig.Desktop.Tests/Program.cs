using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cloudig.Desktop;

var projectRoot = FindProjectRoot(AppContext.BaseDirectory);
var nodeExecutable = Environment.GetEnvironmentVariable("CLOUDIG_NODE");
if (string.IsNullOrWhiteSpace(nodeExecutable)) nodeExecutable = "node.exe";
var engineRoot = Environment.GetEnvironmentVariable("CLOUDIG_ENGINE_ROOT");
if (string.IsNullOrWhiteSpace(engineRoot)) engineRoot = projectRoot;

var temporaryRoot = Path.Combine(Path.GetTempPath(), $"采云-进程桥回归-{Guid.NewGuid():N}");
var selectedDirectory = Path.Combine(temporaryRoot, "中文输入");
var fixture = Environment.GetEnvironmentVariable("CLOUDIG_TEST_FIXTURE");
if (string.IsNullOrWhiteSpace(fixture)) fixture = Path.Combine(projectRoot, "tests", "fixtures", "chatgpt-light-items-v2.html");
var directSource = Environment.GetEnvironmentVariable("CLOUDIG_TEST_DIRECT_SOURCE") == "1";
var selectedFile = directSource ? Path.GetFullPath(fixture) : Path.Combine(selectedDirectory, "会话样本.html");
var expectedFileName = Path.GetFileName(selectedFile);
var smokeRootVariable = "CLOUDIG_SMOKE_LOCAL_DATA_ROOT";
var previousSmokeRoot = Environment.GetEnvironmentVariable(smokeRootVariable);
var assertions = 0;

void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    assertions += 1;
}

try
{
    var packagedFixture = Path.Combine(temporaryRoot, "PackagedLayout");
    var packagedArtifacts = Path.Combine(packagedFixture, "payload", "bookmarks", "artifacts");
    var releasePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var nodeBytes = Encoding.UTF8.GetBytes("synthetic-node-pinned-by-runtime-lock");
    var nodeHash = HashBytes(nodeBytes);
    var artifactFiles = new List<(string PackagePath, string RelativePath, byte[] Bytes)>();

    void WritePackageFile(string relative, byte[] bytes)
    {
        var normalized = relative.Replace('\\', '/');
        var target = Path.Combine(packagedFixture, normalized.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.WriteAllBytes(target, bytes);
        releasePaths.Add(normalized);
    }

    void WriteReleaseManifest(IEnumerable<string>? selectedPaths = null)
    {
        var files = (selectedPaths ?? releasePaths)
            .Order(StringComparer.OrdinalIgnoreCase)
            .Select(relative =>
            {
                var bytes = File.ReadAllBytes(Path.Combine(packagedFixture, relative.Replace('/', Path.DirectorySeparatorChar)));
                return new { path = relative, bytes = bytes.LongLength, sha256 = HashBytes(bytes) };
            })
            .ToArray();
        File.WriteAllBytes(
            Path.Combine(packagedFixture, "release-manifest.json"),
            JsonSerializer.SerializeToUtf8Bytes(new
            {
                format = "cloudig/windows-release-manifest",
                version = "0.1.0",
                architecture = "win-x64",
                bookmark_variant_count = 32,
                files
            }));
    }

    foreach (var required in AppPaths.RequiredPackagedFiles)
    {
        WritePackageFile(required, Encoding.UTF8.GetBytes($"fixture:{required}"));
    }
    WritePackageFile("runtime/node/node.exe", nodeBytes);
    WritePackageFile("runtime-lock.json", JsonSerializer.SerializeToUtf8Bytes(new
    {
        format = "cloudig/windows-runtime-lock",
        node = new { node_exe_sha256 = nodeHash }
    }));

    var packagePlatforms = new List<object>();
    var variantCounts = new[] { 3, 3, 2, 3, 2, 2, 3, 3, 3, 3, 2, 3 };
    for (var platformIndex = 0; platformIndex < variantCounts.Length; platformIndex += 1)
    {
        var variants = new List<object>();
        for (var variantIndex = 0; variantIndex < variantCounts[platformIndex]; variantIndex += 1)
        {
            var relative = $"bookmarklets/platform-{platformIndex}/variant-{variantIndex}.min.js";
            var packagePath = $"payload/bookmarks/artifacts/{relative}";
            var bytes = Encoding.UTF8.GetBytes($"javascript:void {platformIndex * 10 + variantIndex}");
            WritePackageFile(packagePath, bytes);
            artifactFiles.Add((packagePath, relative, bytes));
            variants.Add(new { artifact = relative, bytes = bytes.LongLength, sha256 = HashBytes(bytes) });
        }
        packagePlatforms.Add(new { id = $"platform-{platformIndex}", variants });
    }
    var packageManifest = Path.Combine(packagedFixture, "payload", "bookmarks", "bookmark-package.json");

    void WriteBookmarkManifest(int variantCount = 32)
    {
        WritePackageFile("payload/bookmarks/bookmark-package.json", JsonSerializer.SerializeToUtf8Bytes(new
        {
            format = "cloudig/bookmark-package",
            platform_count = 12,
            variant_count = variantCount,
            platforms = packagePlatforms
        }));
    }

    WriteBookmarkManifest();
    WriteReleaseManifest();

    var bundledNode = Path.Combine(packagedFixture, "runtime", "node", "node.exe");
    File.Delete(bundledNode);
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A package without bundled Node.js was accepted as complete");
    File.WriteAllBytes(bundledNode, nodeBytes);
    Check(AppPaths.IsCompletePackagedLayout(packagedFixture), "A complete release-manifest, runtime-lock and 32-artifact package was rejected");

    File.WriteAllText(bundledNode, "synthetic-node-not-approved-by-runtime-lock");
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A bundled Node.js binary whose SHA drifted from runtime-lock was accepted");
    File.WriteAllBytes(bundledNode, nodeBytes);

    var firstArtifact = artifactFiles[0];
    var missingArtifact = Path.Combine(packagedArtifacts, firstArtifact.RelativePath.Replace('/', Path.DirectorySeparatorChar));
    File.Delete(missingArtifact);
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A package with one missing declared bookmark artifact was accepted");
    File.WriteAllBytes(missingArtifact, firstArtifact.Bytes);

    File.WriteAllBytes(missingArtifact, firstArtifact.Bytes.Concat(new byte[] { 0x20 }).ToArray());
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A bookmark artifact whose byte count drifted from its manifest was accepted");
    File.WriteAllBytes(missingArtifact, firstArtifact.Bytes);

    var sameLengthDrift = firstArtifact.Bytes.ToArray();
    sameLengthDrift[0] ^= 0x01;
    File.WriteAllBytes(missingArtifact, sameLengthDrift);
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A bookmark artifact whose SHA drifted from its manifest was accepted");
    File.WriteAllBytes(missingArtifact, firstArtifact.Bytes);

    var requiredWebScript = Path.Combine(packagedFixture, "web", "app.js");
    var requiredWebScriptBytes = File.ReadAllBytes(requiredWebScript);
    var sameLengthWebDrift = requiredWebScriptBytes.ToArray();
    sameLengthWebDrift[0] ^= 0x01;
    File.WriteAllBytes(requiredWebScript, sameLengthWebDrift);
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A same-length release file SHA drift was accepted");
    File.WriteAllBytes(requiredWebScript, requiredWebScriptBytes);

    File.WriteAllBytes(requiredWebScript, requiredWebScriptBytes.Concat(new byte[] { 0x20 }).ToArray());
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A release file whose declared byte count drifted was accepted");
    File.WriteAllBytes(requiredWebScript, requiredWebScriptBytes);

    File.Delete(requiredWebScript);
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A package missing a release-critical file was accepted");
    File.WriteAllBytes(requiredWebScript, requiredWebScriptBytes);

    WriteReleaseManifest(releasePaths.Where(relative => !relative.Equals("web/app.js", StringComparison.OrdinalIgnoreCase)));
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A release manifest that omitted a required runtime file was accepted");
    WriteReleaseManifest();

    WriteBookmarkManifest(31);
    WriteReleaseManifest();
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A package whose manifest did not declare 32 variants was accepted");
    WriteBookmarkManifest();
    WriteReleaseManifest();

    var undeclaredExecutable = Path.Combine(packagedFixture, "unexpected-module.exe");
    File.WriteAllText(undeclaredExecutable, "not declared by release-manifest");
    Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "An undeclared extra package file was accepted");
    File.Delete(undeclaredExecutable);

    var packagedWebRoot = Path.Combine(packagedFixture, "web");
    var outsideWebRoot = Path.Combine(temporaryRoot, "OutsidePackagedWeb");
    Directory.Move(packagedWebRoot, outsideWebRoot);
    var junctionBuilder = new System.Diagnostics.ProcessStartInfo("cmd.exe")
    {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true
    };
    foreach (var argument in new[] { "/d", "/c", "mklink", "/J", packagedWebRoot, outsideWebRoot })
    {
        junctionBuilder.ArgumentList.Add(argument);
    }
    using (var junctionProcess = System.Diagnostics.Process.Start(junctionBuilder)
           ?? throw new InvalidOperationException("Windows did not start the junction regression helper"))
    {
        junctionProcess.WaitForExit();
        Check(
            junctionProcess.ExitCode == 0,
            $"Could not create the parent-directory junction regression: {junctionProcess.StandardError.ReadToEnd()}");
    }
    try
    {
        Check(!AppPaths.IsCompletePackagedLayout(packagedFixture), "A package file beneath a parent-directory reparse point was accepted");
    }
    finally
    {
        var linkedWeb = new DirectoryInfo(packagedWebRoot);
        Check((linkedWeb.Attributes & FileAttributes.ReparsePoint) != 0, "The parent-directory reparse regression did not create a link");
        linkedWeb.Delete();
        Directory.Move(outsideWebRoot, packagedWebRoot);
    }

    var localCandidate = Path.Combine(projectRoot, "manager", "dist", "Cloudig-V0.10.0-win-x64");
    var localCandidateManifest = Path.Combine(localCandidate, "release-manifest.json");
    if (Directory.Exists(localCandidate)
        && File.Exists(localCandidateManifest)
        && File.ReadAllText(localCandidateManifest).Contains("engine/manager/src/parse-batch.mjs", StringComparison.Ordinal))
    {
        Check(AppPaths.IsCompletePackagedLayout(localCandidate), "The locally anchored V0.10.0 candidate failed the hardened packaged-layout gate");
    }

    var smokeLocalData = Path.Combine(temporaryRoot, "SmokeLocalData");
    Environment.SetEnvironmentVariable(smokeRootVariable, smokeLocalData);
    var smokePaths = AppPaths.Discover();
    Check(
        Path.GetFullPath(smokePaths.LocalDataRoot).Equals(Path.GetFullPath(smokeLocalData), StringComparison.OrdinalIgnoreCase),
        "WebView2 smoke override did not isolate Cloudig local data inside the Windows temporary directory");
    Environment.SetEnvironmentVariable(smokeRootVariable, projectRoot);
    var rejectedUnsafeSmokeRoot = false;
    try
    {
        _ = AppPaths.Discover();
    }
    catch (InvalidOperationException)
    {
        rejectedUnsafeSmokeRoot = true;
    }
    Check(rejectedUnsafeSmokeRoot, "WebView2 smoke override accepted a path outside the Windows temporary directory");
    Environment.SetEnvironmentVariable(smokeRootVariable, previousSmokeRoot);

    var discoveredPaths = AppPaths.Discover();
    Check(
        Path.GetFullPath(discoveredPaths.BookmarkArtifactRoot)
            .Equals(Path.GetFullPath(Path.Combine(projectRoot, "manager", "bookmarks", "artifacts")), StringComparison.OrdinalIgnoreCase),
        "Development AppPaths did not isolate its frozen bookmark artifacts from live bookmarklet sources");

    Directory.CreateDirectory(selectedDirectory);
    if (!directSource) File.Copy(fixture, selectedFile);
    var paths = new AppPaths(
        engineRoot,
        Path.Combine(projectRoot, "manager", "web"),
        Path.Combine(engineRoot, "manager", "src", "command.mjs"),
        nodeExecutable,
        Path.Combine(projectRoot, "manager", "bookmarks", "bookmark-package.json"),
        Path.Combine(projectRoot, "manager", "bookmarks", "artifacts"),
        Path.Combine(projectRoot, "BOOKMARKLET_CHANGELOG.md"),
        Path.Combine(temporaryRoot, "LocalData"),
        Path.Combine(temporaryRoot, "WebView2"),
        Path.Combine(temporaryRoot, "settings.json"));
    var host = new ManagerCommandHost(paths);

    var streamScript = Path.Combine(temporaryRoot, "stream-command.mjs");
    await File.WriteAllTextAsync(streamScript, """
      import { createInterface } from "node:readline";
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      let request = null;
      for await (const line of input) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (!request) {
          request = message;
          process.stdout.write(`${JSON.stringify({ type: "started", operation_id: request.operation_id, kind: request.command })}\n`);
          process.stdout.write(`${JSON.stringify({ type: "progress", operation_id: request.operation_id, kind: request.command, phase: "scan", bytes_done: 4, bytes_total: 8, items_done: 1 })}\n`);
          if (request.command === "stream.complete") {
            process.stdout.write(`${JSON.stringify({ type: "result", operation_id: request.operation_id, kind: request.command, result: { completed: true } })}\n`);
            break;
          }
          if (request.command === "stream.checkpoint" || request.command === "stream.checkpoint-delayed") {
            process.stdout.write(`${JSON.stringify({ type: "checkpoint", operation_id: request.operation_id, kind: request.command, phase: "move_target_ready", plan_id: "a".repeat(64), target_root: "target", bytes_done: 8, bytes_total: 8, items_done: 1 })}\n`);
          }
          continue;
        }
        if (message.type === "commit" && (request.command === "stream.checkpoint" || request.command === "stream.checkpoint-delayed")) {
          if (request.command === "stream.checkpoint-delayed") await new Promise(resolve => setTimeout(resolve, 2000));
          process.stdout.write(`${JSON.stringify({ type: "result", operation_id: request.operation_id, kind: request.command, result: { committed: true } })}\n`);
          break;
        }
        if (message.type === "cancel") {
          process.stdout.write(`${JSON.stringify({ type: "error", operation_id: request.operation_id, kind: request.command, error: { code: "ABORT_ERR", kind: request.command, retryable: true, message: "cancelled" } })}\n`);
          process.exitCode = 1;
          break;
        }
      }
      input.close();
      """, new UTF8Encoding(false));
    var streamPaths = new AppPaths(
        temporaryRoot,
        paths.WebRoot,
        streamScript,
        nodeExecutable,
        paths.BookmarkManifest,
        paths.BookmarkArtifactRoot,
        paths.BookmarkChangelog,
        paths.LocalDataRoot,
        paths.WebViewDataRoot,
        paths.SettingsFile);
    var streamHost = new ManagerCommandHost(streamPaths);
    var streamEvents = new List<JsonElement>();
    var streamed = await streamHost.RunStreamingAsync(
        Request("stream.complete", new { }),
        progress => { streamEvents.Add(progress.Clone()); return Task.CompletedTask; });
    Check(streamed.GetProperty("completed").GetBoolean(), "Streaming host did not return the typed result event");
    Check(
        streamEvents.Count == 2
        && streamEvents[0].GetProperty("type").GetString() == "started"
        && streamEvents[1].GetProperty("bytes_done").GetInt32() == 4,
        "Streaming host did not deliver started and progress events in order");

    var checkpointEvents = new List<JsonElement>();
    var checkpointCommitted = false;
    var checkpointResult = await streamHost.RunStreamingAsync(
        Request("stream.checkpoint", new { }),
        progress => { checkpointEvents.Add(progress.Clone()); return Task.CompletedTask; },
        CancellationToken.None,
        checkpoint =>
        {
            checkpointCommitted = checkpoint.GetProperty("phase").GetString() == "move_target_ready";
            return Task.FromResult(checkpointCommitted);
        });
    Check(checkpointCommitted && checkpointResult.GetProperty("committed").GetBoolean(),
        "Streaming host did not commit a library-move checkpoint through the same child process");
    Check(checkpointEvents.Any(item => item.GetProperty("type").GetString() == "checkpoint"),
        "Streaming host did not forward the move checkpoint to the UI event channel");

    var committedSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var delayedCheckpointTask = streamHost.RunStreamingAsync(
        Request("stream.checkpoint-delayed", new { }),
        _ => Task.CompletedTask,
        CancellationToken.None,
        _ =>
        {
            committedSignal.TrySetResult(true);
            return Task.FromResult(true);
        });
    await committedSignal.Task;
    streamHost.StopStreamingProcesses();
    var delayedCheckpointResult = await delayedCheckpointTask;
    Check(delayedCheckpointResult.GetProperty("committed").GetBoolean(),
        "Desktop close handling killed a library move after its pointer checkpoint committed");

    using (var cancellation = new CancellationTokenSource())
    {
        ManagerCommandException? cancellationError = null;
        try
        {
            await streamHost.RunStreamingAsync(
                Request("stream.cancel", new { }),
                progress =>
                {
                    if (progress.GetProperty("type").GetString() == "progress") cancellation.Cancel();
                    return Task.CompletedTask;
                },
                cancellation.Token);
        }
        catch (ManagerCommandException error)
        {
            cancellationError = error;
        }
        Check(
            cancellationError?.Code == "ABORT_ERR" && cancellationError.Retryable,
            "Streaming host did not send or preserve cooperative cancellation");
    }

    var settingsPath = Path.Combine(temporaryRoot, "LocalData", "settings-move.json");
    var settings = new LocalSettings(settingsPath);
    var bookmarkSettings = new BookmarkInstallSettings(
        Path.Combine(temporaryRoot, "Chrome", "Default", "Bookmarks"),
        Guid.NewGuid().ToString("D").ToLowerInvariant(),
        "老婆的采云书签",
        false,
        Guid.NewGuid().ToString("D").ToLowerInvariant(),
        Guid.NewGuid().ToString("D").ToLowerInvariant(),
        true);
    await settings.SetBookmarkInstallAsync(bookmarkSettings);
    Check(settings.BookmarkInstall == bookmarkSettings,
        "Desktop settings did not persist the selected formal bookmark folder");
    await settings.SetThemeSwitchUsedVersionAsync(1);
    Check(settings.ThemeSwitchUsedVersion == 1,
        "Desktop settings did not persist the completed theme-switch onboarding version");
    var pendingMove = new PendingLibraryMove(
        new string('a', 64),
        temporaryRoot,
        Path.Combine(temporaryRoot, "MovedLibrary"),
        "rename",
        false,
        new string('b', 64),
        123,
        3,
        4,
        "preparing");
    await settings.BeginLibraryMoveAsync(pendingMove);
    Check(settings.LibraryRoot == Path.GetFullPath(temporaryRoot) && settings.PendingLibraryMove?.Phase == "preparing",
        "Local settings did not persist the pre-pointer library move checkpoint");
    await settings.CommitLibraryMoveTargetAsync(pendingMove.PlanId);
    Check(settings.LibraryRoot == Path.GetFullPath(pendingMove.TargetRoot) && settings.PendingLibraryMove?.Phase == "target_current",
        "Local settings did not atomically switch the current library with its pending move record");
    var reloadedSettings = new LocalSettings(settingsPath);
    await reloadedSettings.LoadAsync();
    Check(reloadedSettings.LibraryRoot == Path.GetFullPath(pendingMove.TargetRoot) && reloadedSettings.PendingLibraryMove?.PlanId == pendingMove.PlanId,
        "Pending library move did not survive a desktop restart");
    Check(reloadedSettings.BookmarkInstall == bookmarkSettings,
        "Formal bookmark folder identity did not survive a desktop restart or library move");
    Check(reloadedSettings.ThemeSwitchUsedVersion == 1,
        "Theme-switch onboarding completion did not survive a desktop restart or library move");
    await reloadedSettings.CompleteLibraryMoveAsync(pendingMove.PlanId, pendingMove.TargetRoot);
    Check(reloadedSettings.PendingLibraryMove is null && reloadedSettings.LibraryRoot == Path.GetFullPath(pendingMove.TargetRoot),
        "Desktop settings did not clear only the completed library move journal");

    var created = await host.RunAsync(Request("library.create", new { root = temporaryRoot, options = new { } }));
    Check(created.GetProperty("summary").GetProperty("library").GetProperty("root").GetString() == temporaryRoot,
        "Unicode library root did not survive the native-to-Node bridge");

    var imported = await host.RunAsync(Request("files.import", new { root = temporaryRoot, files = new[] { selectedFile } }));
    Check(imported.GetProperty("ok").GetBoolean(), "Unicode selected-file path was rejected by the native-to-Node bridge");
    var importedItem = imported.GetProperty("imported")[0];
    Check(importedItem.GetProperty("status").GetString() == "imported", "Unicode selected file was not copied into Inbox");
    Check(importedItem.GetProperty("file").GetString() == expectedFileName, "Unicode filename changed during import");
    Check(File.Exists(Path.Combine(temporaryRoot, "Inbox", expectedFileName)), "Unicode Inbox target was not created");

    var batchSettings = await host.RunAsync(Request("parse.settings.save", new
    {
        root = temporaryRoot,
        settings = new
        {
            parse_unparsed = true,
            parse_selected = true,
            update_outdated = false,
            preserve_previous = false
        }
    }));
    Check(batchSettings.GetProperty("target_directory").GetString() == "Conversations",
        "One-click parse settings did not preserve the logical archive directory across the native-to-Node bridge");
    var batchPlan = await host.RunAsync(Request("parse.batch.plan", new { root = temporaryRoot, selected_files = Array.Empty<string>() }));
    Check(batchPlan.GetProperty("count").GetInt32() == 1 && batchPlan.GetProperty("plan_id").GetString()?.Length == 64,
        "Native-to-Node bridge did not return the exact one-file confirmation plan");
    var batchExecution = await host.RunAsync(Request("parse.batch.execute", new { root = temporaryRoot, plan = batchPlan }));
    Check(batchExecution.GetProperty("ok").GetBoolean() && batchExecution.GetProperty("completed_count").GetInt32() == 1,
        "Native-to-Node bridge did not execute the confirmed one-click plan");

    var parsed = await host.RunAsync(Request("parse.all", new { root = temporaryRoot }));
    Check(parsed.GetProperty("ok").GetBoolean(), "Unicode library failed during parse through the native bridge");
    Check(parsed.GetProperty("files")[0].GetProperty("status").GetString() == "success", "Unicode input did not parse successfully");

    var archiveBeforeReader = await host.RunAsync(Request("archive.list", new { root = temporaryRoot }));
    var catalogConversation = archiveBeforeReader.GetProperty("files")[0];
    var desktopReader = await host.RunAsync(Request("reader.build", new { root = temporaryRoot, mode = "desktop_catalog" }));
    var desktopReaderOutput = desktopReader.GetProperty("output").GetString() ?? string.Empty;
    var desktopBuild = desktopReader.GetProperty("build");
    Check(
        Path.GetFullPath(desktopReaderOutput) == Path.GetFullPath(Path.Combine(temporaryRoot, "Data", "Reader", "Cloudig-Reader.html"))
        && desktopBuild.GetProperty("mode").GetString() == "desktop_catalog"
        && desktopBuild.GetProperty("embedded").GetProperty("library_files").GetInt32() == 1,
        "Packaged native-to-Node bridge did not build the catalog-first desktop Reader");
    var desktopReaderText = await File.ReadAllTextAsync(desktopReaderOutput);
    Check(!desktopReaderText.Contains(expectedFileName, StringComparison.Ordinal),
        "Catalog-first desktop Reader embedded a conversation body or source filename");
    var selectedConversation = await host.RunAsync(Request("reader.conversation.read", new
    {
        root = temporaryRoot,
        relative_path = catalogConversation.GetProperty("relative_path").GetString(),
        expected_sha256 = catalogConversation.GetProperty("sha256").GetString()
    }));
    Check(
        selectedConversation.GetProperty("sha256").GetString() == catalogConversation.GetProperty("sha256").GetString()
        && selectedConversation.GetProperty("document").GetProperty("identity").GetProperty("conversation_key").GetString()
            == catalogConversation.GetProperty("conversation_key").GetString(),
        "Packaged native-to-Node bridge did not return exactly the selected catalog conversation");

    var reader = await host.RunAsync(Request("reader.build", new { root = temporaryRoot }));
    var readerOutput = reader.GetProperty("output").GetString() ?? string.Empty;
    Check(Path.GetFileName(readerOutput) == "Cloudig-Reader.html" && File.Exists(readerOutput),
        "Packaged native-to-Node bridge did not build the stable Reader export");
    var readerText = await File.ReadAllTextAsync(readerOutput);
    Check(readerText.Contains("reader.cloudig.local", StringComparison.Ordinal)
          && readerText.Contains("reader.save-library", StringComparison.Ordinal),
        "Packaged Reader is missing its in-window host adapter");

    var conversationDirectory = Path.Combine(temporaryRoot, "Conversations");
    var conversationFiles = Directory.GetFiles(conversationDirectory, "*.json", SearchOption.TopDirectoryOnly);
    Check(conversationFiles.Length == 1, "Native bridge fixture did not produce exactly one conversation before the read-only Reader check");
    var deletedConversationName = Path.GetFileName(conversationFiles[0]);
    File.Delete(conversationFiles[0]);

    var readerAfterDeletion = await host.RunAsync(Request("reader.build", new { root = temporaryRoot }));
    var readerAfterDeletionOutput = readerAfterDeletion.GetProperty("output").GetString() ?? string.Empty;
    Check(!File.Exists(conversationFiles[0]), "reader.build recreated a user-deleted Conversations JSON through the native bridge");
    var readerAfterDeletionText = await File.ReadAllTextAsync(readerAfterDeletionOutput);
    Check(!readerAfterDeletionText.Contains(deletedConversationName, StringComparison.Ordinal),
        "Reader embedded a deleted conversation instead of the current Conversations folder");

    var explicitRestore = await host.RunAsync(Request("parse.all", new { root = temporaryRoot }));
    Check(explicitRestore.GetProperty("ok").GetBoolean() && File.Exists(conversationFiles[0]),
        "An explicit parse did not restore the missing conversation after the read-only Reader check");
}
finally
{
    Environment.SetEnvironmentVariable(smokeRootVariable, previousSmokeRoot);
    var resolved = Path.GetFullPath(temporaryRoot);
    var temp = Path.GetFullPath(Path.GetTempPath());
    if (!resolved.StartsWith(temp, StringComparison.OrdinalIgnoreCase))
    {
        throw new InvalidOperationException("Refusing to remove a non-temporary desktop bridge test directory");
    }
    if (Directory.Exists(resolved)) Directory.Delete(resolved, recursive: true);
}

Console.WriteLine(JsonSerializer.Serialize(new
{
    ok = true,
    assertions,
    unicode_process_bridge = true,
    reader_build_bridge = true,
    reader_does_not_parse = true,
    direct_source = directSource
}, new JsonSerializerOptions { WriteIndented = true }));

static JsonElement Request(string command, object payload) =>
    JsonSerializer.SerializeToElement(new { command, payload });

static string HashBytes(byte[] bytes) =>
    Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

static string FindProjectRoot(string start)
{
    var cursor = new DirectoryInfo(start);
    while (cursor is not null && !File.Exists(Path.Combine(cursor.FullName, "manager", "src", "command.mjs"))) cursor = cursor.Parent;
    return cursor?.FullName ?? throw new DirectoryNotFoundException("Cloudig desktop bridge test could not locate the repository root.");
}
