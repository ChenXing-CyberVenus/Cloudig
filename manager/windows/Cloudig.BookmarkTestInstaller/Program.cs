using Cloudig.Bookmarks;
using System.Runtime.InteropServices;

namespace Cloudig.BookmarkTestInstaller;

internal static class Program
{
    private const string FolderName = "书签测试";

    [STAThread]
    private static void Main(string[] arguments)
    {
        try
        {
            if (arguments.Length == 4 && arguments[0] == "--data-root" && arguments[2] == "--storage-probe")
            {
                var extraction = Environment.GetEnvironmentVariable("DOTNET_BUNDLE_EXTRACT_BASE_DIR") ?? throw new IOException("未设置受控解压目录。");
                var files = Directory.Exists(extraction) ? Directory.GetFiles(extraction, "*", SearchOption.AllDirectories) : [];
                File.WriteAllText(Path.GetFullPath(arguments[3]), $"{Path.GetFullPath(arguments[1])}\n{Path.GetFullPath(extraction)}\n{files.Length}\n");
                return;
            }
            Install(arguments);
        }
        catch (Exception error)
        {
            Environment.ExitCode = 1;
            if (arguments.Contains("--storage-probe")) return;
            NativeDialog.Show(
                $"书签测试安装失败：\n\n{ReadableError(error)}",
                "安装当前书签测试",
                NativeDialog.Ok | NativeDialog.IconError);
        }
    }

    private static void Install(IReadOnlyList<string> arguments)
    {
        var sourceDirectory = Path.GetFullPath(AppContext.BaseDirectory);
        var package = BookmarkTestDirectoryLoader.Load(sourceDirectory);
        var options=arguments.ToList();
        var undo=options.Remove("--restore-last-live");
        var userData=ChromeProfileDiscovery.DefaultUserDataDirectory;
        int profileOption=options.IndexOf("--chrome-user-data-dir");
        if(profileOption>=0){
            if(profileOption+1>=options.Count||!Path.IsPathFullyQualified(options[profileOption+1]))throw new ArgumentException("Chrome 数据目录必须是完整的本机路径。");
            userData=Path.GetFullPath(options[profileOption+1]);options.RemoveRange(profileOption,2);
        }
        var dataRoot = BookmarkTestStoragePolicy.ResolveDataRoot(sourceDirectory, options) ?? SelectDataDirectory();
        if (dataRoot is null) return;
        var backupRoot = Path.Combine(dataRoot, "Device", "BookmarkTestInstaller", "Backups");
        var profiles = ChromeProfileDiscovery.Discover(userData);
        var store = SelectLocalStore(profiles)
                    ?? throw new InvalidOperationException("没有选择 Chrome 本地书签库，未进行任何修改。");
        using var guard=new Mutex(false,@"Local\Cloudig.BookmarkTestInstaller.v2");
        bool acquired;
        try{acquired=guard.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}
        if(!acquired)throw new IOException("已有测试书签安装正在进行，不重复启动。");
        try{
        if(ChromeProfileDiscovery.IsChromeRunning()||undo){
            (int Count,string? Backup) live;
            // Leave the native dialog's STA before binding UI Automation. All
            // its COM objects live and finish together on one non-UI MTA worker.
            try{live=Task.Run(()=>LiveUpdate.Execute(package,store,backupRoot,LiveChromeEditor.Executable(),undo)).GetAwaiter().GetResult();}
            catch(Exception e){
                // Keep a local recovery diagnosis even if the native message box is dismissed.
                var device=Path.GetDirectoryName(backupRoot)!;Directory.CreateDirectory(device);
                var log=Path.Combine(device,"last-live-error.txt");File.WriteAllText(log,DateTimeOffset.Now.ToString("O")+"\n"+e);
                throw new IOException("在线更新未完成，本机诊断："+log,e);
            }
            NativeDialog.Show(live.Count==0?"书签已是目标版本，未写入、未新增备份。":
                $"已在原位置{(undo?"还原":"更新")} {live.Count} 枚测试书签；Chrome 已保存并通过完整脚本回读。原有对话未刷新。\n\n回滚备份：{live.Backup}",
                "安装当前书签测试",NativeDialog.Ok|NativeDialog.IconInformation);
            return;
        }
        var answer = NativeDialog.Show(
            $"即将把当前目录中的 {package.Bookmarks.Count} 个单行书签安装或更新到：\n\n"
            + $"Chrome 配置：{store.ProfileDisplayName}（{store.ProfileDirectory}）\n"
            + $"书签位置：书签栏 / {FolderName}\n\n"
            + $"备份位置：{backupRoot}\n\n写入前会完整备份，仅保留最近两组，旧备份自动淘汰；失败会自动回滚。\n不会执行书签，也不会联网。\n\n是否继续？",
            "安装当前书签测试",
            NativeDialog.OkCancel | NativeDialog.IconQuestion | NativeDialog.DefaultButton2);
        if (answer != NativeDialog.ResultOk) return;
        if (ChromeProfileDiscovery.IsChromeRunning())
        {
            throw new InvalidOperationException("确认期间 Chrome 已打开，本次没有直接写库。再点一次即可走在线更新。");
        }

        Dictionary<string,string>? previousTitles=null;
        if(Directory.Exists(Path.Combine(backupRoot,"Live"))){
            // A live edit goes through Chrome and cannot update its private meta_info.
            // Recover just proven automatic names; keep the existing first-install path.
            try{previousTitles=LiveUpdate.LastDefaults(backupRoot,LiveBookmarkSnapshot.Read(store));}catch(InvalidDataException){}
        }
        var editor = new BookmarkTestFileEditor(package, FolderName,previousTitles);
        var transaction = new BookmarkTransaction(editor, backupRoot);
        var result = transaction.Execute([store], BookmarkOperation.InstallOrRepair, DateTime.UtcNow);
        var detail = result.ChangedStoreCount == 0
            ? $"“{FolderName}”已经是当前版本，没有写入 Chrome，也没有新建备份。"
            : $"安装完成：新增 {result.AddedCount}，更新 {result.UpdatedCount}，移除过期测试书签 {result.RemovedCount}。\n\n"
              + $"回滚备份：{result.BackupDirectory}";
        NativeDialog.Show(
            detail,
            "安装当前书签测试",
            NativeDialog.Ok | NativeDialog.IconInformation);
        }finally{guard.ReleaseMutex();}
    }

