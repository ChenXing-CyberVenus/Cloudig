using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;

namespace Cloudig.Desktop;

// The approved Waiting-Sun GIF is made of transparent delta frames. Compose
// those frames in memory, not as loose PNGs or a second generated asset set.
internal sealed class StartupSunAnimation : IDisposable
{
    private readonly Image _image;
    internal int FrameCount { get; }
    internal double DurationMilliseconds { get; }

    internal StartupSunAnimation(Image image)
    {
        _image = image;
        using var stream = Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Waiting-Sun.gif"))?.Stream
            ?? throw new FileNotFoundException("The startup sun resource is missing.");
        var decoder = new GifBitmapDecoder(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        var width = Convert.ToInt32(decoder.Metadata.GetQuery("/logscrdesc/Width"));
        var height = Convert.ToInt32(decoder.Metadata.GetQuery("/logscrdesc/Height"));
        var animation = new ObjectAnimationUsingKeyFrames { RepeatBehavior = RepeatBehavior.Forever };
        BitmapSource? previous = null;
        var elapsed = TimeSpan.Zero;
        foreach (var frame in decoder.Frames)
        {
            var metadata = (BitmapMetadata)frame.Metadata;
            if (Convert.ToInt32(metadata.GetQuery("/grctlext/Disposal")) != 1)
                throw new InvalidDataException("The approved startup GIF no longer uses cumulative delta frames.");
            var drawing = new DrawingVisual();
            using (var context = drawing.RenderOpen())
            {
                context.DrawRectangle(Brushes.Black, null, new Rect(0, 0, width, height));
                if (previous is not null) context.DrawImage(previous, new Rect(0, 0, width, height));
                context.DrawImage(frame, new Rect(Convert.ToInt32(metadata.GetQuery("/imgdesc/Left")),
                    Convert.ToInt32(metadata.GetQuery("/imgdesc/Top")), frame.PixelWidth, frame.PixelHeight));
            }
            var composed = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            composed.Render(drawing);
            composed.Freeze();
            animation.KeyFrames.Add(new DiscreteObjectKeyFrame(composed, KeyTime.FromTimeSpan(elapsed)));
            elapsed += TimeSpan.FromMilliseconds(Math.Max(10, Convert.ToInt32(metadata.GetQuery("/grctlext/Delay")) * 10));
            previous = composed;
        }
        FrameCount = decoder.Frames.Count;
        DurationMilliseconds = elapsed.TotalMilliseconds;
        animation.Duration = elapsed;
        animation.Freeze();
        image.Source = (ImageSource)animation.KeyFrames[0].Value;
        image.BeginAnimation(Image.SourceProperty, animation);
    }

    public void Dispose()
    {
        _image.BeginAnimation(Image.SourceProperty, null);
        _image.Source = null;
    }
}
