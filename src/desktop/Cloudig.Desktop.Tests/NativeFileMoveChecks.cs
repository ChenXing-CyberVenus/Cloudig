using System.Diagnostics;
using Cloudig.Desktop.Core;

internal static class NativeFileMoveChecks
{
    public static async Task RunAsync(string node)
    {
        var root = Path.GetFullPath("tests/private"); Directory.CreateDirectory(root);
        var probe = Path.Combine(root, "storage-probe-" + Guid.NewGuid().ToString("N"));
        PortableStorageBoundary.Verify(probe);
        if (Directory.Exists(probe)) throw new Exception("The disposable native storage probe did not clean up.");
        await using var broker = new NativeFileMoves(root);
        var start = new ProcessStartInfo(Path.GetFullPath(node)) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["CLOUDIG_FILE_MOVES_PIPE"] = broker.Endpoint;
        start.Environment["CLOUDIG_PORTABLE_FILE_IDENTITIES"] = "1";
        foreach (var argument in new[] { "--test", "tests/v1/records/native-file-move.test.mts", "tests/v1/records/record-store.test.mts", "tests/v1/records/record-file-operations.test.mts" }) start.ArgumentList.Add(argument);
        using var child = Process.Start(start) ?? throw new IOException("Cannot start native file-move checks.");
        var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync();
        Console.Write(await output); Console.Error.Write(await errors);
        if (child.ExitCode != 0) throw new Exception("Native no-replace storage regressions failed.");
        Console.WriteLine("PASS native no-replace file moves and real Engine record storage/export/recovery checks.");
    }
}
