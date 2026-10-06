using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.AccessControl;
using System.Security.Principal;
using Cloudig.Bookmarks;
using Cloudig.Desktop.Core;

// Keep a failed unattended test from opening Windows crash UI and retaining
// the fixed Debug DLLs after its diagnostic has already reached the caller.
AppDomain.CurrentDomain.UnhandledException += (_, failure) => { Console.Error.WriteLine(failure.ExceptionObject); Environment.Exit(1); };

if (args.Length == 5 && args[0] == "--official-import-check") { await OfficialImportChecks.RunAsync(args[1], args[2], args[3], args[4]); return; }

if (args.Length == 1 && args[0] == "--update-check-test") { await ReleaseUpdateChecks.RunAsync(); return; }
if (args.Length == 1 && args[0] == "--library-instance-check") { await LibraryInstanceChecks.RunAsync(); return; }
if (args.Length == 1 && args[0] == "--storage-probe-check") { StorageProbeChecks.Run(); return; }
if (args.Length == 2 && args[0] == "--library-instance-worker") { await LibraryInstanceChecks.WorkerAsync(args[1]); return; }
if (args.Length == 2 && args[0] == "--native-file-move-check") { await NativeFileMoveChecks.RunAsync(args[1]); return; }
if (args.Length == 2 && args[0] == "--markdown-clipboard-check") { await MarkdownClipboardChecks.RunAsync(args[1]); return; }
if (args.Length == 2 && args[0] == "--download-check") { await DownloadChecks.RunAsync(args[1]); return; }
if (args.Length == 2 && args[0] == "--example-live-check") { await DownloadChecks.LiveAsync(args[1]); return; }
if (args.Length == 2 && args[0] == "--portable-update-check") { await PortableUpdateChecks.RunAsync(args[1]); return; }
if (args.Length == 3 && args[0] == "--portable-update-worker") { await PortableUpdateChecks.WorkerAsync(args[1],args[2]); return; }
if (args.Length == 2 && args[0] == "--update-check-published") { ReleaseUpdateChecks.CheckPublishedAssembly(args[1]); return; }
if (args.Length == 1 && args[0] == "--update-check-live") { Console.WriteLine(JsonSerializer.Serialize(await new ReleaseUpdateClient().CheckAsync("1.0.0-dev"))); return; }

if (args.Length == 5 && args[0] == "--portable-move-existing-root-test")
{
    await PortableMoveChecks.RunExistingRootAsync(args[1], args[2], [args[3], args[4]]); return;
}

if (args.Length == 2 && args[0] == "--portable-move-resume-test")
{
    PreparedPortableMove? continuation = null;
    var outcome = await PortableMoveStartup.ResolveAsync(args[1], _ => Task.FromResult(PortableMoveChoice.Continue), value => continuation = value);
    if (outcome.OpenLibrary || continuation is null) throw new InvalidOperationException("Source resume must schedule post-exit work.");
    Console.WriteLine(JsonSerializer.Serialize(continuation)); return;
}
if (args.Length == 4 && args[0] == "--portable-move-complete-interrupt-test")
{
    await PortableLibraryMove.CompleteAsync(args[1], args[2], args[3], progress: value => { if (value.CompletedFiles == 1) Environment.Exit(77); });
    throw new InvalidOperationException("The cleanup interruption was not reached.");
}

if (args.Length == 7 && args[0] == "--portable-move-prepare-test")
{
    using var heldExecutable = new FileStream(Path.Combine(args[1], "Cloudig.exe"), FileMode.Open, FileAccess.Read, FileShare.Read);
    var request = await PortableLibraryMove.BeginAsync(args[1], args[2], args[3], args[4]);
    var prepared = await PortableLibraryMove.FreezeAsync(request, forceCopyForTests: args[5] == "copy");
    Console.WriteLine(JsonSerializer.Serialize(prepared));
    if (args[6] == "wait") await Console.In.ReadLineAsync();
    return;
}

if (args.Length is < 1 or > 3 || !Path.IsPathFullyQualified(args[0]) || !File.Exists(args[0]))
{
    throw new InvalidOperationException("Desktop test requires one fixed Node executable and an optional packaged bookmark root.");
}
var bookmarkPackageRoot = args.Length >= 2
    ? Path.GetFullPath(args[1])
    : Path.Combine(Directory.GetCurrentDirectory(), "manager", "bookmarks");
var packagedEngine = args.Length == 3 ? Path.GetFullPath(args[2]) : null;
if (packagedEngine is not null && !File.Exists(packagedEngine)) throw new InvalidOperationException("Packaged Engine is missing.");
var bookmarkManifest = Path.Combine(bookmarkPackageRoot, "bookmark-package.json");
var bookmarkArtifacts = Path.Combine(bookmarkPackageRoot, "artifacts");
if (!File.Exists(bookmarkManifest) || !Directory.Exists(bookmarkArtifacts)) throw new InvalidOperationException("Desktop test bookmark package is incomplete.");

