using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class PortableMoveChecks
{
    public static async Task RunExistingRootAsync(string source, string target, string[] endpoints)
    {
        var parent = Path.GetFullPath("tests/private/schema-rebuild");
        source = Path.GetFullPath(source); target = Path.GetFullPath(target);
        Require(source.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            && target.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "only the explicit private test subtree may be moved");
        Require(File.Exists(Path.Combine(source, "app", "Cloudig.dll")) && File.Exists(Path.Combine(source, "CloudigLibrary.json")), "the test needs a real complete program and Library");
        var preview = await PortableLibraryMove.PreviewAsync(source, target);
        using var owner = PrepareProcess(source, target, endpoints, "rename", true);
        PreparedPortableMove? prepared = null;
        Process? helper = null;
        try
        {
            prepared = JsonSerializer.Deserialize<PreparedPortableMove>(await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30)) ?? throw new IOException(await owner.StandardError.ReadToEndAsync()))!;
            helper = Process.Start(Redirect(PortableLibraryMove.HelperStartInfo(prepared, noRestartForTests: true)))!;
            await Task.Delay(250);
            Require(!owner.HasExited && !helper.HasExited && File.Exists(Path.Combine(source, "Cloudig.exe")), "the actual package stays in place until its exact owner exits");
            await owner.StandardInput.WriteLineAsync("exit"); owner.StandardInput.Close();
            await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Require(owner.ExitCode == 0, await owner.StandardError.ReadToEndAsync());
            await helper.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); Require(helper.ExitCode == 0, await helper.StandardError.ReadToEndAsync());
            var completed = await PortableMoveStartup.ResolveAsync(target, _ => throw new InvalidOperationException("The explicit target completion does not prompt"), _ => throw new InvalidOperationException("The target must not launch a second helper"), prepared.Request.Operation, prepared.RequestSha256);
            Require(completed.OpenLibrary && completed.Result?.Status == "completed" && !Directory.Exists(source), "the whole actual root must complete at its new location");
            Console.WriteLine(JsonSerializer.Serialize(new { status = "passed", strategy = prepared.Request.Plan!.Strategy, files = preview.TotalFiles, bytes = preview.TotalBytes, waited_for_owner = true, source_absent = true, automatic_window_restart = false }));
        }
        finally
        {
            if (!owner.HasExited) { owner.Kill(); await owner.WaitForExitAsync(); }
            if (helper is not null) { if (!helper.HasExited) { helper.Kill(); await helper.WaitForExitAsync(); } helper.Dispose(); }
        }
    }

    public static async Task RunAsync(string scope, string node)
    {
        foreach (var strategy in new[] { "rename", "copy" })
        {
            var source = Path.Combine(scope, "Whole " + strategy); var target = Path.Combine(scope, "Moved " + strategy);
            Create(source); Directory.CreateDirectory(target);
            var endpoints = await Endpoints(node, source, target);
            using var owner = PrepareProcess(source, target, endpoints, strategy, strategy == "rename");
            var prepared = JsonSerializer.Deserialize<PreparedPortableMove>(await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)) ?? throw new IOException(await owner.StandardError.ReadToEndAsync()))!;
            using var helper = Process.Start(Redirect(PortableLibraryMove.HelperStartInfo(prepared, noRestartForTests: true)))!;
            if (strategy == "rename")
            {
                // A live exact process is the waiting proof, not an inferred PID.
                await Task.Delay(250); Require(!owner.HasExited && !helper.HasExited && File.Exists(Path.Combine(source, "Cloudig.exe")), "helper must wait for the original host");
                await owner.StandardInput.WriteLineAsync("exit"); owner.StandardInput.Close();
            }
            await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Require(owner.ExitCode == 0, await owner.StandardError.ReadToEndAsync());
            await helper.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); Require(helper.ExitCode == 0, await helper.StandardError.ReadToEndAsync());
            Require(File.Exists(Path.Combine(target, "Marks", "mark.json")), "helper copies the whole root including Mark");
            if (strategy == "copy") Require(File.Exists(Path.Combine(source, "Conversations", "archive.json")), "cross-volume copy leaves the source until native verification");
            var completed = await PortableLibraryMove.CompleteAsync(target, prepared.Request.Operation, prepared.RequestSha256);
            Require(completed.Status == "completed" && !Directory.Exists(source), completed.Message ?? "complete move should retire source");
            Require(!PortableLibraryMove.IsPending(target), "successful move clears only its control request");
            foreach (var file in new[] { "Cloudig.exe", "app/Cloudig.dll", "CloudigLibrary.json", "Conversations/archive.json", "Marks/mark.json", "ContentTimes/time.json", "Identities/front.json", "Inbox/source.html", "Archives/saved.json", "Exports/export.md", "bookmarks/profile.js", "docs/user-note.md", "appdata/preference.json", "cache/unknown.dat" })
                Require(await File.ReadAllTextAsync(Path.Combine(target, file)) == "original " + file, "whole-root file changed: " + file);
        }

        var changedSource = Path.Combine(scope, "Changed source"); var changedTarget = Path.Combine(scope, "Changed target");
        Create(changedSource); Directory.CreateDirectory(changedTarget);
        var changedEndpoints = await Endpoints(node, changedSource, changedTarget);
        using (var owner = PrepareProcess(changedSource, changedTarget, changedEndpoints, "copy", false))
        {
            var prepared = JsonSerializer.Deserialize<PreparedPortableMove>(await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)) ?? throw new IOException(await owner.StandardError.ReadToEndAsync()))!;
            await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Require(owner.ExitCode == 0, "prepare owner failed");
            using var helper = Process.Start(Redirect(PortableLibraryMove.HelperStartInfo(prepared, noRestartForTests: true)))!;
            await helper.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); Require(helper.ExitCode == 0, await helper.StandardError.ReadToEndAsync());
            await File.WriteAllTextAsync(Path.Combine(changedSource, "Marks/mark.json"), "new source content");
            try { await PortableLibraryMove.CompleteAsync(changedTarget, prepared.Request.Operation, prepared.RequestSha256); throw new InvalidOperationException("Changed source must fail transfer, not become a cleanup warning"); }
            catch (IOException) { }
            Require(PortableLibraryMove.IsPending(changedTarget) && await File.ReadAllTextAsync(Path.Combine(changedSource, "Marks/mark.json")) == "new source content", "source change remains visible and blocks completion");
            await File.WriteAllTextAsync(Path.Combine(changedSource, "Marks/mark.json"), "original Marks/mark.json");
            // Restore the original file timestamps from this test's frozen plan.
            var mark = prepared.Request.Plan!.Files.Single(file => file.RelativePath == "Marks/mark.json");
            File.SetCreationTimeUtc(Path.Combine(changedSource, "Marks/mark.json"), new DateTime(mark.CreationTimeUtcTicks, DateTimeKind.Utc));
            File.SetLastWriteTimeUtc(Path.Combine(changedSource, "Marks/mark.json"), new DateTime(mark.LastWriteTimeUtcTicks, DateTimeKind.Utc));
            await File.WriteAllTextAsync(Path.Combine(changedTarget, "Marks/mark.json"), "new user content");
            try { await PortableLibraryMove.CompleteAsync(changedTarget, prepared.Request.Operation, prepared.RequestSha256); throw new InvalidOperationException("Changed destination must not delete source"); }
            catch (IOException) { }
            Require(File.Exists(Path.Combine(changedSource, "Cloudig.exe")) && await File.ReadAllTextAsync(Path.Combine(changedSource, "Marks/mark.json")) == "original Marks/mark.json", "failed verification preserves source");
        }

        var blocker = Path.Combine(scope, "Live node writer"); var blockedTarget = Path.Combine(scope, "Blocked target"); Create(blocker); Directory.CreateDirectory(blockedTarget);
        var blockerEndpoints = await Endpoints(node, blocker, blockedTarget);
        var writerScript = "const {acquireSingleWriter}=await import((await import('node:url')).pathToFileURL(process.argv[1]));const w=await acquireSingleWriter(process.argv[2]);console.log('locked');process.stdin.once('data',async()=>{await w.release();process.exit(0)});process.stdin.resume();";
        using var writer = Process.Start(Node(node, writerScript, Path.GetFullPath("src/adapters/storage/writer-lock.mts"), blocker))!;
        try
        {
            Require(await writer.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)) == "locked", "Node writer must be live");
            try { await PortableLibraryMove.BeginAsync(blocker, blockedTarget, blockerEndpoints[0], blockerEndpoints[1]); throw new InvalidOperationException("Native move must share the Node writer exclusion"); }
            catch (IOException) { } catch (UnauthorizedAccessException) { }
            Require(!PortableLibraryMove.IsPending(blocker), "failed writer lease must not create a move request");
        }
        finally { await writer.StandardInput.WriteLineAsync("exit"); writer.StandardInput.Close(); await writer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
    }

    public static async Task RunResumptionChecksAsync(string scope, string node)
    {
        var source = Path.Combine(scope, "Resume source"); var target = Path.Combine(scope, "Resume target");
        Create(source); Directory.CreateDirectory(target);
        var preview = await PortableLibraryMove.PreviewAsync(source, target);
        Require(preview.TotalFiles == 13 && !PortableLibraryMove.IsPending(source), "preview is metadata-only and excludes volatile cache");
        var prepared = await PrepareExitedAsync(source, target, await Endpoints(node, source, target));
        var requestBefore = await File.ReadAllBytesAsync(PortableLibraryMove.RequestPath(source));
        var deferred = await PortableMoveStartup.ResolveAsync(source, prompt => { Require(prompt.CanCancel, "original location offers cancellation"); return Task.FromResult(PortableMoveChoice.Defer); }, _ => throw new InvalidOperationException("Defer cannot launch a helper"));
        var requestAfterDefer = await File.ReadAllBytesAsync(PortableLibraryMove.RequestPath(source));
        Require(!deferred.OpenLibrary && requestBefore.SequenceEqual(requestAfterDefer), "defer does not mutate the pending request");

        // A verifiable partial destination can resume without replacing any
        // already copied file; unknown or modified content is never overwritten.
        foreach (var relative in new[] { "appdata/Move/request.json", "Conversations/archive.json" })
        {
            var destination = Path.Combine(target, relative); Directory.CreateDirectory(Path.GetDirectoryName(destination)!); File.Copy(Path.Combine(source, relative), destination);
            File.SetCreationTimeUtc(destination, File.GetCreationTimeUtc(Path.Combine(source, relative))); File.SetLastWriteTimeUtc(destination, File.GetLastWriteTimeUtc(Path.Combine(source, relative)));
        }
        using (var resumedOwner = TestProcess("--portable-move-resume-test", source))
        {
            prepared = JsonSerializer.Deserialize<PreparedPortableMove>(await resumedOwner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)) ?? throw new IOException(await resumedOwner.StandardError.ReadToEndAsync()))!;
            await resumedOwner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Require(resumedOwner.ExitCode == 0 && prepared.ResumeCopy, await resumedOwner.StandardError.ReadToEndAsync());
        }
        await RunHelperAsync(prepared);
        var finished = await PortableMoveStartup.ResolveAsync(target.ToLowerInvariant(), _ => throw new InvalidOperationException("Explicit completion does not prompt again"), _ => throw new InvalidOperationException("Target completion does not recopy"), prepared.Request.Operation, prepared.RequestSha256);
        Require(finished.OpenLibrary && finished.Result?.Status == "completed" && !Directory.Exists(source), "source resume reaches target startup completion");
        var repeated = await PortableMoveStartup.ResolveAsync(target, _ => throw new InvalidOperationException(), _ => throw new InvalidOperationException(), prepared.Request.Operation, prepared.RequestSha256);
        Require(repeated.OpenLibrary && repeated.Result is null, "a duplicate completed launch does not move again");

        var cancelSource = Path.Combine(scope, "Cancel source"); var cancelTarget = Path.Combine(scope, "Cancel target");
        Create(cancelSource); Directory.CreateDirectory(cancelTarget);
        var cancelledPlan = await PrepareExitedAsync(cancelSource, cancelTarget, await Endpoints(node, cancelSource, cancelTarget));
        await File.WriteAllTextAsync(Path.Combine(cancelSource, "appdata/Move/request.json.next"), "incomplete control write");
        await File.WriteAllTextAsync(Path.Combine(cancelTarget, "new-user-file.txt"), "keep both sides");
        var cancelled = await PortableMoveStartup.ResolveAsync(cancelSource, _ => Task.FromResult(PortableMoveChoice.Cancel), _ => throw new InvalidOperationException("Cancel cannot launch a helper"));
        Require(cancelled.OpenLibrary && cancelled.Result?.Status == "cancelled" && !PortableLibraryMove.IsPending(cancelSource), "cancel reopens only the unchanged original root");
        Require(!File.Exists(Path.Combine(cancelSource, "appdata/Move/request.json.next")), "cancel retires its exact interrupted control staging file");
        Require(await File.ReadAllTextAsync(Path.Combine(cancelTarget, "new-user-file.txt")) == "keep both sides" && File.Exists(Path.Combine(cancelSource, "Marks/mark.json")), "cancel deletes no copied or original user file");

        var crashSource = Path.Combine(scope, "Cleanup source"); var crashTarget = Path.Combine(scope, "Cleanup target");
        Create(crashSource); Directory.CreateDirectory(crashTarget);
        var crashPlan = await PrepareExitedAsync(crashSource, crashTarget, await Endpoints(node, crashSource, crashTarget)); await RunHelperAsync(crashPlan);
        using (var interrupted = TestProcess("--portable-move-complete-interrupt-test", crashTarget, crashPlan.Request.Operation, crashPlan.RequestSha256))
        {
            await interrupted.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); Require(interrupted.ExitCode == 77, await interrupted.StandardError.ReadToEndAsync());
        }
        Require(PortableLibraryMove.IsPending(crashTarget) && (await PortableLibraryMove.ReadResultAsync(crashTarget))?.Status == "cleanup_pending", "a real exit during cleanup leaves the complete destination and a resumable request");
        await File.WriteAllTextAsync(Path.Combine(crashTarget, "appdata/Move/result.json.next"), "incomplete result write");
        var recovered = await PortableMoveStartup.ResolveAsync(crashTarget, prompt => { Require(!prompt.CanCancel, "a transferred target does not offer false rollback"); return Task.FromResult(PortableMoveChoice.Continue); }, _ => throw new InvalidOperationException("Cleanup recovery must not recopy"));
        Require(recovered.OpenLibrary && recovered.Result?.Status == "completed" && !Directory.Exists(crashSource), "reopen continues exact remaining cleanup after a real process exit");
    }

    private static async Task<PreparedPortableMove> PrepareExitedAsync(string source, string target, string[] endpoints)
    {
        using var owner = PrepareProcess(source, target, endpoints, "copy", false);
        var line = await owner.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)); await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Require(owner.ExitCode == 0, await owner.StandardError.ReadToEndAsync()); return JsonSerializer.Deserialize<PreparedPortableMove>(line!)!;
    }
    private static async Task RunHelperAsync(PreparedPortableMove prepared)
    {
        using var helper = Process.Start(Redirect(PortableLibraryMove.HelperStartInfo(prepared, noRestartForTests: true)))!;
        await helper.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); Require(helper.ExitCode == 0, await helper.StandardError.ReadToEndAsync());
    }
    private static Process TestProcess(params string[] args)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg); return Process.Start(start)!;
    }
    private static Process PrepareProcess(string source, string target, string[] endpoints, string strategy, bool wait)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var value in new[] { "--portable-move-prepare-test", source, target, endpoints[0], endpoints[1], strategy, wait ? "wait" : "exit" }) start.ArgumentList.Add(value);
        return Process.Start(start)!;
    }
    private static ProcessStartInfo Redirect(ProcessStartInfo start) { start.RedirectStandardOutput = true; start.RedirectStandardError = true; return start; }
    private static async Task<string[]> Endpoints(string node, string source, string target)
    {
        var script = "const {singleWriterEndpoint}=await import((await import('node:url')).pathToFileURL(process.argv[1]));console.log(JSON.stringify(await Promise.all(process.argv.slice(2).map(singleWriterEndpoint))));";
        using var process = Process.Start(Node(node, script, Path.GetFullPath("src/adapters/storage/writer-lock.mts"), source, target))!;
        var output = await process.StandardOutput.ReadToEndAsync(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Require(process.ExitCode == 0, await process.StandardError.ReadToEndAsync()); return JsonSerializer.Deserialize<string[]>(output)!;
    }
    private static ProcessStartInfo Node(string node, string script, params string[] args)
    {
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--input-type=module"); start.ArgumentList.Add("-e"); start.ArgumentList.Add(script); foreach (var value in args) start.ArgumentList.Add(value); return start;
    }
    private static void Create(string root)
    {
        foreach (var file in new[] { "Cloudig.exe", "app/Cloudig.dll", "CloudigLibrary.json", "Conversations/archive.json", "Marks/mark.json", "ContentTimes/time.json", "Identities/front.json", "Inbox/source.html", "Archives/saved.json", "Exports/export.md", "bookmarks/profile.js", "docs/user-note.md", "appdata/preference.json", "cache/unknown.dat" })
        { var target = Path.Combine(root, file); Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.WriteAllText(target, "original " + file, new UTF8Encoding(false)); }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
