namespace Cloudig.Desktop.Core;

public sealed record CloudigDataRoots(
    string LibraryRoot,
    string DeviceRoot,
    string CacheRoot,
    bool LibraryArgumentExplicit);

public static class CloudigDataRootPolicy
{
    public static CloudigDataRoots Resolve(
        string applicationRoot,
        string? dataRootArgument = null,
        string? libraryRootArgument = null,
        string? visualAuditOutput = null)
    {
        var applicationRootFull = NormalizeRequired(applicationRoot, nameof(applicationRoot));
        var dataRootFull = NormalizeOptional(dataRootArgument, nameof(dataRootArgument));
        var libraryRootFull = NormalizeOptional(libraryRootArgument, nameof(libraryRootArgument));
        _ = NormalizeOptional(visualAuditOutput, nameof(visualAuditOutput));
        if (dataRootFull is not null && libraryRootFull is not null && !dataRootFull.Equals(libraryRootFull, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A Cloudig session cannot split Library and device data across two roots.");
        var libraryRoot = libraryRootFull ?? dataRootFull ?? applicationRootFull;
        var deviceRoot = Path.Combine(libraryRoot, "appdata");

        return new CloudigDataRoots(
            Path.GetFullPath(libraryRoot),
            Path.GetFullPath(deviceRoot),
            Path.Combine(libraryRoot, "cache"),
            libraryRootFull is not null || dataRootFull is not null);
    }

    private static string NormalizeRequired(string value, string parameter)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException("Path cannot be empty.", parameter);
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
    }

    private static string? NormalizeOptional(string? value, string parameter)
    {
        if (value is null) return null;
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException("Path cannot be empty.", parameter);
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
    }
}
