using System.Windows;
using System.Windows.Media;

namespace Cloudig.Desktop;

public partial class ExitConfirmation : Window
{
    internal ExitConfirmation(Window owner, bool night, bool english, bool audit = false)
    {
        InitializeComponent(); Owner=owner;
        var ink=Brush(night?"#E2E1E1":"#2D2D2D");var accent=Brush(night?"#FFA92E":"#A52525");
        Card.Background=Brush(night?"#303038":"#F2E7D8");Card.BorderBrush=Brush(night?"#65616E":"#B4A08A");
        Foreground=ink;Heading.Foreground=ink;Divider.Background=accent;
        CancelAction.Background=Card.Background;CancelAction.Foreground=accent;CancelAction.BorderBrush=accent;
        CloseAction.Background=Brush(night?"#5125A5":"#A52525");CloseAction.BorderBrush=CloseAction.Background;CloseAction.Foreground=Brush(night?"#FFA92E":"#FFFFFF");
        Heading.Text=english?"Close Cloudig":"关闭采云";Question.Text=english?"Are you sure you want to close Cloudig?":"确定关闭采云吗？";
        CancelAction.Content=english?"Cancel":"取消";CloseAction.Content=english?"Close Cloudig":"关闭采云";
        WindowStartupLocation=WindowStartupLocation.Manual;
        Left=owner.Left+(owner.ActualWidth-Width)/2;Top=owner.Top+(owner.ActualHeight-260)/2;
        ShowActivated=!audit;
        Loaded+=(_,_)=>{Left=owner.Left+(owner.ActualWidth-ActualWidth)/2;Top=owner.Top+(owner.ActualHeight-ActualHeight)/2;if(!audit)CancelAction.Focus();};
    }
    private static SolidColorBrush Brush(string hex)=>new((Color)ColorConverter.ConvertFromString(hex));
    private void Confirm(object sender,RoutedEventArgs e)=>DialogResult=true;
}
