using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Cloudig.Bookmarks;

// Chromium's published UniquePosition wire format (M152). The byte ordering and
// run-length representation are protocol facts; this implementation is local.
internal static class ChromeUniquePosition
{
    private const int Limit = 10 * 1024 * 1024;
    internal static byte[] Read(byte[] proto)
    {
        var message = ChromeSyncMessage.Parse(proto);
        byte[] bytes;
        if (message.Bytes(4) is { } compressed) bytes = Expand(compressed);
        else if (message.Bytes(1) is { } plain) bytes = plain;
        else if (message.Bytes(2) is { } zipped && message.Number(3) is > 0 and <= Limit)
        {
            bytes = new byte[(int)message.Number(3)];
            using var inflater = new ZLibStream(new MemoryStream(zipped), CompressionMode.Decompress);
            inflater.ReadExactly(bytes);
            if (inflater.ReadByte() != -1) throw ChromeSyncMessage.Invalid("排序长度不一致");
        }
        else throw ChromeSyncMessage.Invalid("无法识别书签排序编码");
        if (bytes.Length is < 28 or > Limit || bytes[^1] == 0) throw ChromeSyncMessage.Invalid("无效书签排序值");
        return bytes;
    }
    internal static byte[] Create(byte[]? before, byte[]? after, string clientTagHash, byte[]? previous = null)
    {
        var suffix = Encoding.ASCII.GetBytes(Convert.ToBase64String(SHA1.HashData(Encoding.UTF8.GetBytes(clientTagHash))));
        var value = before is null ? after is null ? suffix : Before(after, suffix)
            : after is null ? After(before, suffix) : Between(before, after, suffix);
        if ((before is not null && Compare(before, value) >= 0) || (after is not null && Compare(value, after) >= 0))
            throw ChromeSyncMessage.Invalid("无法生成目标位置");
        var message = previous is null ? new ChromeSyncMessage() : ChromeSyncMessage.Parse(previous);
        message.Remove(1); message.Remove(2); message.Remove(3);
        message.SetBytes(4, Compress(value));
        return message.Encode();
    }
    internal static int Compare(byte[] a, byte[] b) => a.AsSpan().SequenceCompareTo(b);
    private static byte[] Before(byte[] reference, byte[] suffix)
    {
        var zeros = 0;
        while (zeros < reference.Length && reference[zeros] == 0) zeros++;
        if (zeros == reference.Length) throw ChromeSyncMessage.Invalid("排序值没有有效结尾");
        return [.. new byte[zeros], (byte)(reference[zeros] / 2), .. suffix];
    }
    private static byte[] After(byte[] reference, byte[] suffix)
    {
        var high = 0;
        while (high < reference.Length && reference[high] == 255) high++;
        var prefix = Enumerable.Repeat((byte)255, high).ToArray();
        return high == reference.Length ? [.. prefix, 255, .. suffix]
            : [.. prefix, (byte)(reference[high] + (256 - reference[high]) / 2), .. suffix];
    }
    private static byte[] Between(byte[] before, byte[] after, byte[] suffix)
    {
        if (Compare(before, after) >= 0) throw ChromeSyncMessage.Invalid("现有书签排序互相冲突");
        var shared = 0;
        while (shared < before.Length && shared < after.Length && before[shared] == after[shared]) shared++;
        if (shared == before.Length) return [.. before, .. Before(after[shared..], suffix)];
        var low = before[shared];
        var high = after[shared];
        return high - low > 1 ? [.. before[..shared], (byte)((low + high) / 2), .. suffix]
            : [.. before[..(shared + 1)], .. After(before[(shared + 1)..], suffix)];
    }
    internal static byte[] Compress(byte[] raw)
    {
        if (raw.Length > Limit) throw ChromeSyncMessage.Invalid("书签排序值过长");
        using var output = new MemoryStream();
        var offset = 0;
        var countBytes = new byte[4];
        while (offset < raw.Length)
        {
            if (offset + 4 <= raw.Length && raw.AsSpan(offset, 4).IndexOfAnyExcept(raw[offset]) < 0)
            {
                var end = offset + 4;
                while (end < raw.Length && raw[end] == raw[offset]) end++;
                var count = (uint)(end - offset);
                if (end < raw.Length && raw[end] > raw[offset]) count = uint.MaxValue - count;
                output.Write(raw, offset, 4);
                BinaryPrimitives.WriteUInt32BigEndian(countBytes, count);
                output.Write(countBytes);
                offset = end;
            }
            else
            {
                var count = Math.Min(8, raw.Length - offset);
                output.Write(raw, offset, count);
                offset += count;
            }
        }
        return output.ToArray();
    }
    private static byte[] Expand(byte[] encoded)
    {
        if (encoded.Length > Limit) throw ChromeSyncMessage.Invalid("书签排序值过长");
        using var output = new MemoryStream();
        var offset = 0;
        while (offset + 8 <= encoded.Length)
        {
            if (encoded.AsSpan(offset, 4).IndexOfAnyExcept(encoded[offset]) < 0)
            {
                var count = BinaryPrimitives.ReadUInt32BigEndian(encoded.AsSpan(offset + 4, 4));
                if ((count & 0x80000000) != 0) count = uint.MaxValue - count;
                if (count < 4 || output.Length + count > Limit) throw ChromeSyncMessage.Invalid("排序压缩记录长度不符");
                var run = new byte[(int)count];
                Array.Fill(run, encoded[offset]);
                output.Write(run);
            }
            else output.Write(encoded, offset, 8);
            offset += 8;
        }
        if (output.Length + encoded.Length - offset > Limit) throw ChromeSyncMessage.Invalid("书签排序值过长");
        output.Write(encoded, offset, encoded.Length - offset);
        return output.ToArray();
    }
}
