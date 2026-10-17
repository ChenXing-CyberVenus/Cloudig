using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;

namespace Cloudig.Desktop.Core;

public sealed record SourcePickerResult(string Picker, string Filename, long Bytes, string Sha256);

public static partial class SourcePickerBoundary
{
    private const int BufferBytes = 1024 * 1024;
    public const int CompanionManifestBytes = 4 * 1024 * 1024;
    public const int CompanionFiles = 10000;
    public const int CompanionKeyCharacters = 1024;

    [GeneratedRegex("^p_[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex PickerToken();

    [GeneratedRegex("[<>:\"/\\\\|?*\\x00-\\x1f]", RegexOptions.CultureInvariant)]
    private static partial Regex InvalidLeafCharacter();

    public static string CreateToken()
    {
        var value = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
        return $"p_{value}";
    }

    public static async Task<SourcePickerResult> StageAsync(
        string runtimeRoot,
        string selectedPath,
        string picker,
        CancellationToken cancellationToken = default,
        Action<long, long>? onProgress = null)
    {
        if (!PickerToken().IsMatch(picker)) throw new InvalidDataException("Source picker token is invalid.");
        var sourcePath = Path.GetFullPath(selectedPath);
        var source = new FileInfo(sourcePath);
        if (!source.Exists || (source.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
        {
            throw new InvalidDataException("Selected source must be an ordinary file.");
        }
        var filename = ValidateLeaf(source.Name);
        // Preserve original facts. The Engine owns capture-time selection and its validity policy.
        var createdAt = source.CreationTimeUtc.ToString("O");
        var modifiedAt = source.LastWriteTimeUtc.ToString("O");
        if (!Directory.Exists(runtimeRoot)) throw new InvalidDataException("Owned runtime cache is unavailable.");
        var pickerRoot = ResolvePickerRoot(runtimeRoot, picker);
        Directory.CreateDirectory(Path.GetDirectoryName(pickerRoot)!);
        if (Directory.Exists(pickerRoot)) throw new IOException("Source picker token is already in use.");
        Directory.CreateDirectory(pickerRoot);
        var payloadPath = Path.Combine(pickerRoot, "payload.bin");
        var manifestPath = Path.Combine(pickerRoot, "manifest.json");
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using var input = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
            await using var output = new FileStream(payloadPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var total = input.Length;
            var completed = 0L;
            var buffer = new byte[BufferBytes];
            while (true)
            {
                var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken);
                if (read == 0) break;
                hash.AppendData(buffer, 0, read);
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                completed += read;
                onProgress?.Invoke(completed, total);
            }
            if (completed != total) throw new IOException("Selected source length changed while staging.");
            await output.FlushAsync(cancellationToken);
            output.Flush(true);
            var sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            var manifest = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schema = "cloudig/picker/1.0.0",
                picker,
                filename,
                bytes = completed,
                sha256,
                created_at = createdAt,
                modified_at = modifiedAt
            });
            await using var manifestFile = new FileStream(manifestPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16 * 1024, FileOptions.Asynchronous);
            await manifestFile.WriteAsync(manifest, cancellationToken);
            await manifestFile.FlushAsync(cancellationToken);
            manifestFile.Flush(true);
            return new SourcePickerResult(picker, filename, completed, sha256);
        }
        catch
        {
            RemoveOwned(runtimeRoot, picker);
            throw;
        }
    }

    public static async Task StageCompanionsAsync(string runtimeRoot, string selectedPath, string picker, CancellationToken cancellationToken = default, Action<int, int>? onProgress = null)
    {
        var pickerRoot = ResolvePickerRoot(runtimeRoot, picker);
        var planPath = Path.Combine(pickerRoot, "assets-plan.json");
        RejectReparse(runtimeRoot, planPath);
        if (new FileInfo(planPath).Length > CompanionManifestBytes) throw new InvalidDataException("Companion plan exceeds its limit.");
        using var plan = JsonDocument.Parse(await File.ReadAllBytesAsync(planPath, cancellationToken));
        var root = plan.RootElement;
        if (root.GetProperty("schema").GetString() != "cloudig/picker-assets-plan/1.0.0") throw new InvalidDataException("Invalid companion plan.");
        var platform = root.GetProperty("platform").GetString();
        if (platform is not ("grok" or "mistral")) throw new InvalidDataException("Invalid companion platform.");
        var keys = root.GetProperty("keys").EnumerateArray().Select(v => v.GetString()!).ToArray();
        if (keys.Length > CompanionFiles || keys.Distinct(StringComparer.Ordinal).Count() != keys.Length) throw new InvalidDataException("Invalid companion selection.");
        var exportRoot = Path.GetDirectoryName(Path.GetFullPath(selectedPath))!;
        var items = new List<object>();
        var visited = 0; onProgress?.Invoke(visited, keys.Length);
        foreach (var key in keys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrEmpty(key) || key.Length > CompanionKeyCharacters) throw new InvalidDataException("Invalid companion key.");
            string sourcePath;
            if (platform == "grok")
            {
                if (!Guid.TryParseExact(key, "D", out _)) throw new InvalidDataException("Invalid Grok attachment ID.");
                sourcePath = Path.Combine(exportRoot, "prod-mc-asset-server", key, "content");
            }
            else sourcePath = Path.Combine(exportRoot, Path.GetFileNameWithoutExtension(selectedPath) + "-files", ValidateLeaf(key));
            RejectReparse(exportRoot, sourcePath);
            if (!File.Exists(sourcePath)) { onProgress?.Invoke(++visited, keys.Length); continue; }
            var leaf = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(platform + "\0" + key))).ToLowerInvariant() + ".bin";
            var target = Path.Combine(pickerRoot, leaf); RejectReparse(runtimeRoot, target);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
            await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var buffer = new byte[BufferBytes]; long bytes = 0;
            while (true) { var read = await source.ReadAsync(buffer, cancellationToken); if (read == 0) break; hash.AppendData(buffer, 0, read); await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken); bytes += read; }
            if (bytes != source.Length) throw new IOException("Companion changed while staging.");
            await output.FlushAsync(cancellationToken); output.Flush(true);
            items.Add(new { key, leaf, bytes, sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() });
            onProgress?.Invoke(++visited, keys.Length);
        }
        var encoded = JsonSerializer.SerializeToUtf8Bytes(new { schema = "cloudig/picker-assets/1.0.0", platform, source_sha256 = root.GetProperty("source_sha256").GetString(), items });
        if (encoded.Length > CompanionManifestBytes) throw new InvalidDataException("Companion manifest exceeds its limit.");
        await using var manifest = new FileStream(Path.Combine(pickerRoot, "assets.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None);
        await manifest.WriteAsync(encoded, cancellationToken); manifest.Flush(true);
    }

    public static void RemoveOwned(string runtimeRoot, string picker)
    {
        if (!PickerToken().IsMatch(picker)) return;
        var pickerRoot = ResolvePickerRoot(runtimeRoot, picker);
        var assets = Directory.Exists(pickerRoot) ? Directory.EnumerateFiles(pickerRoot).Select(Path.GetFileName).Where(leaf => leaf is not null && Regex.IsMatch(leaf, "^[a-f0-9]{64}\\.bin$", RegexOptions.CultureInvariant)).Select(leaf => leaf!).ToArray() : [];
        foreach (var leaf in new[] { "payload.bin", "manifest.json", "assets-plan.json", "assets.json" }.Concat(assets))
        {
            var target = Path.Combine(pickerRoot, leaf);
            RejectReparse(runtimeRoot, target);
            if (File.Exists(target)) File.Delete(target);
        }
        if (Directory.Exists(pickerRoot) && !Directory.EnumerateFileSystemEntries(pickerRoot).Any()) Directory.Delete(pickerRoot, false);
    }

    private static string ResolvePickerRoot(string runtimeRoot, string picker)
    {
        if (!Path.IsPathFullyQualified(runtimeRoot)) throw new InvalidDataException("Owned runtime cache must be an absolute path.");
        var root = Path.GetFullPath(runtimeRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(Path.Combine(root, "Pickers", picker));
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Source picker escaped its cache session.");
        RejectReparse(root, target);
        return target;
    }

    private static void RejectReparse(string runtimeRoot, string target)
    {
        var current = Path.GetFullPath(runtimeRoot).TrimEnd(Path.DirectorySeparatorChar);
        Check(current);
        foreach (var segment in Path.GetRelativePath(current, target).Split(Path.DirectorySeparatorChar)) { current = Path.Combine(current, segment); Check(current); }
        static void Check(string value)
        {
            try { if ((File.GetAttributes(value) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Picker paths cannot cross reparse points."); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    private static string ValidateLeaf(string value)
    {
        if (value.Length is < 1 or > 240 || InvalidLeafCharacter().IsMatch(value) || value.EndsWith(' ') || value.EndsWith('.'))
        {
            throw new InvalidDataException("Selected filename is not supported.");
        }
        return value;
    }
}
