using System.Security.Cryptography;

namespace Cloudig.Desktop.Core;

public sealed class CloudigStorageException(string path, Exception inner) : IOException(
    $"此位置的权限或文件系统不满足采云所需的文件操作：\n{path}\n\n请使用当前用户可写的位置，并检查磁盘空间。不会自动改存 AppData 或系统临时目录。", inner)
{
    public string TargetPath { get; } = path;
}

public static class PortableStorageBoundary
{
    public static void Verify(IEnumerable<string> roots)
    {
        foreach (var root in roots.Distinct(StringComparer.OrdinalIgnoreCase)) Verify(root);
    }

    public static void Verify(string root)
    {
        var target = Path.GetFullPath(root);
        var created = new Stack<string>();
        string? probe = null;
        try
        {
            var absent = new Stack<string>();
            for (var cursor = target; !Directory.Exists(cursor); cursor = Path.GetDirectoryName(cursor)!)
            {
                if (File.Exists(cursor) || Path.GetDirectoryName(cursor) is null) throw new IOException("Storage target is not a directory.");
                absent.Push(cursor);
            }
            foreach (var directory in absent) { Directory.CreateDirectory(directory); created.Push(directory); }
            if ((File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new IOException("Storage target is a reparse point.");
            probe = Path.Combine(target, $".cloudig-write-probe-{Convert.ToHexString(RandomNumberGenerator.GetBytes(16))}");
            Directory.CreateDirectory(probe);
            var first = Path.Combine(probe, "first");
            var replacement = Path.Combine(probe, "replacement");
            // These disposable bytes test permissions and rename semantics, not
            // power-loss durability. Dispose flushes the managed buffer before
            // read-back; forcing physical disk flushes here can stall startup.
            using (var file = new FileStream(first, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.WriteByte(1); }
            using (var file = new FileStream(replacement, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.WriteByte(2); }
            File.Move(replacement, first, true);
            if (File.ReadAllBytes(first) is not [2]) throw new IOException("Storage replacement verification failed.");
            var moved = Path.Combine(probe, "moved");
            NativeFileMoves.MoveNoReplace(first, moved);
            using (var file = new FileStream(first, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.WriteByte(3); }
            var refused = false;
            try { NativeFileMoves.MoveNoReplace(first, moved); }
            catch (System.ComponentModel.Win32Exception error) when (error.NativeErrorCode is 80 or 183) { refused = true; }
            if (!refused || File.ReadAllBytes(first) is not [3] || File.ReadAllBytes(moved) is not [2]) throw new IOException("Storage no-replace verification failed.");
            File.Delete(first); File.Delete(moved);
            Directory.Delete(probe);
            probe = null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or System.ComponentModel.Win32Exception)
        {
            throw new CloudigStorageException(target, error);
        }
        finally
        {
            if (probe is not null)
            {
                foreach (var leaf in new[] { "first", "replacement", "moved" })
                    try { File.Delete(Path.Combine(probe, leaf)); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                try { Directory.Delete(probe); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            foreach (var directory in created)
                try { Directory.Delete(directory); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
