using Cloudig.Desktop.Core;
using System.Diagnostics;

internal static class LibraryInstanceChecks
{
    public static async Task RunAsync()
    {
        var root = Path.GetFullPath("tests/private/instance-" + Guid.NewGuid().ToString("N"));
        var requests = 0;
        var owner = await LibraryInstance.AcquireOrActivateAsync(root, () => Interlocked.Increment(ref requests))
            ?? throw new Exception("First launch did not own the Library.");
        try
        {
            if (Directory.Exists(root)) throw new Exception("Instance acquisition created Library data.");
            var peers = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => LibraryInstance.AcquireOrActivateAsync(root.ToUpperInvariant() + Path.DirectorySeparatorChar, () => throw new Exception("A peer became owner."))));
            if (peers.Any(peer => peer is not null) || requests != 12) throw new Exception("Concurrent startup created a duplicate or lost activation.");
            using var other = await LibraryInstance.AcquireOrActivateAsync(root + "-other", () => { });
            if (other is null) throw new Exception("Different Libraries incorrectly share a desktop lock.");
        }
        finally { owner.Dispose(); }
        using var restarted = await LibraryInstance.AcquireOrActivateAsync(root, () => { });
        if (restarted is null) throw new Exception("An exited desktop left a stale Library lock.");
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "dotnet", StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(typeof(LibraryInstanceChecks).Assembly.Location);
        start.ArgumentList.Add("--library-instance-worker"); start.ArgumentList.Add(root + "-process");
        using var child = Process.Start(start) ?? throw new IOException("Cannot start independent instance test.");
        try
        {
            if (await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) != "owned") throw new Exception("Independent owner did not start.");
            var observedPid = 0;
            if (await LibraryInstance.AcquireOrActivateAsync(root + "-process", () => { }, pid => observedPid = pid) is not null || observedPid != child.Id) throw new Exception("Independent launch did not notify the existing PID.");
            // This is only our child test process; abrupt exit must retire its kernel lease.
            child.Kill(); await child.WaitForExitAsync();
            using var recovered = await LibraryInstance.AcquireOrActivateAsync(root + "-process", () => { });
            if (recovered is null) throw new Exception("A crashed process stranded the Library lease.");
        }
        finally { if (!child.HasExited) { child.Kill(); await child.WaitForExitAsync(); } }
        Console.WriteLine("PASS Library instance: 12 simultaneous activations, normalized root, independent Libraries, independent process/PID, crash/restart, no filesystem writes.");
    }

    public static async Task WorkerAsync(string root)
    {
        using var owner = await LibraryInstance.AcquireOrActivateAsync(root, () => { }) ?? throw new Exception("Worker did not acquire its own root.");
        Console.WriteLine("owned"); await Console.In.ReadLineAsync();
    }
}
