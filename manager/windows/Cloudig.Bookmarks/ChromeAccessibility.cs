using System.Runtime.InteropServices;

namespace Cloudig.Bookmarks;

// Small projection of the Windows SDK UIAutomationClient interfaces. Only
// control lookup, Invoke and Value are used; no global keyboard or clipboard.
internal sealed class ChromeAccessibility
{
    private readonly IAutomation api = (IAutomation)new AutomationClass();
    [ComImport,Guid("ff48dba4-60ef-4201-aa87-54103eef594e")] private class AutomationClass{}
    internal Element Window(nint h) => api.ElementFromHandle(h);
    internal Element? First(Element root,int property,object value)=>root.FindFirst(4,api.Property(property,value));
    internal List<Element> Find(Element root,int property,object value,int scope=4)
    {
        var list=root.FindAll(scope,api.Property(property,value));
        return Enumerable.Range(0,list.Length()).Select(list.Get).ToList();
    }
    internal static string Name(Element e) => e.Property(30005) as string ?? "";
    internal static string Id(Element e) => e.Property(30011) as string ?? "";
    internal static string Value(Element e) => ((EditValue)e.Pattern(10002)).Get();
    internal static void Set(Element e,string s) => ((EditValue)e.Pattern(10002)).Set(s);
    internal static void Click(Element e) => ((Invoke)e.Pattern(10000)).Click();
    internal static void OpenFolder(Element e){if(e.Pattern(10005) is ExpandPattern p)p.Expand();else Click(e);}
    [ComImport,Guid("619be086-1f4e-4ee4-bafa-210128738730"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ExpandPattern{void Expand();}
    internal static void ScrollItem(Element e) {if(e.Pattern(10017) is ScrollItemPattern p)p.ScrollIntoView();}
    [ComImport,Guid("b488300f-d015-4f19-9c29-bb595e3645ef"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ScrollItemPattern{void ScrollIntoView();}
    [ComImport,Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAutomation {
        void Slot0();void Slot1();void Slot2(); Element ElementFromHandle(nint hwnd);
        void Slot4();void Slot5();void Slot6();void Slot7();void Slot8();void Slot9();
        void Slot10();void Slot11();void Slot12();void Slot13();void Slot14();void Slot15();
        void Slot16();void Slot17();void Slot18();void Slot19();
        Condition Property(int id,[MarshalAs(UnmanagedType.Struct)] object value);
    }
    [ComImport,Guid("352ffba8-0973-437c-a61f-f64cafd81df9"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Condition {}
    [ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Element {
        void Focus();void Slot1();Element? FindFirst(int scope,Condition condition); Elements FindAll(int scope,Condition condition);
        void Slot4();void Slot5();void Slot6();
        [return:MarshalAs(UnmanagedType.Struct)] object Property(int id);
        void Slot8();void Slot9();void Slot10();void Slot11();void Slot12();
        [return:MarshalAs(UnmanagedType.IUnknown)] object Pattern(int id);
    }
    [ComImport,Guid("14314595-b4bc-4055-95f2-58f2e42c9855"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Elements {int Length();Element Get(int index);}
    [ComImport,Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Invoke {void Click();}
    [ComImport,Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface EditValue {void Set([MarshalAs(UnmanagedType.BStr)]string value);[return:MarshalAs(UnmanagedType.BStr)] string Get();}
}
