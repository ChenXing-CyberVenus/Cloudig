using Cloudig.Desktop.Core;

internal static class WorkDownloadChecks
{
    public static void Run()
    {
        foreach (var url in new[] { "blob:https://cloudig-work.invalid/08b6f3d5-606b-4bc9-a560-73f8835c965e", "data:application/pdf;base64,JVBERi0=", "data:text/plain;charset=utf-8,hello" })
            if (!WorkDownloadPolicy.IsGenerated(url)) throw new Exception("Generated work file denied");
        foreach (var url in new[] { "https://cloudig-work.invalid/file", "file:///C:/private.txt", "blob:https://cloudig.local/08b6f3d5-606b-4bc9-a560-73f8835c965e", "blob:https://cloudig-work.invalid.evil.test/08b6f3d5-606b-4bc9-a560-73f8835c965e", "blob:https://user@cloudig-work.invalid/08b6f3d5-606b-4bc9-a560-73f8835c965e", "blob:null/id", "data:invalid" })
            if (WorkDownloadPolicy.IsGenerated(url)) throw new Exception("Non-generated/foreign file accepted");
        if (WorkDownloadPolicy.SuggestedName(@"C:\Downloads\作品.json") != "作品.json" || WorkDownloadPolicy.SuggestedName("  ") != "work.bin") throw new Exception("Invalid download leaf");
        Console.WriteLine("PASS generated work download policy: Blob/data, foreign/remote/file denial, filename");
    }
}
