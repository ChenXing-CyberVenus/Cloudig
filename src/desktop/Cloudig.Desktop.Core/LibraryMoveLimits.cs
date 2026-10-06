using System.Text.Json;

namespace Cloudig.Desktop.Core;

public static class LibraryMoveLimits
{
    private static readonly JsonElement Values = Load();
    private static JsonElement Load()
    {
        using var stream = typeof(LibraryMoveLimits).Assembly.GetManifestResourceStream("Cloudig.MoveLimits.json") ?? throw new InvalidOperationException("Move limits are missing.");
        using var document = JsonDocument.Parse(stream);
        if (document.RootElement.GetProperty("schema").GetString() != "cloudig/move-limits/1.0.0") throw new InvalidDataException("Move limits are unsupported.");
        return document.RootElement.Clone();
    }
    public static int MaximumFiles => Values.GetProperty("maximum_files").GetInt32();
    public static int BufferBytes => Values.GetProperty("copy_buffer_bytes").GetInt32();
    public static long MinimumReserveBytes => Values.GetProperty("minimum_reserve_bytes").GetInt64();
    public static int ReserveDivisor => Values.GetProperty("reserve_divisor").GetInt32();
    public static int OwnerExitTimeoutSeconds => Values.GetProperty("owner_exit_timeout_seconds").GetInt32();
    public static int OwnerExitPollMilliseconds => Values.GetProperty("owner_exit_poll_milliseconds").GetInt32();
}
