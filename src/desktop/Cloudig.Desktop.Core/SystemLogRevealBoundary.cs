namespace Cloudig.Desktop.Core;

public sealed class SystemLogRevealException : Exception
{
    public string Code { get; }

    public SystemLogRevealException(string code, string message, Exception? inner = null) : base(message, inner)
    {
        Code = code;
    }
}

public static class SystemLogRevealBoundary
{
    public static string ResolveExistingFile(string libraryRoot, string managedPath)
    {
        try
        {
            var root = Path.GetFullPath(libraryRoot);
            if (!Directory.Exists(root)) throw Missing();
            RejectReparse(root, directory: true);
            if (managedPath.Length is 0 or > 1024 || Path.IsPathFullyQualified(managedPath) || managedPath.Contains('\\') || managedPath.Contains('\0'))
            {
                throw Invalid();
            }
            var segments = managedPath.Split('/', StringSplitOptions.None);
            var inInbox = segments.Length == 2 && segments[0] == "Inbox";
            var inConversations = segments.Length is 2 or 3 && segments[0] == "Conversations";
            if ((!inInbox && !inConversations) || segments.Any(segment => string.IsNullOrEmpty(segment) || segment is "." or "..")) throw Invalid();

            var current = root;
            for (var index = 0; index < segments.Length - 1; index++)
            {
                current = Path.Combine(current, segments[index]);
                if (!Directory.Exists(current)) throw Missing();
                RejectReparse(current, directory: true);
            }
            var target = Path.GetFullPath(Path.Combine(root, Path.Combine(segments)));
            var relative = Path.GetRelativePath(root, target);
            if (relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathFullyQualified(relative)) throw Invalid();
            if (!File.Exists(target)) throw Missing();
            RejectReparse(target, directory: false);
            return target;
        }
        catch (SystemLogRevealException)
        {
            throw;
        }
        catch (FileNotFoundException error)
        {
            throw Missing(error);
        }
        catch (DirectoryNotFoundException error)
        {
            throw Missing(error);
        }
        catch (UnauthorizedAccessException error)
        {
            throw new SystemLogRevealException("CLOUDIG_SYSTEM_LOG_FILE_UNAVAILABLE", "Cloudig cannot access the recorded file.", error);
        }
        catch (IOException error)
        {
            throw new SystemLogRevealException("CLOUDIG_SYSTEM_LOG_FILE_UNAVAILABLE", "Cloudig cannot locate the recorded file.", error);
        }
    }

    private static void RejectReparse(string path, bool directory)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw Invalid();
        if (directory && (attributes & FileAttributes.Directory) == 0) throw Invalid();
        if (!directory && (attributes & FileAttributes.Directory) != 0) throw Invalid();
    }

    private static SystemLogRevealException Missing(Exception? inner = null) =>
        new("CLOUDIG_SYSTEM_LOG_FILE_MISSING", "The recorded file does not exist or was moved.", inner);

    private static SystemLogRevealException Invalid() =>
        new("CLOUDIG_SYSTEM_LOG_FILE_INVALID", "The System Log file reference is outside the Library boundary.");
}
