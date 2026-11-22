using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Test harness only, following scripts/installer-picker-probe.cs. Never switch
// desktops. Explicitly start the fixture browser and the fixed EXE here too:
// a separate Chrome profile by itself does not isolate desktop focus.
internal static class QuietTestDesktop
{
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string? reserved,desktop,title; public int x,y,w,h,cx,cy,fill,flags;
        public short show,reserved2; public nint reservedPtr,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct Info { public nint process,thread; public int pid,tid; }
    [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] static extern nint CreateDesktop(string name,nint dev,nint mode,int flags,uint access,nint attrs);
    [DllImport("user32")] static extern nint GetThreadDesktop(uint thread);
    [DllImport("user32",SetLastError=true)] static extern nint OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(nint h,int idx,StringBuilder value,int length,out int used);
    [DllImport("user32")] static extern bool CloseDesktop(nint d);
    [DllImport("kernel32")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32")] static extern bool CloseHandle(nint h);
    [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,nint pa,nint ta,bool inherit,uint flags,nint env,string cwd,ref Startup si,out Info pi);
    static string Name(nint d){var b=new StringBuilder(256);if(d==0||!GetUserObjectInformation(d,2,b,b.Capacity*2,out _))throw new Win32Exception();return b.ToString();}
    static string Current()=>Name(GetThreadDesktop(GetCurrentThreadId()));
    internal static void RequirePrivate(){
        var d=OpenInputDesktop(0,false,1);
        try{if(!Current().StartsWith("Cloudig-BmQA-",StringComparison.Ordinal)||Current()==Name(d))throw new InvalidOperationException("Refusing browser QA on the interactive desktop.");}
        finally{if(d!=0)CloseDesktop(d);}
    }
    [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle h,out int code);
    [DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle h,uint timeout);
    [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle h,uint code);
    internal sealed class Child(nint handle,int id):IDisposable {
        readonly SafeProcessHandle h=new(handle,true);
        internal int Id=>id;
        internal int ExitCode=>GetExitCodeProcess(h,out var code)?code:throw new Win32Exception();
        internal bool WaitForExit(int ms=-1)=>WaitForSingleObject(h,unchecked((uint)ms)) switch{0=>true,258=>false,_=>throw new Win32Exception()};
        internal bool HasExited=>WaitForExit(0);
        public void Dispose(){
            if(h.IsClosed)return;
            // This exact handle came from our own CreateProcess in a disposable
            // fixture. Don't leave an orphan EXE editing after a failed timeout.
            // Normal paths already exited gracefully, including the real browser.
            try{if(!HasExited&&TerminateProcess(h,111))WaitForExit(5000);}finally{h.Dispose();}
        }
    }
    static Child Launch(string desktop,string exe,IEnumerable<string> args){
        // All arguments in this fixture are switches or known files, never raw command lines.
        string Q(string x)=>x.Contains('"')||x.EndsWith('\\')?throw new ArgumentException("Unsupported fixture path"):("\""+x+"\"");
        var cmd=new StringBuilder(string.Join(" ",new[]{exe}.Concat(args).Select(Q)));
        var si=new Startup{cb=Marshal.SizeOf<Startup>(),desktop=desktop};
        if(!CreateProcess(exe,cmd,0,0,false,0x08000000,0,Environment.CurrentDirectory,ref si,out var pi))throw new Win32Exception();
        CloseHandle(pi.thread);return new Child(pi.process,pi.pid);
    }
    internal static Child Start(ProcessStartInfo p){RequirePrivate();return Launch(Current(),p.FileName,p.ArgumentList);}
    internal static void Run(string project,string exe,string root,bool editorProbe=false,string? workerMode=null){
        var desk="Cloudig-BmQA-"+Guid.NewGuid().ToString("N");
        var d=CreateDesktop(desk,0,0,0,0x00C7,0); // no SWITCHDESKTOP access
        if(d==0)throw new Win32Exception();
        try{
            Directory.CreateDirectory(root);var log=Path.Combine(root,"acceptance.txt");
            Console.WriteLine("Unshown test desktop: "+desk+"; evidence: "+log);
            var cli=Path.Combine(project,"manager",".cache","dotnet","dotnet.exe");
            using var worker=Launch(desk,cli,[typeof(QuietTestDesktop).Assembly.Location,workerMode ?? (editorProbe?"--isolated-editor-probe":"--isolated-worker"),exe,root]);
            worker.WaitForExit();if(File.Exists(log))Console.Write(File.ReadAllText(log));
            if(worker.ExitCode!=0)throw new Exception("Private-desktop QA failed: "+worker.ExitCode);
        }finally{CloseDesktop(d);}
    }
}
