using System.Text;

namespace Cloudig.Bookmarks;

// A lossless wire editor for the few Chromium protobuf fields we own. Untouched
// fields retain their original bytes, including unknown fields and their order.
internal sealed class ChromeSyncMessage
{
    internal sealed record Field(int Number, int Wire, byte[] Raw, byte[] Data, ulong Value = 0);
    private readonly List<Field> _fields = [];
    internal IEnumerable<Field> Fields(int number) => _fields.Where(field => field.Number == number);
    internal bool Has(int number) => _fields.Any(field => field.Number == number);
    internal Field? One(int number)
    {
        var fields = Fields(number).ToArray();
        if (fields.Length > 1) throw Invalid("重复的同步字段");
        return fields.SingleOrDefault();
    }
    internal byte[]? Bytes(int number)
    {
        var field = One(number);
        if (field is null) return null;
        if (field.Wire != 2) throw Invalid("同步字段类型不符");
        return field.Data;
    }
    internal string? Text(int number) => Bytes(number) is { } value ? new UTF8Encoding(false, true).GetString(value) : null;
    internal long Number(int number, long fallback = 0)
    {
        var field = One(number);
        if (field is null) return fallback;
        if (field.Wire != 0) throw Invalid("同步字段类型不符");
        return unchecked((long)field.Value);
    }
    internal uint Fixed32(int number, uint fallback = 0)
    {
        var field = One(number);
        if (field is null) return fallback;
        if (field.Wire != 5) throw Invalid("同步字段类型不符");
        return System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(field.Data);
    }
    internal void SetNumber(int number, long value) => Replace(number, Integer(number, unchecked((ulong)value)));
    internal void SetText(int number, string value) => SetBytes(number, Encoding.UTF8.GetBytes(value));
    internal void SetBytes(int number, byte[] value) => Replace(number, Blob(number, value));
    internal void SetFixed32(int number, uint value)
    {
        var data = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(data, value);
        Replace(number, Make(number, 5, data));
    }
    internal void AddBytes(int number, byte[] value) => _fields.Add(Blob(number, value));
    internal void Remove(int number) => _fields.RemoveAll(field => field.Number == number);
    internal void ReplaceRaw(Field original, byte[] message) => _fields[_fields.IndexOf(original)] = Blob(original.Number, message);
    internal void RemoveRaw(Field original) => _fields.Remove(original);
    private void Replace(int number, Field replacement)
    {
        var existing = One(number);
        if (existing is null) _fields.Add(replacement);
        else _fields[_fields.IndexOf(existing)] = replacement;
    }
    internal byte[] Encode()
    {
        using var output = new MemoryStream();
        foreach (var field in _fields) output.Write(field.Raw);
        return output.ToArray();
    }
    internal static ChromeSyncMessage Parse(byte[] bytes)
    {
        var message = new ChromeSyncMessage();
        var offset = 0;
        while (offset < bytes.Length)
        {
            var start = offset;
            var key = Varint(bytes, ref offset);
            var number = checked((int)(key >> 3));
            var wire = (int)(key & 7);
            if (number is < 1 or > 536870911) throw Invalid("无效同步字段编号");
            ulong value = 0;
            var dataStart = offset;
            if (wire == 0) value = Varint(bytes, ref offset);
            else if (wire == 1) offset = End(bytes, offset, 8);
            else if (wire == 2)
            {
                var length = Varint(bytes, ref offset);
                if (length > int.MaxValue) throw Invalid("同步字段长度越界");
                dataStart = offset;
                offset = End(bytes, offset, (int)length);
            }
            else if (wire == 5) offset = End(bytes, offset, 4);
            else throw Invalid("尚不支持的同步字段编码，未改写书签");
            message._fields.Add(new Field(number, wire, bytes[start..offset], bytes[dataStart..offset], value));
        }
        return message;
    }
    private static int End(byte[] bytes, int offset, int length)
    {
        if (length > bytes.Length - offset) throw Invalid("同步记录不完整");
        return offset + length;
    }
    private static ulong Varint(byte[] bytes, ref int offset)
    {
        ulong value = 0;
        for (var index = 0; index < 10; index++)
        {
            if (offset >= bytes.Length) throw Invalid("同步整数不完整");
            var next = bytes[offset++];
            if (index == 9 && next > 1) throw Invalid("同步整数越界");
            value |= (ulong)(next & 127) << (index * 7);
            if (next < 128) return value;
        }
        throw Invalid("同步整数越界");
    }
    private static void WriteVarint(Stream stream, ulong value)
    {
        while (value >= 128) { stream.WriteByte((byte)(value | 128)); value >>= 7; }
        stream.WriteByte((byte)value);
    }
    private static Field Integer(int number, ulong value)
    {
        using var payload = new MemoryStream();
        WriteVarint(payload, value);
        return Make(number, 0, payload.ToArray(), value);
    }
    private static Field Blob(int number, byte[] data) => Make(number, 2, data);
    private static Field Make(int number, int wire, byte[] data, ulong value = 0)
    {
        using var stream = new MemoryStream();
        WriteVarint(stream, ((ulong)number << 3) | (uint)wire);
        if (wire == 2) WriteVarint(stream, (ulong)data.Length);
        stream.Write(data);
        return new Field(number, wire, stream.ToArray(), data, value);
    }
    internal static InvalidDataException Invalid(string reason) => new($"Chrome书签同步记录无法处理：{reason}。");
}
