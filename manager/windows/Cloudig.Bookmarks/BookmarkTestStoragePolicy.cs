namespace Cloudig.Bookmarks;

public static class BookmarkTestStoragePolicy
{
    public static string? ResolveDataRoot(string sourceDirectory, IReadOnlyList<string> arguments)
    {
        if (arguments.Count > 0)
        {
            if (arguments.Count != 2 || arguments[0] != "--data-root" || !Path.IsPathFullyQualified(arguments[1]))
                throw new ArgumentException("请用 --data-root 指定一个完整的采云数据目录。");
            return Path.GetFullPath(arguments[1]);
        }
        // Only the two exact repository-owned install entrypoints share the
        // already-established Cloudig-Test data root. A downloaded standalone
        // copy must ask for a folder, not guess a disk or fall back to AppData.
        var source = Path.GetFullPath(sourceDirectory).TrimEnd(Path.DirectorySeparatorChar);
        var project = Path.GetFullPath(Path.Combine(source, "..", "..", ".."));
        if (!File.Exists(Path.Combine(project, "启动当前采云测试版.cmd"))) return null;
        var known = new[] { Path.Combine(project, "bookmarklets", "candidate", "test"), Path.Combine(project, "manager", "installers", "bookmark-test") };
        return known.Any(value => value.Equals(source, StringComparison.OrdinalIgnoreCase))
            ? Path.GetFullPath(Path.Combine(project, "..", "Cloudig-Test")) : null;
    }
}