var policy = new BridgePolicy();
var programRoot = Path.GetFullPath("tmp/portable-layout-example");
var flatProgram = CloudigProgramLayout.Resolve(Path.Combine(programRoot, "Cloudig.exe"), Path.Combine(programRoot, "app"));
Require(flatProgram.Root == programRoot && flatProgram.App == Path.Combine(programRoot, "app"), "portable apphost separates root entry and app internals");
var developmentProgram = CloudigProgramLayout.Resolve(Path.Combine(programRoot, "Cloudig.exe"), programRoot);
Require(developmentProgram.Root == programRoot && developmentProgram.App == programRoot, "fixed Debug layout remains supported");
try { CloudigProgramLayout.Resolve(Path.Combine(programRoot, "Cloudig.exe"), Path.Combine(programRoot, "elsewhere")); throw new InvalidOperationException("An unrelated program folder must not be inferred as the portable app."); }
catch (ArgumentException) { }
// This also exercises the actual published root apphost in the isolated native
// package test, rather than only testing invented path strings.
if (Path.GetFileName(Environment.ProcessPath) == "Cloudig.Desktop.Tests.exe")
{
    var ownProgram = CloudigProgramLayout.Resolve(Environment.ProcessPath!, AppContext.BaseDirectory);
    Require(ownProgram.Root == Path.GetDirectoryName(Environment.ProcessPath), "the running native apphost supplies the root");
    Require(ownProgram.App == Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory), "managed/native dependencies resolve from the embedded app path");
    if (Path.GetFileName(ownProgram.App).Equals("app", StringComparison.OrdinalIgnoreCase))
        Require(Path.TrimEndingDirectorySeparator(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory()).Equals(ownProgram.App, StringComparison.OrdinalIgnoreCase), "portable native host uses its shipped runtime, not the machine-wide installation");
}
Require(ViewportScale.ForClient(1280, 720) == 1 && ViewportScale.ForClient(1920, 1080) == 1, "existing small/design viewports keep native scale");
Require(ViewportScale.ForClient(3840, 2160) == 2 && ViewportScale.ForClient(7680, 4320) == 4, "4K and 8K are not capped at the design size");
Require(Math.Abs(ViewportScale.ForClient(2560, 1360) - 1360d / 1080) < .000001, "4K at 150 percent uses remaining client DIPs, not DPI twice");
Require(Math.Abs(ViewportScale.ForClient(3840, 2080) - 2080d / 1080) < .000001, "taskbar and window caption are outside the page scale");
Require(Math.Abs(ViewportScale.ForClient(3072, 1656) - 1656d / 1080) < .000001, "4K at 125 percent is fitted in logical client units");
Require(ViewportScale.ForClient(1920, 1020) == 1, "4K at 200 percent is not enlarged for its physical pixel count");
Require(ViewportScale.ForClient(1280, 720) == 1 && ViewportScale.ForClient(0, double.NaN) == 1, "restore and not-yet-laid-out dimensions do not retain zoom");
using var runtimeLimits = JsonDocument.Parse(await File.ReadAllTextAsync("src/core/contracts/machine/resource-limits.json"));
Require(EngineJsonlClient.MaximumConcurrentCommands == runtimeLimits.RootElement.GetProperty("ipc_concurrent_commands_max").GetInt32(), "desktop backpressure matches the Engine machine limit");
var welcomeDawn = WindowSurfaceStyles.Resolve("dawn", "welcome");
Require(welcomeDawn.Stops.Count == 3 && welcomeDawn.Stops[1].Color == new WindowSurfaceColor(210, 210, 210), "Welcome Dawn caption gradient");
Require(welcomeDawn.LightCaptionControls && welcomeDawn.Foreground == new WindowSurfaceColor(45, 45, 45), "Welcome Dawn caption controls");
var readerDawn = WindowSurfaceStyles.Resolve("dawn", "reader");
Require(readerDawn.Stops.Count == 2 && readerDawn.Stops[0].Color == new WindowSurfaceColor(224, 201, 173), "Reader Dawn caption gradient");
Require(readerDawn.Border == new WindowSurfaceColor(183, 136, 98), "Reader Dawn caption border");
var archiverDawn = WindowSurfaceStyles.Resolve("dawn", "archiver");
Require(archiverDawn.Stops.Count == 4 && archiverDawn.Stops[0].Color == new WindowSurfaceColor(132, 32, 30) && archiverDawn.Stops[3].Color == new WindowSurfaceColor(75, 127, 130), "Archiver Dawn caption gradient");
Require(!archiverDawn.LightCaptionControls && archiverDawn.Foreground == new WindowSurfaceColor(253, 252, 237), "Archiver Dawn caption controls");
var readerNight = WindowSurfaceStyles.Resolve("star-night", "reader");
var archiverNight = WindowSurfaceStyles.Resolve("star-night", "archiver");
Require(readerNight.Stops.SequenceEqual(archiverNight.Stops) && readerNight.Stops[0].Color == new WindowSurfaceColor(59, 56, 60), "StarNight work caption gradient");
Require(WindowSurfaceStyles.Resolve("star-night", "welcome").Stops[0].Color == new WindowSurfaceColor(0, 0, 0), "Welcome StarNight caption gradient");
RejectSurface(() => WindowSurfaceStyles.Resolve("dawn", "unknown"));
Require(policy.IsAllowedTopLevelNavigation("https://cloudig.local/index.html#reader"), "trusted top-level route");
Require(!policy.IsAllowedTopLevelNavigation("https://cloudig-runtime.local/v_bad/pages/p_bad.json"), "runtime top-level blocked");
Require(BridgePolicy.IsExternalHttp("https://example.com/docs"), "external HTTPS accepted");
Require(!BridgePolicy.IsExternalHttp("file:///C:/private.txt"), "file URL blocked");
ProcessStartInfo? externalPlan = null;
Require(ExternalBrowserLauncher.TryOpen("https://example.com/docs?a=1&b=2", start => externalPlan = start), "external URL builds a launch plan");
Require(externalPlan is { UseShellExecute: true, FileName: "https://example.com/docs?a=1&b=2" }, "external URL is passed intact without a command shell");
Require(!ExternalBrowserLauncher.TryOpen("file:///C:/private.txt", _ => throw new InvalidOperationException("Unexpected launch")), "non-HTTP URL is never launched");
Require(!ExternalBrowserLauncher.TryOpen("https://example.com/docs", _ => throw new System.ComponentModel.Win32Exception(1155)), "missing browser association must not escape a WebView event callback");
Require(BridgePolicy.RuntimeUri($"/v_{new string('a', 43)}/pages/p_{new string('b', 43)}.json").Host == "cloudig-runtime.local", "runtime capability URI");

var valid = JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_1",
    command = "reader.archives.query",
    payload = new { offset = 0, limit = 20 }
});
var parsed = policy.Parse("https://cloudig.local/index.html", valid);
Reject(() => policy.Parse("https://cloudig.local/runtime/interactive-frame.html", valid), "interactive frames have no native bridge");
Require(policy.CorrelationId("https://cloudig.local/runtime/interactive-frame.html", valid) is null, "interactive frames get no native response correlation");
Require(policy.IsAllowedFrameNavigation("https://cloudig-work.invalid/runtime/interactive-frame.html"), "separate-origin sandbox bootstrap allowed");
Require(policy.IsAllowedFrameNavigation("https://cloudig-map.local/runtime/map-frame.html"), "dedicated built-in map bootstrap allowed");
Require(!policy.IsAllowedFrameNavigation("https://tiles.openfreemap.org/styles/liberty"), "map tiles are data, not allowed frame navigation");
Reject(() => policy.Parse("https://cloudig-map.local/runtime/map-frame.html", valid), "map runtime has no native bridge");
Require(!policy.IsAllowedFrameNavigation("https://cloudig.local/runtime/interactive-frame.html"), "work cannot acquire the application origin");
Require(!policy.IsAllowedFrameNavigation("blob:null/fixture-work"), "work cannot navigate to an uncontrolled document");
Reject(() => policy.Parse("https://cloudig-work.invalid/runtime/interactive-frame.html", valid), "separate work origin has no native bridge");
Require(!policy.IsAllowedFrameNavigation("https://example.com/leak?data=private"), "work cannot navigate its frame to the network");
Require(!policy.IsAllowedFrameNavigation("https://cloudig.local/index.html"), "work cannot navigate to the application bridge page");
Require(parsed.Command == "reader.archives.query", "bridge allowlist");
foreach (var command in new[] { "reader.position.query", "reader.position.save" })
{
    object payload = command.EndsWith("query", StringComparison.Ordinal)
        ? new { archive = $"a_{new string('p', 43)}" }
        : new { archive = $"a_{new string('p', 43)}", message_id = "m1" };
    var position = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new { protocol = BridgePolicy.Protocol, request = $"w_{command.Replace('.', '_')}", command, payload }));
    Require(position.Command == command, $"{command} bridge allowlist");
}
Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new { protocol = BridgePolicy.Protocol, request = "w_private_move", command = "library.move.endpoints", payload = new { target = "G:\\untrusted" } })), "the page must not request native move endpoints");
var move = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_move",
    command = "reader.archive.move",
    payload = new { archive = $"a_{new string('a', 43)}", directory = $"d_{new string('b', 43)}" }
}));
Require(move.Command == "reader.archive.move", "archive move allowlist");
var exportMarkdown = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_export",
    command = "reader.archive.exportMarkdown",
    payload = new { archive = $"a_{new string('e', 43)}", selected_leaf = "m2" }
}));
Require(exportMarkdown.Command == "reader.archive.exportMarkdown", "Markdown export allowlist");
var recycle = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_recycle",
    command = "shell.recycleArchive",
    payload = new { archive = $"a_{new string('c', 43)}" }
}));
Require(recycle.Command == "shell.recycleArchive", "recycle shell boundary allowlist");
var pickSource = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_pick",
    command = "shell.pickSource",
    payload = new { kind = "html" }
}));
Require(pickSource.Command == "shell.pickSource", "source picker shell boundary allowlist");
var importSource = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_import",
    command = "source.import",
    payload = new { pickers = new[] { $"p_{new string('p', 43)}" } }
}));
Require(importSource.Command == "source.import", "source import allowlist");
var dismissMissing = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_dismiss",
    command = "archiver.source.dismissMissing",
    payload = new { source = $"s_{new string('s', 43)}" }
}));
Require(dismissMissing.Command == "archiver.source.dismissMissing", "missing source dismissal allowlist");
foreach (var command in new[]
{
             "reader.archive.info.query",
             "reader.archive.info.preview",
             "reader.archive.info.commit",
             "time.cover.query",
             "time.order.commit",
             "time.route.resolve",
             "time.nodes.children",
             "time.sovereign.query",
             "time.endpoint.preview",
             "time.range.preview",
             "time.editor.query",
             "time.editor.preview",
             "time.editor.commit",
             "time.delete.preview",
             "time.delete.commit",
             "systemLog.list",
             "systemLog.reveal",
             "indexes.rebuild",
             "archiver.claude.index",
             "archiver.claude.records.query",
             "archiver.claude.extract.preview",
             "archiver.claude.extract.commit"
         })
{
    var claudeCommand = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
    {
        protocol = BridgePolicy.Protocol,
        request = $"w_{command.Split('.').Last()}",
        command,
        payload = new { container = $"c_{new string('c', 43)}" }
    }));
    Require(claudeCommand.Command == command, $"{command} allowlist");
}
foreach (var command in new[]
         {
             "shell.bookmarks.query",
             "shell.bookmarks.target.query",
             "shell.bookmarks.target.save",
             "shell.bookmarks.copy",
             "shell.bookmarks.install",
             "shell.bookmarks.remove"
         })
{
    var bookmarkCommand = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
    {
        protocol = BridgePolicy.Protocol,
        request = $"w_{command.Split('.').Last().Replace("remove", "rm", StringComparison.Ordinal)}",
        command,
        payload = new { profile = "light" }
    }));
    Require(bookmarkCommand.Command == command, $"{command} allowlist");
}
foreach (var command in new[] { "shell.library.info", "shell.libraryMove.plan", "shell.libraryMove.commit" })
{
    var libraryCommand = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
    {
        protocol = BridgePolicy.Protocol,
        request = $"w_{command.Split('.').Last()}",
        command,
        payload = new { }
    }));
    Require(libraryCommand.Command == command, $"{command} allowlist");
}
Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_internal",
    command = "reader.archive.recycle.plan",
    payload = new { archive = $"a_{new string('d', 43)}" }
})), "internal recycle plan blocked from page");
foreach (var command in new[] { "reader.archive.recycle.begin", "reader.archive.recycle.complete", "reader.archive.recycle.release", "reader.archive.recycle.pending", "reader.archive.recycle.resume", "reader.archive.recycle.keepRemaining" })
    Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new { protocol = BridgePolicy.Protocol, request = "w_internal", command, payload = new { } })), "all recycle internals blocked from page");