    private static string? SelectDataDirectory()
    {
        var info = new BrowseInfo { Title = "选择采云数据目录（回滚备份保存在其 Device 内，不使用 AppData）", Flags = 0x0041 };
        var id = SHBrowseForFolder(ref info);
        if (id == IntPtr.Zero) return null;
        try
        {
            var path = new System.Text.StringBuilder(32768);
            if (!SHGetPathFromIDListEx(id, path, (uint)path.Capacity, 0)) throw new IOException("无法读取所选数据目录。");
            return Path.GetFullPath(path.ToString());
        }
        finally { Marshal.FreeCoTaskMem(id); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct BrowseInfo
    {
        public IntPtr Owner;
        public IntPtr Root;
        public IntPtr DisplayName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Title;
        public uint Flags;
        public IntPtr Callback;
        public IntPtr Parameter;
        public int Image;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHBrowseForFolder(ref BrowseInfo info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SHGetPathFromIDListEx(IntPtr id, System.Text.StringBuilder path, uint characters, uint flags);

    private static BookmarkStore? SelectLocalStore(IReadOnlyList<ChromeProfile> profiles)
    {
        var localStores = profiles
            .SelectMany(profile => profile.Stores.Where(store => store.Kind == "local"))
            .ToArray();
        if (localStores.Length == 0)
        {
            throw new FileNotFoundException("没有发现 Chrome 本地 Bookmarks 文件。安装器不会自动改写 Bookmarks Account。");
        }

        var lastUsedStores = profiles
            .Where(profile => profile.IsLastUsed)
            .SelectMany(profile => profile.Stores.Where(store => store.Kind == "local"))
            .ToArray();
        if (lastUsedStores.Length == 1) return lastUsedStores[0];
        if (localStores.Length == 1) return localStores[0];

        for (var index = 0; index < localStores.Length; index++)
        {
            var store = localStores[index];
            var result = NativeDialog.Show(
                $"无法唯一判断上次使用的本地 Chrome 配置。\n\n"
                + $"候选 {index + 1}/{localStores.Length}：\n"
                + $"{store.ProfileDisplayName}（{store.ProfileDirectory}）\n\n"
                + "“是”选择此配置；“否”查看下一个；“取消”退出。",
                "选择 Chrome 配置",
                NativeDialog.YesNoCancel | NativeDialog.IconQuestion);
            if (result == NativeDialog.ResultYes) return store;
            if (result == NativeDialog.ResultCancel) return null;
        }
        return null;
    }

    private static string ReadableError(Exception error)
    {
        var messages = new List<string>();
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (!string.IsNullOrWhiteSpace(current.Message)
                && !messages.Contains(current.Message, StringComparer.Ordinal))
            {
                messages.Add(current.Message);
            }
        }
        return string.Join("\n", messages);
    }
}

internal static class NativeDialog
{
    public const uint Ok = 0x00000000;
    public const uint OkCancel = 0x00000001;
    public const uint YesNoCancel = 0x00000003;
    public const uint IconError = 0x00000010;
    public const uint IconQuestion = 0x00000020;
    public const uint IconInformation = 0x00000040;
    public const uint DefaultButton2 = 0x00000100;
    public const int ResultOk = 1;
    public const int ResultCancel = 2;
    public const int ResultYes = 6;

    public static int Show(string message, string title, uint type) =>
        MessageBox(IntPtr.Zero, message, title, type);

    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);
}
