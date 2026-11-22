using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Cloudig.Bookmarks;
using Cloudig.Desktop.Core;

internal static class LiveProductBookmarks
{
    private delegate bool WindowCallback(nint window,nint data);
    [DllImport("user32")] private static extern bool EnumWindows(WindowCallback callback,nint data);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(nint window,out int process);
    [DllImport("user32")] private static extern bool ShowWindowAsync(nint window,int command);
    [DllImport("user32")] private static extern bool PostMessage(nint window,uint message,nint w,nint l);
    internal static void CloseFixtureWindows(Process owner)
    {
        if(owner.HasExited)return;
        EnumWindows((window,_)=>{GetWindowThreadProcessId(window,out var pid);if(pid==owner.Id){ShowWindowAsync(window,6);PostMessage(window,0x10,0,0);}return true;},0);
    }
    internal static async Task Create(string package,string root,TextWriter log)
    {
        var user=Path.Combine(root,"User Data");var profile=Path.Combine(user,"Default");Directory.CreateDirectory(profile);
        File.WriteAllText(Path.Combine(user,"Local State"),"""{"profile":{"last_used":"Default","info_cache":{"Default":{"name":"QA"}}}}""");
        var file=Path.Combine(profile,"Bookmarks");
        var backups=Path.Combine(root,"backups");
        BookmarkCapabilityHost Host(CloudigDeviceSettingsStore? settings=null)=>new(Path.Combine(package,"bookmark-package.json"),Path.Combine(package,"artifacts"),backups,settings??new(Path.Combine(root,"device.json")),user,browserState:()=>BookmarkBrowserState.Open);
        var chrome=new[]{Environment.SpecialFolder.ProgramFiles,Environment.SpecialFolder.ProgramFilesX86,Environment.SpecialFolder.LocalApplicationData}
            .Select(f=>Path.Combine(Environment.GetFolderPath(f),"Google","Chrome","Application","chrome.exe")).First(File.Exists);
        var start=new ProcessStartInfo(chrome){UseShellExecute=false};
        foreach(var arg in new[]{"--no-first-run","--no-default-browser-check","--disable-sync","--disable-extensions","--disable-background-networking","--user-data-dir="+user,"about:blank"})start.ArgumentList.Add(arg);
        JsonArray Bar()=>JsonNode.Parse(File.ReadAllText(file))!["roots"]!["bookmark_bar"]!["children"]!.AsArray();
        using(var browser=QuietTestDesktop.Start(start)){
            await Task.Delay(4000);
            for(int i=0;i<60&&!File.Exists(Path.Combine(profile,"Preferences"));i++)await Task.Delay(200);
            log.WriteLine("First native install: prior Bookmarks file="+File.Exists(file));
            await Host().SaveInstallMethodAsync("light",false);
            var fault=new CloudigDeviceSettingsStore(Path.Combine(root,"device.json")){BeforeWriteForTests=s=>{if(s.ManagedFolderGuid.Length>0)throw new IOException("Simulated final settings save interruption");}};
            try {await Host(fault).InstallAsync("light",["chatgpt"]);throw new Exception("Expected an interrupted final settings save");}
            catch(BookmarkCapabilityException e) when(e.Code=="CLOUDIG_BOOKMARK_SETTINGS_SAVE_FAILED"){}
            var first=await Host().InstallAsync("light",["chatgpt"]);
            if(first.Added!=0||first.Updated!=0 || first.Summary.Platforms.Single(p=>p.Id=="chatgpt").Status!="current")throw new IOException("Interrupted first install duplicated or lost a slot");
            log.WriteLine("PASS native folder and first slot, retry after interrupted final settings save");
            var second=await Host().InstallAsync("light",["claude","chatgpt"]);
            if(second.Added!=1||second.Updated!=0||browser.HasExited)throw new IOException("Supplement duplicated bookmarks or exited Chrome");
            log.WriteLine("PASS native supplement and same live Chrome process");
            var bar=Bar();
            if(bar.Count!=1 || bar[0]?["children"]?.AsArray().Count!=2)throw new IOException("Folder not first or duplicate");
            var ids=second.Summary.Platforms.Select(p=>p.Id).ToArray();
            var bulk=await Host().InstallAsync("light",ids);
            if(bulk.Added!=ids.Length-2||bulk.Updated!=0||bulk.Summary.Platforms.Any(p=>p.Status!="current"))throw new IOException("Bulk native install incomplete");
            log.WriteLine("PASS native Install All, all "+ids.Length+" selected slots verified");
        }
        using(var again=QuietTestDesktop.Start(start)){
            await Task.Delay(4000);
            var retry=await Host().InstallAsync("light",["claude","chatgpt"]);
            if(retry.Added!=0||retry.Updated!=0||retry.Summary.Platforms.Any(p=>p.Status!="current"))throw new IOException("Restart did not preserve slots");
        }
        if(Directory.GetFiles(backups,"before.json.gz",SearchOption.AllDirectories).Length!=2)throw new IOException("Backup retention");
        log.WriteLine("PASS shared two-group quota, folder first and Chrome restart.");
    }
    internal static void RetireFixture(string root)
    {
        var parent=Path.GetFullPath("tests/private/live-product-bookmarks");
        if (Path.GetDirectoryName(root)!=parent || !Guid.TryParseExact(Path.GetFileName(root),"N",out _) ||
            !File.ReadAllText(Path.Combine(root,"acceptance.txt")).Contains("PASS shared two-group quota",StringComparison.Ordinal))
            throw new IOException("Unverified live bookmark fixture");
        var dirs=new[]{Path.Combine(root,"User Data"),Path.Combine(root,"backups")};
        foreach(var dir in dirs)
        {
            var pending=new Stack<string>();pending.Push(dir);
            while(pending.TryPop(out var entry)){
                var attrs=File.GetAttributes(entry);
                if(attrs.HasFlag(FileAttributes.ReparsePoint))throw new IOException("Linked fixture entry");
                if(attrs.HasFlag(FileAttributes.Directory))foreach(var child in Directory.EnumerateFileSystemEntries(entry))pending.Push(child);
            }
        }
        foreach(var dir in dirs)Directory.Delete(dir,recursive:true);
    }