Reject(() => policy.Parse("https://evil.example/", valid), "untrusted source");
var pathTitle = policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_2",
    command = "reader.archives.query",
    payload = new { search = "C:\\private\\archive.json" }
}));
Require(pathTitle.Payload.GetProperty("search").GetString() == "C:\\private\\archive.json", "display text is not a file capability");
Require(policy.CorrelationId("https://cloudig.local/index.html", valid) == "w_1", "correlation survives rejected command validation");
Require(policy.CorrelationId("https://evil.example/", valid) is null, "untrusted message cannot receive a correlated reply");
Require(policy.CorrelationId("https://cloudig.local/index.html", "not json") is null, "malformed message has no invented request ID");
Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_3",
    command = "reader.archives.query",
    payload = new { data_base64 = new[] { "AA==" } }
})), "forbidden field");
Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol,
    request = "w_recover",
    command = "library.startup.recover",
    payload = new { }
})), "startup recovery remains internal");
Reject(() => policy.Parse("https://cloudig.local/index.html", JsonSerializer.Serialize(new
{
    protocol = BridgePolicy.Protocol, request = "w_settings_recover",
    command = "library.settings.recover", payload = new { }
})), "settings-only startup recovery remains internal");

var scope = Path.Combine(Directory.GetCurrentDirectory(), "tmp", $"cloudig-desktop-test-{Guid.NewGuid():N}");
Directory.CreateDirectory(scope);
try
{
    var applicationRoot = Path.Combine(scope, "Application");
    var defaultRoots = CloudigDataRootPolicy.Resolve(applicationRoot);
    Require(defaultRoots.LibraryRoot == Path.GetFullPath(applicationRoot), "the portable root is the Library, without a second Cloudig layer");
    Require(defaultRoots.DeviceRoot == Path.GetFullPath(Path.Combine(applicationRoot, "appdata")), "device-specific state stays under appdata");
    Require(defaultRoots.CacheRoot == Path.Combine(applicationRoot, "cache"), "default cache stays adjacent to the program");
    PortableStorageBoundary.Verify(new[] { defaultRoots.LibraryRoot, defaultRoots.DeviceRoot, defaultRoots.CacheRoot });
    Require(!Directory.Exists(applicationRoot), "permission probes leave no empty fake Library or data tree");
    var namedProgramFiles = Path.Combine(scope, "Program Files", "Cloudig");
    PortableStorageBoundary.Verify(namedProgramFiles);
    Require(!Directory.Exists(namedProgramFiles), "writable Program Files name is not blacklisted");
    var blockedStorage = Path.Combine(scope, "blocked-storage");
    await File.WriteAllTextAsync(blockedStorage, "not a directory");
    try { PortableStorageBoundary.Verify(blockedStorage); throw new Exception("Expected storage rejection"); }
    catch (CloudigStorageException error) { Require(error.Message.Contains("不会自动改存 AppData", StringComparison.Ordinal), "storage rejection explains no hidden fallback"); }
    var deniedDirectory = Directory.CreateDirectory(Path.Combine(scope, "DeniedStorage"));
    var originalAccess = deniedDirectory.GetAccessControl();
    var deniedAccess = deniedDirectory.GetAccessControl();
    deniedAccess.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.CreateFiles | FileSystemRights.CreateDirectories, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Deny));
    try
    {
        deniedDirectory.SetAccessControl(deniedAccess);
        try { PortableStorageBoundary.Verify(deniedDirectory.FullName); throw new Exception("Expected write-permission rejection"); }
        catch (CloudigStorageException) { Require(!deniedDirectory.EnumerateFileSystemInfos().Any(), "a genuinely unwritable folder is rejected without initializing data"); }
    }
    finally { deniedDirectory.SetAccessControl(originalAccess); }
    Require(!defaultRoots.LibraryArgumentExplicit, "normal launch uses the adjacent portable root");
    var stableDataRoot = Path.Combine(scope, "Stable Data");
    var stableRoots = CloudigDataRootPolicy.Resolve(applicationRoot, stableDataRoot);
    Require(stableRoots.LibraryRoot == Path.GetFullPath(stableDataRoot), "explicit test root is flat too");
    Require(stableRoots.DeviceRoot == Path.GetFullPath(Path.Combine(stableDataRoot, "appdata")), "explicit test root keeps device state inside it");
    Require(stableRoots.LibraryArgumentExplicit, "data-root is an explicit isolated root, not a recent pointer");
    var explicitLibraryRoot = Path.Combine(scope, "Explicit Library");
    var explicitRoots = CloudigDataRootPolicy.Resolve(applicationRoot, libraryRootArgument: explicitLibraryRoot);
    Require(explicitRoots.LibraryRoot == Path.GetFullPath(explicitLibraryRoot), "library-root chooses one complete isolated root");
    Require(explicitRoots.DeviceRoot == Path.GetFullPath(Path.Combine(explicitLibraryRoot, "appdata")), "library-root cannot split off device settings");
    Require(explicitRoots.LibraryArgumentExplicit, "library-root is an explicit fixed Library override");
    try { CloudigDataRootPolicy.Resolve(applicationRoot, stableDataRoot, explicitLibraryRoot); throw new InvalidOperationException("Split roots should be rejected."); } catch (ArgumentException) { }
    var auditOutput = Path.Combine(scope, "Audit", "reader.png");
    var auditRoots = CloudigDataRootPolicy.Resolve(applicationRoot, stableDataRoot, visualAuditOutput: auditOutput);
    Require(auditRoots.DeviceRoot == Path.GetFullPath(Path.Combine(stableDataRoot, "appdata")), "screenshot output does not silently choose another settings root");

    var library = Path.Combine(scope, "Library");
    Directory.CreateDirectory(library);
    var archiveDirectory = Path.Combine(library, "Conversations", "Folder");
    Directory.CreateDirectory(archiveDirectory);
    var archiveFile = Path.Combine(archiveDirectory, "archive.json");
    var archiveBytes = "exact archive bytes"u8.ToArray();
    await File.WriteAllBytesAsync(archiveFile, archiveBytes);
    var archiveSha = Convert.ToHexString(SHA256.HashData(archiveBytes)).ToLowerInvariant();
    Require(
        await ArchiveRecycleBoundary.VerifyExactFileAsync(library, "Conversations/Folder/archive.json", archiveBytes.Length, archiveSha) == archiveFile,
        "exact recycle target verification");
    await RejectAsync(
        () => ArchiveRecycleBoundary.VerifyExactFileAsync(library, "Conversations/Folder/archive.json", archiveBytes.Length, new string('0', 64)),
        "changed recycle bytes");
    Directory.CreateDirectory(Path.Combine(archiveDirectory, "Deep"));
    var deepArchive = Path.Combine(archiveDirectory, "Deep", "archive.json");
    await File.WriteAllBytesAsync(deepArchive, archiveBytes);
    Require(await ArchiveRecycleBoundary.VerifyExactFileAsync(library, "Conversations/Folder/Deep/archive.json", archiveBytes.Length, archiveSha) == deepArchive, "nested Conversation recycle path");
    Directory.CreateDirectory(Path.Combine(library, "Archives"));
    var archivedFile = Path.Combine(library, "Archives", "archived.json"); await File.WriteAllBytesAsync(archivedFile, archiveBytes);
    Require(await ArchiveRecycleBoundary.VerifyExactFileAsync(library, "Archives/archived.json", archiveBytes.Length, archiveSha) == archivedFile, "root Archives recycle scope");
    Directory.CreateDirectory(Path.Combine(library, "Marks"));
    var markName = "01993520-0000-7000-8000-000000000111.json";
    var markFile = Path.Combine(library, "Marks", markName); await File.WriteAllBytesAsync(markFile, archiveBytes);
    var recycleFiles = JsonSerializer.SerializeToElement(new[] {
        new { kind = "conversation", path = "Conversations/Folder/Deep/archive.json", bytes = archiveBytes.Length, sha256 = archiveSha },
        new { kind = "mark", path = $"Marks/{markName}", bytes = archiveBytes.Length, sha256 = archiveSha }
    });
    var fakeBin = Path.Combine(scope, "FakeRecycle"); Directory.CreateDirectory(fakeBin);
    Require(await ArchiveRecycleBoundary.RecycleFilesAsync(library, recycleFiles, (file, _) => { File.Move(file, Path.Combine(fakeBin, Path.GetFileName(file))); return Task.CompletedTask; }) == 2, "native callback receives exactly Conversation and Mark");
    Require(!File.Exists(deepArchive) && !File.Exists(markFile) && File.Exists(archiveFile), "only selected pair removed from Library");
    await File.WriteAllBytesAsync(markFile, archiveBytes);
    var invalidPair = JsonSerializer.SerializeToElement(new[] {
        new { kind = "conversation", path = "Archives/archived.json", bytes = archiveBytes.Length, sha256 = archiveSha },
        new { kind = "mark", path = $"Marks/{markName}", bytes = archiveBytes.Length, sha256 = new string('0', 64) }
    });
    var dispatched = 0;
    await RejectAsync(() => ArchiveRecycleBoundary.RecycleFilesAsync(library, invalidPair, (_, _) => { dispatched++; return Task.CompletedTask; }), "all targets verified before any native deletion");
    Require(dispatched == 0 && File.Exists(archivedFile) && File.Exists(markFile), "invalid Mark cannot allow Conversation deletion first");
    foreach (var invalidPath in new[] { "Inbox/archive.json", "appdata/x.json", "Marks/arbitrary.json", "Conversations/../x.json", "Conversations/Bad:/x.json", "Conversations/NUL/x.json" })
        await RejectAsync(() => ArchiveRecycleBoundary.VerifyExactFileAsync(library, invalidPath, archiveBytes.Length, archiveSha), "out-of-scope recycle path");
    var loggedSource = Path.Combine(library, "Inbox", "logged.html");
    Directory.CreateDirectory(Path.GetDirectoryName(loggedSource)!);
    await File.WriteAllTextAsync(loggedSource, "logged source");
    Require(SystemLogRevealBoundary.ResolveExistingFile(library, "Inbox/logged.html") == loggedSource, "System Log reveal resolves one exact Inbox file");
    RejectSystemLog(() => SystemLogRevealBoundary.ResolveExistingFile(library, "Data/Logs/system-log.json"), "CLOUDIG_SYSTEM_LOG_FILE_INVALID", "System Log reveal rejects internal paths");
    RejectSystemLog(() => SystemLogRevealBoundary.ResolveExistingFile(library, "Inbox/missing.html"), "CLOUDIG_SYSTEM_LOG_FILE_MISSING", "System Log reveal reports missing files");
    var selectedSource = Path.Combine(scope, "picked.html");
    var selectedBytes = "picked source bytes"u8.ToArray();
    await File.WriteAllBytesAsync(selectedSource, selectedBytes);
    var zipPlaceholder = new DateTime(1980, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    File.SetLastWriteTimeUtc(selectedSource, zipPlaceholder);
    var originalCreated = File.GetCreationTimeUtc(selectedSource);
    var pickerToken = SourcePickerBoundary.CreateToken();
    var pickerRuntime = Path.Combine(library, "cache", "Engine", "native-picker-test"); Directory.CreateDirectory(pickerRuntime);
    var picker = await SourcePickerBoundary.StageAsync(pickerRuntime, selectedSource, pickerToken);
    Require(picker.Picker == pickerToken && picker.Filename == "picked.html" && picker.Bytes == selectedBytes.Length, "source picker staging result");
    var pickerRoot = Path.Combine(pickerRuntime, "Pickers", pickerToken);
    Require(await File.ReadAllBytesAsync(Path.Combine(pickerRoot, "payload.bin")) is var picked && picked.SequenceEqual(selectedBytes), "source picker exact bytes");
    var pickerManifest = await File.ReadAllTextAsync(Path.Combine(pickerRoot, "manifest.json"));
    Require(!pickerManifest.Contains(selectedSource, StringComparison.OrdinalIgnoreCase), "source picker manifest hides original path");
    Require(pickerManifest.Contains("\"created_at\"", StringComparison.Ordinal) && pickerManifest.Contains("\"modified_at\"", StringComparison.Ordinal), "source picker manifest preserves both original file times");
    using (var captureFacts = JsonDocument.Parse(pickerManifest))
    {
        Require(captureFacts.RootElement.GetProperty("created_at").GetDateTime() == originalCreated, "picker transports original creation, not the staging copy birthtime");
        Require(captureFacts.RootElement.GetProperty("modified_at").GetDateTime() == zipPlaceholder, "picker preserves placeholder fact for Engine policy");
        Require(!captureFacts.RootElement.TryGetProperty("captured_at", out _), "desktop does not implement a second capture policy");
    }
    Require(File.GetLastWriteTimeUtc(selectedSource) == zipPlaceholder, "picker never repairs the original file timestamp");
    var duplicateRejected = false;
    try { await SourcePickerBoundary.StageAsync(pickerRuntime, selectedSource, pickerToken); } catch (IOException) { duplicateRejected = true; }
    Require(duplicateRejected, "duplicate picker never overwrites staged bytes");
    SourcePickerBoundary.RemoveOwned(pickerRuntime, pickerToken);
    Require(!Directory.Exists(pickerRoot), "source picker exact cleanup");
    Require(!Directory.Exists(Path.Combine(library, "Data", "Runtime", "Pickers")), "picker never creates legacy Data storage");
    var officialFile = Path.Combine(scope, "native.json"); await File.WriteAllTextAsync(officialFile, "[]");
    var officialFiles = Path.Combine(scope, "native-files"); Directory.CreateDirectory(officialFiles);
    await File.WriteAllTextAsync(Path.Combine(officialFiles, "notes.txt"), "exact companion bytes");
    await File.WriteAllTextAsync(Path.Combine(officialFiles, "unrelated.txt"), "not selected");
    var officialPicker = SourcePickerBoundary.CreateToken();
    var official = await SourcePickerBoundary.StageAsync(pickerRuntime, officialFile, officialPicker);
    var officialRoot = Path.Combine(pickerRuntime, "Pickers", officialPicker);
    await File.WriteAllTextAsync(Path.Combine(officialRoot, "assets-plan.json"), JsonSerializer.Serialize(new { schema = "cloudig/picker-assets-plan/1.0.0", platform = "mistral", source_sha256 = official.Sha256, keys = new[] { "notes.txt", "missing.txt" } }));
    await SourcePickerBoundary.StageCompanionsAsync(pickerRuntime, officialFile, officialPicker);
    using (var officialManifest = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(officialRoot, "assets.json"))))
    {
        var entries = officialManifest.RootElement.GetProperty("items").EnumerateArray().ToArray();
        Require(entries.Length == 1 && entries[0].GetProperty("key").GetString() == "notes.txt", "picker copies only proven present companions, not unrelated files");
        Require(await File.ReadAllTextAsync(Path.Combine(officialRoot, entries[0].GetProperty("leaf").GetString()!)) == "exact companion bytes", "official companion bytes retained");
    }
    SourcePickerBoundary.RemoveOwned(pickerRuntime, officialPicker); Require(!Directory.Exists(officialRoot), "official picker cleanup includes its exact companion files");
    var cancelledPicker = SourcePickerBoundary.CreateToken(); using var cancelledPick = new CancellationTokenSource(); cancelledPick.Cancel();
    var pickCancelled = false;
    try { await SourcePickerBoundary.StageAsync(pickerRuntime, selectedSource, cancelledPicker, cancelledPick.Token); } catch (OperationCanceledException) { pickCancelled = true; }
    Require(pickCancelled, "cancelled picker stops staging");
    Require(!Directory.Exists(Path.Combine(pickerRuntime, "Pickers", cancelledPicker)), "cancelled staging leaves no picker payload");
    var chromeRoot = Path.Combine(scope, "Chrome", "User Data");
    var chromeProfile = Path.Combine(chromeRoot, "Default");
    Directory.CreateDirectory(chromeProfile);
    await File.WriteAllTextAsync(Path.Combine(chromeRoot, "Local State"), """
{
  "profile": {
    "last_used": "Default",
    "info_cache": { "Default": { "name": "测试主配置" } }
  }
}
""", new UTF8Encoding(false));
    var chromeBookmarks = Path.Combine(chromeProfile, "Bookmarks");
    await File.WriteAllTextAsync(chromeBookmarks, EmptyChromeBookmarks(), new UTF8Encoding(false));
    var bookmarkSettings = Path.Combine(scope, "Device", "cloudig-device.json");
    var bookmarkHost = new BookmarkCapabilityHost(
        bookmarkManifest,
        bookmarkArtifacts,
        Path.Combine(scope, "BookmarkBackups"),
        bookmarkSettings,
        chromeRoot,
        Path.Combine(Directory.GetCurrentDirectory(), "BOOKMARKLET_CHANGELOG.md"),
        () => BookmarkBrowserState.Closed);
    var bookmarkSummary = await bookmarkHost.QueryAsync("light");
    Require(bookmarkSummary.Platforms.Count == 12 && bookmarkSummary.Stores.Count == 1, "bounded bookmark query");
    Require(bookmarkSummary.Target is { Exists: false, FolderName: BookmarkInstallTarget.DefaultFolderName }, "default top-level bookmark target");
    var configured = await bookmarkHost.SaveTargetAsync(
        "light",
        bookmarkSummary.Target!.Store,
        bookmarkSummary.Target.Parent,
        BookmarkInstallTarget.DefaultFolderName,
        true);
    Require(configured.Target is { PlaceFirst: true }, "bookmark target settings save");
    var bookmarkInstall = await bookmarkHost.InstallAsync("light", ["chatgpt"]);
    Require(bookmarkInstall.Added == 2 && bookmarkInstall.Summary.Platforms.Single(item => item.Id == "chatgpt").Status == "current", "single bookmark install transaction");
    Require((await bookmarkHost.ReadSourceAsync("chatgpt", "full")).StartsWith("javascript:", StringComparison.Ordinal), "exact bookmarklet copy source");
    var bookmarkRemove = await bookmarkHost.RemoveAsync("light", ["chatgpt"]);
    Require(bookmarkRemove.Removed == 2 && bookmarkRemove.Summary.Platforms.Single(item => item.Id == "chatgpt").Status == "missing", "scoped bookmark removal");
    Require(File.Exists(bookmarkSettings), "device-local bookmark settings persisted");
    var deviceSettings = new CloudigDeviceSettingsStore(bookmarkSettings);
    Require((await deviceSettings.LoadAsync()).FolderName == BookmarkInstallTarget.DefaultFolderName, "bookmark settings are independent of Library switching");
    Require(!File.ReadAllText(bookmarkSettings).Contains("recent_library", StringComparison.Ordinal), "device settings do not persist a second Library location");
    var folderDocument = JsonNode.Parse(await File.ReadAllTextAsync(chromeBookmarks))!.AsObject();
    var manyFolders = folderDocument["roots"]!["bookmark_bar"]!["children"]!.AsArray();
    for (var index = 0; index < 400; index++) manyFolders.Add(new JsonObject {
        ["type"]="folder", ["name"]=$"Folder {index:D3}", ["id"]=(index+100).ToString(), ["guid"]=Guid.NewGuid().ToString("D"),
        ["date_added"]="0", ["date_modified"]="0", ["children"]=new JsonArray()
    });
    var folderChecksums = ChromeBookmarkChecksums.Compute(folderDocument);
    folderDocument["checksum"] = folderChecksums.Md5; folderDocument["checksum_sha256"] = folderChecksums.Sha256;
    await File.WriteAllTextAsync(chromeBookmarks, folderDocument.ToJsonString(), new UTF8Encoding(false));
    var completeTargets = await bookmarkHost.QueryAsync("light");
    var lastFolder = completeTargets.Target!.Folders.SingleOrDefault(folder => folder.Name == "Folder 399");
    Require(lastFolder is { Selectable: true }, "bookmark target chooser must not silently omit folders after the first 199");
    var laterTarget = await bookmarkHost.SaveTargetAsync("light", completeTargets.Target.Store, lastFolder!.Capability, BookmarkInstallTarget.DefaultFolderName, true);
    Require(laterTarget.Target!.DisplayPath.Contains("Folder 399", StringComparison.Ordinal), "a later Chrome folder remains selectable and is saved by capability");
    await File.WriteAllTextAsync(chromeBookmarks, EmptyChromeBookmarks(), new UTF8Encoding(false));
    // Simulate failure of the settings write after Chrome has accepted the install.
    var lateSettingsPath = Path.Combine(scope, "Device", "late-bookmark-settings.json");
    var lateSettings = new CloudigDeviceSettingsStore(lateSettingsPath)
    {
        BeforeWriteForTests = value =>
        {
            if (!string.IsNullOrEmpty(value.ManagedFolderGuid)) throw new IOException("Injected final settings failure.");
        }
    };
    var lateHost = new BookmarkCapabilityHost(bookmarkManifest, bookmarkArtifacts, Path.Combine(scope, "LateBookmarkBackups"), lateSettings, chromeRoot, browserState: () => BookmarkBrowserState.Closed);
    await RejectBookmarkAsync(() => lateHost.InstallAsync("light", ["chatgpt"]), "CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED", "final installation settings failure");
    var pendingSettings = await new CloudigDeviceSettingsStore(lateSettingsPath).LoadAsync();
    Require(Guid.TryParse(pendingSettings.InstallationId, out _), "installation identity survives a failed final settings write");
    var installedBeforeRetry = await File.ReadAllBytesAsync(chromeBookmarks);
    var installedDocument = JsonNode.Parse(installedBeforeRetry)!;
    var installedFolder = installedDocument["roots"]!["bookmark_bar"]!["children"]!.AsArray().Single()!;
    var installedGuid = installedFolder["guid"]!.GetValue<string>();
    Require(installedFolder["meta_info"]!["cloudig_installation_id"]!.GetValue<string>() == pendingSettings.InstallationId,
        "persisted installation identity agrees with the Chrome folder");
    var restartedHost = new BookmarkCapabilityHost(bookmarkManifest, bookmarkArtifacts, Path.Combine(scope, "LateBookmarkBackups"), lateSettingsPath, chromeRoot, browserState: () => BookmarkBrowserState.Closed);
    var retriedInstall = await restartedHost.InstallAsync("light", ["chatgpt"]);
    Require(retriedInstall.Added == 0 && retriedInstall.Updated == 0 && retriedInstall.Summary.Platforms.Single(item => item.Id == "chatgpt").Status == "current",
        "restart recognizes the installed bookmark without duplicating it");
    Require((await File.ReadAllBytesAsync(chromeBookmarks)).SequenceEqual(installedBeforeRetry), "settings recovery leaves installed Chrome bytes untouched");
    Require((await new CloudigDeviceSettingsStore(lateSettingsPath).LoadAsync()).ManagedFolderGuid == installedGuid, "retry completes the folder identity record");
    await File.WriteAllTextAsync(chromeBookmarks, EmptyChromeBookmarks(), new UTF8Encoding(false));
    // A readable but read-only device file must fail before Chrome is changed.
    var deniedSettingsPath = Path.Combine(scope, "Device", "readonly-bookmark-settings.json");
    var deniedSettings = new CloudigDeviceSettingsStore(deniedSettingsPath);
    await deniedSettings.SaveAsync(BookmarkDeviceSettings.Default);
    var beforeDeniedInstall = await File.ReadAllBytesAsync(chromeBookmarks);
    File.SetAttributes(deniedSettingsPath, File.GetAttributes(deniedSettingsPath) | FileAttributes.ReadOnly);
    var deniedHost = new BookmarkCapabilityHost(bookmarkManifest, bookmarkArtifacts, Path.Combine(scope, "DeniedBackups"), deniedSettings, chromeRoot, browserState: () => BookmarkBrowserState.Closed);
    try { await RejectBookmarkAsync(() => deniedHost.InstallAsync("light", ["chatgpt"]), "CLOUDIG_BOOKMARK_ACCESS_DENIED", "unwritable installation identity"); }
    finally { File.SetAttributes(deniedSettingsPath, FileAttributes.Normal); }
    Require((await File.ReadAllBytesAsync(chromeBookmarks)).SequenceEqual(beforeDeniedInstall), "first install cannot write Chrome before preserving its installation identity");
    var openBookmarkHost = new BookmarkCapabilityHost(
        bookmarkManifest,
        bookmarkArtifacts,
        Path.Combine(scope, "OpenBookmarkBackups"),
        Path.Combine(scope, "Device", "open-cloudig-device.json"),
        chromeRoot,
        browserState: () => BookmarkBrowserState.Open);
    await RejectBookmarkAsync(() => openBookmarkHost.InstallAsync("light", ["chatgpt"]), "CLOUDIG_CHROME_OPEN", "open Chrome fail closed");
    var moveSource = Path.Combine(scope, "MoveSource");
    var moveTarget = Path.Combine(scope, "MoveTarget");
    CreateMoveLibrary(moveSource, "rename payload");
    Directory.CreateDirectory(moveTarget);
    var moveBoundary = new LibraryMoveBoundary();
    var movePlan = await moveBoundary.PlanAsync(moveSource, moveTarget);
    Require(movePlan.Strategy == "rename" && movePlan.TotalFiles == 4 && movePlan.TotalDirectories >= 3, "same-volume complete Cloudig move plan");
    var inconsistentPlan = movePlan with { Files = movePlan.Files.Select((file, index) => index == 0 ? file with { RelativePath = "unrelated-user-file.txt" } : file).ToArray() };
    Reject(() => LibraryMoveBoundary.ValidatePlan(inconsistentPlan), "recovery manifest rows must match their persisted fingerprint");
    var movedLibrary = await moveBoundary.PrepareTargetAsync(movePlan);
    Require(!Directory.Exists(moveSource) && File.Exists(Path.Combine(moveTarget, "Conversations", "archive.json")), "same-volume Library move publication");
    await moveBoundary.RollbackAsync(movedLibrary);
    Require(Directory.Exists(moveSource) && Directory.Exists(moveTarget) && !Directory.EnumerateFileSystemEntries(moveTarget).Any(), "same-volume Library move rollback");

    var copySource = Path.Combine(scope, "CopySource");
    var copyTarget = Path.Combine(scope, "CopyTarget");
    CreateMoveLibrary(copySource, "copy payload");
    Directory.CreateDirectory(copyTarget);
    var copyBoundary = new LibraryMoveBoundary(forceCopyForTests: true);
    var copyPlan = await copyBoundary.PlanAsync(copySource, copyTarget);
    Require(copyPlan.Strategy == "copy_verify", "copy-verify Library move plan");
    var copiedLibrary = await copyBoundary.PrepareTargetAsync(copyPlan);
    Require(Directory.Exists(copySource) && File.Exists(Path.Combine(copyTarget, "Conversations", "archive.json")), "copy-verify target publication preserves source before pointer switch");
    await copyBoundary.CompleteSourceCleanupAsync(copiedLibrary);
    Require(!Directory.Exists(copySource) && File.Exists(Path.Combine(copyTarget, "CloudigLibrary.json")), "copy-verify cleanup removes only verified old root");

    var lateSource = Path.Combine(scope, "Late source"); var lateTarget = Path.Combine(scope, "Late target");
    CreateMoveLibrary(lateSource, "source before cleanup"); Directory.CreateDirectory(lateTarget);
    var latePlan = await copyBoundary.PlanAsync(lateSource, lateTarget); var lateInstallation = await copyBoundary.PrepareTargetAsync(latePlan);
    try
    {
        await copyBoundary.CompleteSourceCleanupAsync(lateInstallation, progress: value => { if (value.Phase == "cleanup") File.WriteAllText(Path.Combine(lateSource, "new-user-file.txt"), "keep me"); });
        throw new InvalidOperationException("Unexpected new files must not be recursively deleted.");
    }
    catch (IOException) { Require(File.ReadAllText(Path.Combine(lateSource, "new-user-file.txt")) == "keep me", "late source file survives cleanup"); }

    var occupiedSource = Path.Combine(scope, "OccupiedSource");
    var occupiedTarget = Path.Combine(scope, "OccupiedTarget");
    CreateMoveLibrary(occupiedSource, "occupied payload");
    Directory.CreateDirectory(occupiedTarget);
    await File.WriteAllTextAsync(Path.Combine(occupiedTarget, "unknown.txt"), "unknown");
    await RejectMoveAsync(() => moveBoundary.PlanAsync(occupiedSource, occupiedTarget), "nonempty Library move target");
    var cancelledMoveSource = Path.Combine(scope, "CancelledBeginSource");
    var cancelledMoveTarget = Path.Combine(scope, "CancelledBeginTarget");
    CreateMoveLibrary(cancelledMoveSource, "cancelled preparation preserves this data");
    Directory.CreateDirectory(cancelledMoveTarget);
    try
    {
        await PortableLibraryMove.BeginAsync(cancelledMoveSource, cancelledMoveTarget,
            @"\\.\pipe\Cloudig-V1-Writer-" + Guid.NewGuid().ToString("N"),
            @"\\.\pipe\Cloudig-V1-Writer-" + Guid.NewGuid().ToString("N"), new CancellationToken(true));
        throw new InvalidOperationException("Move preparation should have been cancelled.");
    }
    catch (OperationCanceledException) { }
    Require(!PortableLibraryMove.IsPending(cancelledMoveSource), "cancelled move preparation must not leave a partial request that blocks startup");
    Require(!File.Exists(PortableLibraryMove.RequestPath(cancelledMoveSource) + ".next"), "cancelled preparation retires only its own scratch file");
    Require(File.Exists(Path.Combine(cancelledMoveSource, "Conversations", "archive.json")) && !Directory.EnumerateFileSystemEntries(cancelledMoveTarget).Any(), "cancelled preparation leaves original data and target untouched");
    var moveSourceEndpoint = @"\\.\pipe\Cloudig-V1-Writer-" + Guid.NewGuid().ToString("N");
    var moveTargetEndpoint = @"\\.\pipe\Cloudig-V1-Writer-" + Guid.NewGuid().ToString("N");
    await File.WriteAllTextAsync(PortableLibraryMove.RequestPath(cancelledMoveSource) + ".next", "{\"schema\":\"cloudig/library-move/1.0.0\",");
    await PortableLibraryMove.BeginAsync(cancelledMoveSource, cancelledMoveTarget, moveSourceEndpoint, moveTargetEndpoint);
    var retainedRequest = await File.ReadAllBytesAsync(PortableLibraryMove.RequestPath(cancelledMoveSource));
    try
    {
        await PortableLibraryMove.BeginAsync(cancelledMoveSource, cancelledMoveTarget, moveSourceEndpoint, moveTargetEndpoint);
        throw new InvalidOperationException("An existing move request must not be replaced.");
    }
    catch (IOException) { }
    var afterRejectedMove = await File.ReadAllBytesAsync(PortableLibraryMove.RequestPath(cancelledMoveSource));
    Require(retainedRequest.SequenceEqual(afterRejectedMove), "atomic preparation does not overwrite an existing move");
    Require(!File.Exists(PortableLibraryMove.RequestPath(cancelledMoveSource) + ".next"), "a rejected second preparation leaves no new scratch file");
    var activeScratch = PortableLibraryMove.RequestPath(cancelledMoveSource) + ".next";
    await File.WriteAllTextAsync(activeScratch, "keep the published operation's scratch");
    try
    {
        await PortableLibraryMove.BeginAsync(cancelledMoveSource, cancelledMoveTarget, moveSourceEndpoint, moveTargetEndpoint);
        throw new InvalidOperationException("A published move must block a new preparation before scratch cleanup.");
    }
    catch (IOException) { }
    Require(await File.ReadAllTextAsync(activeScratch) == "keep the published operation's scratch", "published move scratch is not retired by another begin");
    await PortableMoveChecks.RunAsync(scope, args[0]);
    await PortableMoveChecks.RunResumptionChecksAsync(scope, args[0]);
    await RuntimeFileResponseChecks.RunAsync(scope);
    var engine = Path.Combine(scope, "engine.mjs");
    await File.WriteAllTextAsync(engine, """
import readline from "node:readline";
const protocol = "cloudig/engine-ipc/1.0.0";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const cacheRoot = process.argv[process.argv.indexOf('--cache-root')+1];
const active = new Map();
const respond = (request, ok, value) => process.stdout.write(JSON.stringify({ protocol, kind: 'response', request, ok, [ok ? 'result' : 'error']: value })+'\n');
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.command === "engine.handshake") {
    process.stdout.write(JSON.stringify({ protocol, kind: "response", request: request.request, ok: true, result: { protocol, engine_version: "fixture", commands: ["engine.handshake", "engine.shutdown", "test.echo", "test.events"] } }) + "\n");
  } else if (request.command === "engine.storage") {
    respond(request.request,true,{runtime_root:cacheRoot+'\\fixture'});
  } else if (request.command === "test.echo") {
    process.stdout.write(JSON.stringify({ protocol, kind: "response", request: request.request, ok: true, result: request.payload }) + "\n");
  } else if (request.command === "test.events") {
    process.stdout.write(JSON.stringify({ protocol, kind: "event", request: request.request, event: { phase: "extract", bytes: { completed: 1, total: 2 } } }) + "\n");
    process.stdout.write(JSON.stringify({ protocol, kind: "response", request: request.request, ok: true, result: { completed: true } }) + "\n");
  } else if (request.command === "test.slow") {
    if (active.size >= 4) { respond(request.request, false, {code:'CLOUDIG_IPC_BUSY', message:'capacity full'}); continue; }
    const timer=setTimeout(() => { active.delete(request.request); respond(request.request,true,request.payload); },request.payload.delay??20);
    active.set(request.request,timer);
  } else if (request.command === "engine.cancel") {
    const timer=active.get(request.payload.target);
    if (timer) { clearTimeout(timer); setTimeout(() => {active.delete(request.payload.target);respond(request.payload.target,false,{code:'CLOUDIG_CANCELLED',message:'cancelled'});},60); }
    respond(request.request,true,{cancelled:!!timer});
  } else if (request.command === "engine.shutdown") {
    for (const timer of active.values()) clearTimeout(timer);
    process.stdout.write(JSON.stringify({ protocol, kind: "response", request: request.request, ok: true, result: { stopped: true } }) + "\n");
    break;
  }
}
""");
    int processId;
    await using (var client = await EngineJsonlClient.StartAsync(args[0], engine, library, Path.Combine(scope, "cache")))
    {
        processId = client.ProcessId;
        using var payloadDocument = JsonDocument.Parse("{\"value\":\"hello\"}");
        var response = await client.SendAsync("test.echo", payloadDocument.RootElement.Clone());
        Require(response.GetProperty("value").GetString() == "hello", "typed Engine round trip");
        JsonElement? observedEvent = null;
        var eventResponse = await client.SendWithEventsAsync("test.events", JsonDocument.Parse("{}").RootElement.Clone(), value => observedEvent = value);
        Require(eventResponse.GetProperty("completed").GetBoolean(), "Engine event command response");
        Require(observedEvent?.GetProperty("phase").GetString() == "extract", "correlated Engine event delivery");
        var burst = await Task.WhenAll(Enumerable.Range(0, 40).Select(index => client.SendAsync("test.slow", JsonSerializer.SerializeToElement(new { index, delay = 20 }))));
        Require(burst.Length == 40 && burst.Select(item => item.GetProperty("index").GetInt32()).Distinct().Count() == 40, "resource burst queues instead of overflowing the four-command Engine");
        using var activeCancel = new CancellationTokenSource();
        var cancelledRequest = client.SendAsync("test.slow", JsonSerializer.SerializeToElement(new { delay = 250 }), activeCancel.Token);
        var occupied = Enumerable.Range(0, 3).Select(_ => client.SendAsync("test.slow", JsonSerializer.SerializeToElement(new { delay = 250 }))).ToArray();
        await Task.Delay(20);
        using var queuedCancel = new CancellationTokenSource();
        var cancelledQueue = client.SendAsync("test.slow", JsonSerializer.SerializeToElement(new { delay = 250 }), queuedCancel.Token);
        queuedCancel.Cancel();
        try { await cancelledQueue; throw new InvalidOperationException("Queued command should cancel before dispatch."); } catch (OperationCanceledException) { }
        activeCancel.Cancel();
        try { await cancelledRequest; throw new InvalidOperationException("Active caller cancellation should complete promptly."); } catch (OperationCanceledException) { }
        var afterCancel = Enumerable.Range(0, 12).Select(index => client.SendAsync("test.slow", JsonSerializer.SerializeToElement(new { index, delay = 15 }))).ToArray();
        await Task.WhenAll(occupied.Concat(afterCancel));
        Require(afterCancel.All(task => task.IsCompletedSuccessfully), "cancel bypasses a full queue and capacity is released only after the Engine response");
    }
    await Task.Delay(50);
    try
    {
        using var remaining = Process.GetProcessById(processId);
        Require(remaining.HasExited, "owned Engine PID exited");
    }
    catch (ArgumentException)
    {
        // The exact owned PID no longer exists.
    }
    await EngineTransportChecks.RunAsync(scope, args[0]);
    if (packagedEngine is not null)
    {
        var emptyLibrary = Path.Combine(scope, "FirstRunLibrary");
        Directory.CreateDirectory(emptyLibrary);
        await using var firstRun = await EngineJsonlClient.StartAsync(args[0], packagedEngine, emptyLibrary, Path.Combine(emptyLibrary, "cache"));
        var missing = await firstRun.SendAsync("library.startup.recover", JsonDocument.Parse("{}").RootElement.Clone());
        Require(missing.GetProperty("status").GetString() == "missing", "empty portable Library inspection");
        var created = await firstRun.SendAsync("library.create", JsonDocument.Parse("{}").RootElement.Clone());
        Require(created.GetProperty("status").GetString() == "created", "first-run portable Library creation");
        Require(File.Exists(Path.Combine(emptyLibrary, "CloudigLibrary.json")), "first-run new Library authority installed");
        var preferences = await firstRun.SendAsync("library.preferences.query", JsonDocument.Parse("{}").RootElement.Clone());
        Require(preferences.GetProperty("user_name").GetString() == "采云用户", "Engine UTF-8 identity response");
    }
    var startupCalls = new List<string>(); var recoveryChoices = 0; var startupPhase = 0;
    var operationId = "01993520-0000-7000-8000-000000000101";
    var startup = await RecordStartupBoundary.InitializeAsync((command, payload, _) => {
        startupCalls.Add(command);
        if (command == "library.startup.recover") return Task.FromResult(JsonSerializer.SerializeToElement(startupPhase == 0 ? new { status = "transaction_recovery", operations = new[] { operationId } } : new { status = "valid", operations = Array.Empty<string>() }));
        Require(command == "library.recovery.commit" && payload.GetProperty("operation").GetString() == operationId && payload.GetProperty("action").GetString() == "rollback", "startup uses an explicit per-operation recovery choice"); startupPhase++; return Task.FromResult(JsonSerializer.SerializeToElement(new { status = "valid" }));
    }, _ => { recoveryChoices++; return Task.FromResult(RecordRecoveryChoice.Rollback); });
    Require(startup.GetProperty("status").GetString() == "valid" && recoveryChoices == 1 && startupCalls.SequenceEqual(new[] { "library.startup.recover", "library.recovery.commit", "library.startup.recover" }), "no automatic legacy reconciliation");
    foreach (var refused in new[] { "unsupported", "unsafe", "transaction_recovery", "settings_recovery" }) {
        var writes = 0;
        try {
            await RecordStartupBoundary.InitializeAsync((command, _, _) => { if (command != "library.startup.recover") writes++; return Task.FromResult(JsonSerializer.SerializeToElement(new { status = refused, operations = new[] { operationId } })); }, _ => Task.FromResult(RecordRecoveryChoice.Cancel));
            throw new InvalidOperationException("Unsafe or cancelled startup must stop.");
        } catch (CloudigLibraryStartupException) { Require(writes == 0, "unsupported/unsafe/cancelled startup preserves all original records"); }
    }
    foreach (var approved in new[] { false, true }) {
        var calls = new List<string>(); var restored = false; var confirmations = 0;
        try {
            await RecordStartupBoundary.InitializeAsync((command, _, _) => {
                calls.Add(command);
                if (command == "library.settings.recover") restored = true;
                else Require(command == "library.startup.recover", "settings recovery never initializes a whole Library");
                return Task.FromResult(JsonSerializer.SerializeToElement(new { status = restored ? "valid" : "settings_recovery" }));
            }, _ => throw new InvalidOperationException("No transaction recovery expected"), confirmRestoreSettings: () => { confirmations++; return Task.FromResult(approved); });
            Require(approved, "declined settings recovery must stop startup");
        } catch (CloudigLibraryStartupException) { Require(!approved, "approved settings recovery should complete"); }
        Require(confirmations == 1 && calls.SequenceEqual(approved
            ? new[] { "library.startup.recover", "library.settings.recover", "library.startup.recover" }
            : new[] { "library.startup.recover" }), "only an explicit confirmation restores missing settings");
    }
}
finally
{
    Directory.Delete(scope, recursive: true);
}

