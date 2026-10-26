namespace Cloudig.Desktop.Core;

/// <summary>Generated file bytes only; not another HTTP or local-file reader.</summary>
public static class WorkDownloadPolicy
{
    public static bool IsGenerated(string address)
    {
        if (address.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return address.IndexOf(',') > 4;
        return address.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)
            && Uri.TryCreate(address[5..], UriKind.Absolute, out var origin)
            && origin.Scheme == "https" && origin.Host == "cloudig-work.invalid"
            && origin.IsDefaultPort && origin.UserInfo.Length == 0
            && Guid.TryParse(origin.AbsolutePath.TrimStart('/'), out _);
    }

    public static string SuggestedName(string raw)
    {
        var name = Path.GetFileName(raw);
        name = string.Concat(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)).Trim().TrimEnd('.');
        return string.IsNullOrWhiteSpace(name) ? "work.bin" : name;
    }
}