    internal static async Task Run(string package,string root,string empty,TextWriter log)
    {
        var user=Path.Combine(root,"User Data");
        var profile=Path.Combine(user,"Default");
        Directory.CreateDirectory(profile);
        File.WriteAllText(Path.Combine(user,"Local State"),"""{"profile":{"last_used":"Default","info_cache":{"Default":{"name":"QA"}}}}""");
        var file=Path.Combine(profile,"Bookmarks");
        File.WriteAllText(file,empty);
        var backups=Path.Combine(root,"backups");
        BookmarkCapabilityHost Host(BookmarkBrowserState state) => new(Path.Combine(package,"bookmark-package.json"),
            Path.Combine(package,"artifacts"), backups,Path.Combine(root,"device.json"),user,browserState:()=>state);
        var host=Host(BookmarkBrowserState.Closed);
        var targets=(await host.QueryAsync("light")).Platforms.Select(p=>p.Id).ToArray();
        await host.InstallAsync("light",targets);
        var doc=JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        var bar=doc["roots"]!["bookmark_bar"]!["children"]!.AsArray();
        var nodes=bar.Single()!["children"]!.AsArray();
        var ids=nodes.Select(n=>(string)n!["guid"]!).ToArray();
        foreach(var n in nodes.Take(2))
        {
            n!["url"]="javascript:void(0)";
            n["meta_info"]!["cloudig_version"]="0.0.1-light";
            n["meta_info"]!["cloudig_sha256"]=new string('0',64);
        }
        nodes[1]!["name"]="My custom label";
        var sums=ChromeBookmarkChecksums.Compute(doc);
        doc["checksum"]=sums.Md5; doc["checksum_sha256"]=sums.Sha256;
        File.WriteAllText(file,doc.ToJsonString());
        var chrome=new[]{Environment.SpecialFolder.ProgramFiles,Environment.SpecialFolder.ProgramFilesX86,Environment.SpecialFolder.LocalApplicationData}
            .Select(f=>Path.Combine(Environment.GetFolderPath(f),"Google","Chrome","Application","chrome.exe")).First(File.Exists);
        var start=new ProcessStartInfo(chrome){UseShellExecute=false};
        foreach(var arg in new[]{"--no-first-run","--no-default-browser-check","--disable-sync","--disable-extensions","--disable-background-networking","--user-data-dir="+user,"about:blank"})start.ArgumentList.Add(arg);
        using var browser=QuietTestDesktop.Start(start);
        await Task.Delay(4000);
        var live=Host(BookmarkBrowserState.Open);
        var preference=await live.QueryAsync("light");
        if(!preference.RequireChromeClosed)throw new Exception("Default install method did not require Chrome to exit");
        var beforeWait=File.ReadAllBytes(file);
        try { await Host(BookmarkBrowserState.Open).InstallAsync("light",targets);throw new Exception("Closed-only preference allowed a live install"); }
        catch(BookmarkCapabilityException e) when(e.Code=="CLOUDIG_CHROME_OPEN"){}
        if(!File.ReadAllBytes(file).SequenceEqual(beforeWait)||browser.HasExited)throw new Exception("Waiting altered the fixture browser");
        await live.SaveInstallMethodAsync("light",false);
        log.WriteLine("PASS real running Chrome is untouched by default; explicit opt-in enables native updates.");
        var installed=await live.QueryAsync("light");
        var old=installed.Platforms.Where(p=>p.Status=="outdated").ToArray();
        if(old.Length!=2) throw new Exception("Expected two outdated managed slots: "+string.Join(",",installed.Platforms.Select(p=>p.Status)));
        var one=await live.InstallAsync("light",[old[0].Id]);
        if(one.Updated!=1)throw new Exception("Single update count");
        var all=await live.InstallAsync("light",targets);
        if(all.Updated!=1 || all.Summary.Platforms.Any(p=>p.Status!="current" || p.InstalledVersion!=p.Version))throw new Exception("Batch update or version readback");
        var again=await Host(BookmarkBrowserState.Open).InstallAsync("light",targets);
        if(again.Updated!=0 || Directory.GetFiles(backups,"before.json.gz",SearchOption.AllDirectories).Length!=2)throw new Exception("Restart no-op or retention");
        var current=JsonNode.Parse(File.ReadAllText(file))!["roots"]!["bookmark_bar"]!["children"]![0]!["children"]!.AsArray();
        if(!ids.SequenceEqual(current.Select(n=>(string)n!["guid"]!)) || (string?)current[1]!["name"]!="My custom label" || browser.HasExited)
            throw new Exception("Node identity, order, custom title or warm browser lost");
        // The initial closed install and both live updates share a two-group budget.
        if (Directory.GetFiles(backups,"backup-manifest.json",SearchOption.AllDirectories).Length!=0)
            throw new Exception("Closed and live backups did not share retention");
        log.WriteLine("PASS product host: single + batch + restart no-op, version readback, two backups, GUID/order/custom title; original browser remains open.");
        // The private fixture browser has no further work. Two subsequent
        // ordinary operations must retire both live rollback groups while
        // preserving version recognition for the other managed entries.
        browser.Dispose();
        var unrelated=targets.First(id=>old.All(p=>p.Id!=id));
        await host.RemoveAsync("light",[unrelated]);
        await host.InstallAsync("light",[unrelated]);
        var retired=await Host(BookmarkBrowserState.Closed).QueryAsync("light");
        if(retired.Platforms.Any(p=>p.Status!="current" || p.InstalledVersion!=p.Version) ||
           Directory.GetFiles(backups,"before.json.gz",SearchOption.AllDirectories).Length!=0 ||
           Directory.GetFiles(backups,"backup-manifest.json",SearchOption.AllDirectories).Length!=2)
            throw new Exception("Mixed retention removed version knowledge or kept excess backups");
        log.WriteLine("PASS shared two-group quota and version receipts after both live journals retire.");
    }
}