Console.WriteLine("Cloudig desktop core checks passed.");

static void Require(bool condition, string label)
{
    if (!condition) throw new InvalidOperationException($"Failed: {label}");
}

static void Reject(Action action, string label)
{
    try
    {
        action();
        throw new InvalidOperationException($"Failed to reject: {label}");
    }
    catch (InvalidDataException)
    {
        // Expected.
    }
}

static void RejectSurface(Action action)
{
    try
    {
        action();
        throw new InvalidOperationException("Failed to reject an invalid window surface.");
    }
    catch (ArgumentOutOfRangeException)
    {
        // Expected.
    }
}

static void RejectSystemLog(Action action, string code, string label)
{
    try
    {
        action();
        throw new InvalidOperationException($"Failed to reject: {label}");
    }
    catch (SystemLogRevealException error) when (error.Code == code)
    {
        // Expected.
    }
}

static async Task RejectAsync(Func<Task> action, string label)
{
    try
    {
        await action();
        throw new InvalidOperationException($"Failed to reject: {label}");
    }
    catch (InvalidDataException)
    {
        // Expected.
    }
}

static async Task RejectBookmarkAsync(Func<Task> action, string code, string label)
{
    try
    {
        await action();
        throw new InvalidOperationException($"Failed to reject: {label}");
    }
    catch (BookmarkCapabilityException error) when (error.Code == code)
    {
        // Expected.
    }
}

