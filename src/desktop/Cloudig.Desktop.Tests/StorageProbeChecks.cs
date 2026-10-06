using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using Cloudig.Desktop.Core;

internal static class StorageProbeChecks
{
    public static void Run()
    {
        var root = Path.GetFullPath(Path.Combine("tests", "private", "storage-probe-" + Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(root);
        var timer = Stopwatch.StartNew();
        try
        {
            var absent = Path.Combine(root, "new", "nested");
            PortableStorageBoundary.Verify(absent);
            if (Directory.Exists(Path.Combine(root, "new"))) throw new Exception("Probe left newly created ancestors.");
            var existing = Path.Combine(root, "existing"); Directory.CreateDirectory(existing);
            var original = Path.Combine(existing, "original.txt"); File.WriteAllText(original, "user data");
            PortableStorageBoundary.Verify(new[] { existing, existing.ToUpperInvariant() });
            if (File.ReadAllText(original) != "user data" || Directory.GetFileSystemEntries(existing).Length != 1)
                throw new Exception("Probe changed existing data or left residue.");
            try { PortableStorageBoundary.Verify(original); throw new Exception("File-as-directory was accepted."); }
            catch (CloudigStorageException) { }
            var denied = new DirectoryInfo(Path.Combine(root, "denied")); denied.Create();
            var before = denied.GetAccessControl(); var blocked = denied.GetAccessControl();
            blocked.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.CreateFiles | FileSystemRights.CreateDirectories, AccessControlType.Deny));
            try
            {
                denied.SetAccessControl(blocked);
                try { PortableStorageBoundary.Verify(denied.FullName); throw new Exception("Denied directory was accepted."); }
                catch (CloudigStorageException) { }
            }
            finally { denied.SetAccessControl(before); }
            Console.WriteLine($"PASS storage probes: create/read/replace/no-replace/delete, absent ancestors, existing data, file target, denied ACL; elapsed_ms={timer.ElapsedMilliseconds}");
        }
        finally
        {
            // Exact uniquely-created test root; no user Library is reachable.
            Directory.Delete(root, true);
        }
    }
}
