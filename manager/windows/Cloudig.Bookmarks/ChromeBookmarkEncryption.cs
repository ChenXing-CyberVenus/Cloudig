using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace Cloudig.Bookmarks;

// Chromium's Windows DPAPI provider: v10 + 12-byte nonce + AES-256-GCM + 16-byte tag.
// Only the selected bookmark store is decrypted. Keys never leave process memory.
internal sealed class ChromeBookmarkEncryption : IDisposable
{
    private readonly byte[] _key;
    internal ChromeBookmarkEncryption(byte[] key)
    {
        if (key.Length != 32) throw new CryptographicException("Chrome书签加密密钥长度无效，未写入。");
        _key = key.ToArray();
    }

    internal static string? CompanionPath(string path) => Path.GetFileName(path) switch
    {
        "Bookmarks" => Path.Combine(Path.GetDirectoryName(path)!, "EncryptedBookmarks2"),
        "AccountBookmarks" or "Bookmarks Account" => Path.Combine(Path.GetDirectoryName(path)!, "EncryptedAccountBookmarks2"),
        _ => null
    };

    internal static bool IsEncryptedStore(string path) => Path.GetFileName(path) is "EncryptedBookmarks2" or "EncryptedAccountBookmarks2";

    internal static ChromeBookmarkEncryption Open(string bookmarkPath)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Chrome加密书签须由原Windows用户更新。");
        var profile = Path.GetDirectoryName(Path.GetFullPath(bookmarkPath))!;
        var localState = Path.Combine(Directory.GetParent(profile)!.FullName, "Local State");
        using var state = JsonDocument.Parse(ChromeProfileDiscovery.ReadAllBytesShared(localState));
        var wrapped = Convert.FromBase64String(state.RootElement.GetProperty("os_crypt").GetProperty("encrypted_key").GetString()!);
        if (!wrapped.AsSpan().StartsWith("DPAPI"u8)) throw new CryptographicException("尚不支持此Chrome书签密钥格式，未写入。");
        var key = Unprotect(wrapped[5..]);
        try { return new ChromeBookmarkEncryption(key); }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    internal byte[] Decrypt(byte[] bytes)
    {
        if (bytes.Length < 31 || !bytes.AsSpan().StartsWith("v10"u8))
            throw new CryptographicException("尚不支持此Chrome加密书签格式，未写入；不会删除或降级加密库。");
        var clear = new byte[bytes.Length - 31];
        using var aes = new AesGcm(_key, 16);
        aes.Decrypt(bytes.AsSpan(3, 12), bytes.AsSpan(15, clear.Length), bytes.AsSpan(bytes.Length - 16), clear);
        return clear;
    }

    internal byte[] Encrypt(byte[] clear)
    {
        var bytes = new byte[clear.Length + 31];
        "v10"u8.CopyTo(bytes);
        RandomNumberGenerator.Fill(bytes.AsSpan(3, 12));
        using var aes = new AesGcm(_key, 16);
        aes.Encrypt(bytes.AsSpan(3, 12), clear, bytes.AsSpan(15, clear.Length), bytes.AsSpan(bytes.Length - 16));
        return bytes;
    }

    public void Dispose() => CryptographicOperations.ZeroMemory(_key);

    private static byte[] Unprotect(byte[] encrypted)
    {
        var input = new DataBlob { Length = encrypted.Length, Data = Marshal.AllocHGlobal(encrypted.Length) };
        DataBlob output = default;
        try
        {
            Marshal.Copy(encrypted, 0, input.Data, encrypted.Length);
            // Standard current-user DPAPI; no elevation, impersonation or app-bound bypass.
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "当前Windows用户无法解开Chrome书签密钥，未写入。");
            var key = new byte[output.Length];
            Marshal.Copy(output.Data, key, 0, key.Length);
            return key;
        }
        finally
        {
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != IntPtr.Zero)
            {
                for (var i = 0; i < output.Length; i++) Marshal.WriteByte(output.Data, i, 0);
                LocalFree(output.Data);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