static string EmptyChromeBookmarks()
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
    var checksum = ChromeBookmarkChecksums.Compute(document);
    document["checksum"] = checksum.Md5;
    document["checksum_sha256"] = checksum.Sha256;
    return document.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
}

static void CreateMoveLibrary(string root, string payload)
{
    Directory.CreateDirectory(Path.Combine(root, "app"));
    Directory.CreateDirectory(Path.Combine(root, "Conversations"));
    Directory.CreateDirectory(Path.Combine(root, "Inbox", "Empty"));
    File.WriteAllText(Path.Combine(root, "CloudigLibrary.json"), "{\"schema\":\"cloudig/library/1.0.0\"}\n", new UTF8Encoding(false));
    File.WriteAllText(Path.Combine(root, "Cloudig.exe"), "test executable placeholder", new UTF8Encoding(false));
    File.WriteAllText(Path.Combine(root, "app", "Cloudig.dll"), "test assembly placeholder", new UTF8Encoding(false));
    File.WriteAllText(Path.Combine(root, "Conversations", "archive.json"), payload, new UTF8Encoding(false));
}

static async Task RejectMoveAsync(Func<Task> action, string label)
{
    try
    {
        await action();
        throw new InvalidOperationException($"Failed to reject: {label}");
    }
    catch (InvalidDataException)
    {
        // Expected.
    }
}
