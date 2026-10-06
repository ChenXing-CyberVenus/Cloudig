namespace Cloudig.Desktop.Core;

public sealed record CloudigProgramLayout(string Root, string App)
{
    public static CloudigProgramLayout Resolve(string executable, string assemblyDirectory)
    {
        var root = Path.GetDirectoryName(Path.GetFullPath(executable)) ?? throw new ArgumentException("The executable has no parent directory.");
        var app = Path.TrimEndingDirectorySeparator(Path.GetFullPath(assemblyDirectory));
        // Published apphost embeds app/Cloudig.dll. Ordinary bin/Debug launches
        // keep their existing one-directory development layout.
        if (!string.Equals(app, root, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(app, Path.Combine(root, "app"), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Cloudig program files must be beside the development EXE or inside the portable root's app directory.");
        return new CloudigProgramLayout(root, app);
    }
}
