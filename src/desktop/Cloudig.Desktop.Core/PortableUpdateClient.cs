using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace Cloudig.Desktop.Core;

public sealed record PreparedUpdate(string Capability, string RequestFile, string RequestSha256, string Version);
public sealed record PortableUpdateRequest(string Schema, string ProgramRoot, string LibraryRoot, string Installer, long Bytes, string Sha256, string Version, int OwnerPid, string OwnerStarted, string PublisherThumbprint);

public sealed class PortableUpdateClient(HttpClient? http = null)
{
    // Current owner-approved signing identity, verified from the signed 1.0.1
    // release. A certificate change must be explicitly added in a release.
    public const string PublisherThumbprint = "0742580B8EA12653FE3A1E906613268467BAD80A";
    public const int OwnerExitSeconds = 90;
    public const int SignatureTimeoutSeconds = 45;
    public const int MaximumRequestBytes = 16 * 1024;
    private readonly VerifiedDownloadClient _downloads = new(http);

    internal static ProcessStartInfo PowerShell(string command) {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
        start.Environment["PSModuleAnalysisCachePath"] = "NUL";
        // A PowerShell 7 parent can export its incompatible core modules. Use
        // the Windows helper's own OS modules, independent of the caller shell.
        start.Environment["PSModulePath"] = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "Modules");
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(command)) }) start.ArgumentList.Add(arg);
        return start;
    }
    private static string Quote(string value) => "'" + value.Replace("'", "''") + "'";
    public static async Task VerifySignatureAsync(string file, string thumbprint, CancellationToken token) {
        VerifiedDownloadClient.PlainPath(file);
        var command = "$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath " + Quote(file) + ";if($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.Thumbprint -ne " + Quote(thumbprint) + "){[Console]::Error.WriteLine($s.Status.ToString()+': '+$s.StatusMessage);exit 3};exit 0";
        var start = PowerShell(command); start.RedirectStandardError = true; start.RedirectStandardOutput = true;
        using var process = Process.Start(start) ?? throw new IOException("Signature verification could not start.");
        var errors = process.StandardError.ReadToEndAsync();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(SignatureTimeoutSeconds));
        try { await process.WaitForExitAsync(timeout.Token); if (process.ExitCode != 0) throw new InvalidDataException("The update's publisher or signature is not trusted: " + (await errors).Trim()); }
        catch (OperationCanceledException) { if (!process.HasExited) process.Kill(); throw; }
    }
    public async Task<PreparedUpdate> PrepareAsync(ReleaseInstaller release, string programRoot, string libraryRoot, Action<DownloadProgress>? progress, CancellationToken token) {
        programRoot = Path.GetFullPath(programRoot); libraryRoot = Path.GetFullPath(libraryRoot); VerifiedDownloadClient.PlainPath(programRoot); VerifiedDownloadClient.PlainPath(libraryRoot);
        if (!File.Exists(Path.Combine(programRoot, "Cloudig.exe"))) throw new IOException("The current portable program root is unavailable.");
        var folder = Path.Combine(libraryRoot, "cache", "Update"); VerifiedDownloadClient.PlainPath(folder); Directory.CreateDirectory(folder);
        var requestFile = Path.Combine(folder, "request.json");
        if (File.Exists(requestFile)) RetireAbandonedPreparation(requestFile, programRoot, libraryRoot);
        // One owned download per session; cancellation/failure removes this
        // attempt, while a committed installer remains available for recovery.
        var filename = "Cloudig-Update.exe"; var saved = await _downloads.SaveAsync(new Uri(release.Url), release.Bytes, release.Sha256, folder, filename, progress, token);
        var requestCreated = false;
        try {
            await VerifySignatureAsync(saved.Path, PublisherThumbprint, token);
            using var owner = Process.GetCurrentProcess();
            var request = new PortableUpdateRequest("cloudig/portable-update/1.0.0", programRoot, libraryRoot, saved.Path, release.Bytes, release.Sha256, release.Version, owner.Id, owner.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture), PublisherThumbprint);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
            await using (var stream = new FileStream(requestFile, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { requestCreated = true; await stream.WriteAsync(bytes, token); stream.Flush(true); }
            token.ThrowIfCancellationRequested();
            return new(Guid.NewGuid().ToString("N"), requestFile, Convert.ToHexString(SHA256.HashData(bytes)), release.Version);
        } catch { if (requestCreated && File.Exists(requestFile)) File.Delete(requestFile); if (!saved.Existing && File.Exists(saved.Path)) File.Delete(saved.Path); throw; }
    }
    private static void RetireAbandonedPreparation(string file, string programRoot, string libraryRoot) {
        VerifiedDownloadClient.PlainPath(file);
        PortableUpdateRequest old;
        // A running helper holds this request open: never retire its installer.
        using (var lease = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None)) {
            if (lease.Length > MaximumRequestBytes) throw new InvalidDataException("Unknown pending update was preserved.");
            old = JsonSerializer.Deserialize<PortableUpdateRequest>(lease) ?? throw new InvalidDataException("Invalid pending update.");
            if (old.Schema != "cloudig/portable-update/1.0.0" || !Path.GetFullPath(old.ProgramRoot).Equals(programRoot,StringComparison.OrdinalIgnoreCase) || !Path.GetFullPath(old.LibraryRoot).Equals(libraryRoot,StringComparison.OrdinalIgnoreCase)
                || old.Installer != Path.Combine(Path.GetDirectoryName(file)!,"Cloudig-Update.exe")) throw new IOException("This pending update belongs to another root.");
            try { using var owner = Process.GetProcessById(old.OwnerPid); if (old.OwnerPid != Environment.ProcessId && !owner.HasExited && owner.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) == old.OwnerStarted) throw new IOException("Another Cloudig is preparing this update."); } catch(ArgumentException) { }
            VerifiedDownloadClient.PlainPath(old.Installer);
            if (File.Exists(old.Installer)) {
                using var installer = new FileStream(old.Installer,FileMode.Open,FileAccess.Read,FileShare.None);
                if (installer.Length != old.Bytes || !Convert.ToHexString(SHA256.HashData(installer)).Equals(old.Sha256,StringComparison.OrdinalIgnoreCase)) throw new IOException("Changed pending update bytes were preserved.");
            }
        }
        if (File.Exists(old.Installer)) File.Delete(old.Installer); File.Delete(file);
        var log = Path.Combine(Path.GetDirectoryName(file)!,"install.log"); if (File.Exists(log)) { VerifiedDownloadClient.PlainPath(log); File.Delete(log); }
    }
    public static void Discard(PreparedUpdate prepared) {
        VerifiedDownloadClient.PlainPath(prepared.RequestFile);
        if (!File.Exists(prepared.RequestFile)) return;
        var bytes = File.ReadAllBytes(prepared.RequestFile);
        if (Convert.ToHexString(SHA256.HashData(bytes)) != prepared.RequestSha256) throw new IOException("The prepared update changed and was preserved.");
        var request = JsonSerializer.Deserialize<PortableUpdateRequest>(bytes) ?? throw new InvalidDataException("Invalid update request.");
        var expected = Path.Combine(Path.GetFullPath(request.LibraryRoot), "cache", "Update");
        if (prepared.RequestFile != Path.Combine(expected, "request.json") || request.Installer != Path.Combine(expected, "Cloudig-Update.exe") || request.OwnerPid != Environment.ProcessId) throw new IOException("The prepared update belongs to another owner.");
        VerifiedDownloadClient.PlainPath(request.Installer); if (File.Exists(request.Installer)) File.Delete(request.Installer); File.Delete(prepared.RequestFile);
        if (!Directory.EnumerateFileSystemEntries(expected).Any()) Directory.Delete(expected);
    }
    public static ProcessStartInfo HelperStartInfo(PreparedUpdate prepared) {
        using var stream = typeof(PortableUpdateClient).Assembly.GetManifestResourceStream("Cloudig.PortableUpdate.ps1") ?? throw new IOException("The update helper is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return PowerShell("& {\n" + reader.ReadToEnd() + "\n} -RequestFile " + Quote(prepared.RequestFile) + " -ExpectedHash " + Quote(prepared.RequestSha256) + " -OwnerExitSeconds " + OwnerExitSeconds);
    }
}
