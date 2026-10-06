using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static class BookmarkSyncBrowserProbe
{
    internal static async Task Run(string chrome)
    {
        var project=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"../../../../../.."));
        if(!File.Exists(Path.Combine(project,"AGENTS.md"))||!File.Exists(chrome))throw new InvalidOperationException("Invalid isolated test inputs");
        var scope=Path.Combine(project,"manager",".test-temp","bookmark-sync-chrome-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scope);
        var results=new List<object>();
        try
        {
            foreach(var (corrected,restart) in new[]{(false,false),(true,false),(true,true)})
            {
                var profile=Path.Combine(scope,corrected?"corrected":"old-array-only");
                var bookmark=Path.Combine(profile,"Default","Bookmarks");
                Directory.CreateDirectory(Path.GetDirectoryName(bookmark)!);
                Directory.CreateDirectory(Path.Combine(profile,"temp"));
                if(!restart)await File.WriteAllTextAsync(bookmark,BookmarkSyncTests.BrowserFixture(corrected),new UTF8Encoding(false));
                var before=await File.ReadAllBytesAsync(bookmark);
                var original=JsonNode.Parse(before)!.AsObject();
                var start=new ProcessStartInfo(chrome){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
                foreach(var argument in new[]{"--headless=new","--allow-chrome-scheme-url","--dump-dom","--no-first-run","--no-default-browser-check",
                    "--disable-background-networking","--disable-component-update","--disable-extensions","--disable-crash-reporter",
                    "--user-data-dir="+profile,"--disk-cache-dir="+Path.Combine(profile,"cache"),"--crash-dumps-dir="+Path.Combine(profile,"crashes"),
                    "--timeout=10000","--virtual-time-budget=6000","chrome://histograms/Sync.BookmarksModelMetadataCorruptionReason"})start.ArgumentList.Add(argument);
                start.Environment["TEMP"]=Path.Combine(profile,"temp");start.Environment["TMP"]=Path.Combine(profile,"temp");
                using var process=Process.Start(start)??throw new InvalidOperationException("Chrome failed to start");
                var outputTask=process.StandardOutput.ReadToEndAsync();var errorTask=process.StandardError.ReadToEndAsync();
                try{await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(25));}
                finally{if(!process.HasExited){process.Kill(entireProcessTree:true);await process.WaitForExitAsync();}}
                var output=await outputTask;var error=await errorTask;
                var after=JsonNode.Parse(await File.ReadAllTextAsync(bookmark))!.AsObject();
                var originalChildren=original["roots"]!["bookmark_bar"]!["children"]!.AsArray();
                var afterChildren=after["roots"]!["bookmark_bar"]!["children"]!.AsArray();
                if(process.ExitCode!=0||!originalChildren.Select(n=>n!["guid"]!.GetValue<string>()).SequenceEqual(afterChildren.Select(n=>n!["guid"]!.GetValue<string>())))
                    throw new InvalidOperationException("Chrome changed isolated bookmark folder order");
                foreach(var index in new[]{1,2})foreach(var field in new[]{"guid","name","type","children"})
                    if(!JsonNode.DeepEquals(originalChildren[index]![field],afterChildren[index]![field]))
                        throw new InvalidOperationException("Chrome changed unrelated isolated folder content: "+field);
                var histogram=Regex.Match(output,@"Histogram: Sync\.BookmarksModelMetadataCorruptionReason[\s\S]*?</pre>").Value;
                results.Add(new{corrected,restart,pid=process.Id,exit_code=process.ExitCode,local_tree_roundtrip=true,
                    histogram=System.Net.WebUtility.HtmlDecode(Regex.Replace(histogram,"<[^>]*>","")),
                    first_folder=after["roots"]!["bookmark_bar"]!["children"]![0]!["name"]!.GetValue<string>(),
                    sync_metadata_retained=!string.IsNullOrEmpty(after["sync_metadata"]?.GetValue<string>()),
                    input_sha256=Convert.ToHexString(SHA256.HashData(before)),output_length=output.Length,stderr_length=error.Length});
                // Keep the small synthetic diagnostic, not a growing browser profile.
                var evidence=Path.Combine(project,"artifacts","v1-release","evidence");Directory.CreateDirectory(evidence);
                await File.WriteAllTextAsync(Path.Combine(evidence,$"bookmark-sync-chrome-{(restart?"restart":corrected?"corrected":"control")}-20260908.html"),output);
            }
            var report=new{chrome_version=FileVersionInfo.GetVersionInfo(chrome).FileVersion,real_profile_writes=0,network_sync_tested=false,results};
            var json=JsonSerializer.Serialize(report,new JsonSerializerOptions{WriteIndented=true});
            await File.WriteAllTextAsync(Path.Combine(project,"artifacts","v1-release","evidence","bookmark-sync-chrome-20260908.json"),json);
            Console.WriteLine(json);
        }
        finally { Directory.Delete(scope,true); }
    }
}
