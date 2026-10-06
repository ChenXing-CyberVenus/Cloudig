using System.Collections.Concurrent;
using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Cloudig.Desktop.Core;
using Microsoft.VisualBasic.FileIO;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Cloudig.Desktop;

public partial class MainWindow : Window
{
    private readonly AppLayout _layout;
    private readonly Func<Task<bool>> _prepareStorage;
    private readonly BridgePolicy _bridge = new();
    private ReleaseUpdateClient _releaseUpdates = new();
    private readonly CloudigDeviceSettingsStore _deviceSettings;
    private readonly BookmarkCapabilityHost _bookmarks;
    private readonly ConcurrentDictionary<string, PortableMovePreview> _libraryMovePlans = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _webRequests = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _pickerTokens = new(StringComparer.Ordinal);
    private EngineJsonlClient? _engine;
    private LocalFileResponses? _localFiles;
    private CoreWebView2Environment? _webViewEnvironment;
    private WebViewCacheSession? _webViewCache;
    private readonly TaskCompletionSource _browserExited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> _loadingVisible = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> _libraryReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _startupFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _resourcesClosed;
    private string? _libraryRoot;
    private bool _closeAllowed;
    private bool _closing;
    private bool _visualAuditStarted;
    private StartupSunAnimation? _startupSun;

    private void TraceVisualAudit(string stage, string? detail = null)
    {
        if (_layout.VisualAudit is not { } audit) return;
        try
        {
            var trace = Path.ChangeExtension(audit.OutputFile, ".trace.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(trace)!);
            File.AppendAllText(trace, $"{DateTimeOffset.UtcNow:O}\t{stage}{(string.IsNullOrWhiteSpace(detail) ? string.Empty : $"\t{detail}")}\n", new UTF8Encoding(false));
        }
        catch
        {
            // Audit tracing must never change application behavior.
        }
    }

    internal MainWindow(AppLayout layout, Func<Task<bool>> prepareStorage)
    {
        InitializeComponent();
        _layout = layout;
        _prepareStorage = prepareStorage;
        _deviceSettings = new CloudigDeviceSettingsStore(layout.BookmarkSettingsFile);
        var bookmarkAuditRoot = layout.VisualAudit is { } bookmarkAudit && bookmarkAudit.Query.Contains("interaction=bookmark-install", StringComparison.Ordinal)
            ? PrepareBookmarkAuditProfile(Path.Combine(layout.DeviceRoot, Path.GetFileNameWithoutExtension(bookmarkAudit.OutputFile))) : null;
        _bookmarks = new BookmarkCapabilityHost(
            layout.BookmarkManifest,
            layout.BookmarkArtifactRoot,
            layout.BookmarkBackupRoot,
            _deviceSettings,
            userDataDirectory: bookmarkAuditRoot,
            changelogPath: layout.BookmarkChangelog,
            browserState: bookmarkAuditRoot is null ? null : () => BookmarkBrowserState.Closed);
        PlaceWindow();
        SourceInitialized += AttachWindowBounds;
        Loaded += OnLoaded;
        Closing += OnClosing;
        Closed += OnClosed;
        StateChanged += (_, _) => UpdateMaximizeGlyph();
        WebView.SizeChanged += (_, _) => ApplyViewportScale();
    }

    private void ApplyViewportScale()
    {
        if (_resourcesClosed) return;
        var scale = ViewportScale.ForClient(WebView.ActualWidth, WebView.ActualHeight);
        StartupSun.Width = StartupSun.Height = 96 * scale;
        if (WebView.CoreWebView2 is null) return;
        if (Math.Abs(WebView.ZoomFactor - scale) > .00001) WebView.ZoomFactor = scale;
    }

    private void PlaceWindow()
    {
        if (_layout.VisualAudit is { } audit)
        {
            Width = audit.Width + 2;
            Height = audit.Height + 40;
            ShowActivated = false;
            ShowInTaskbar = false;
            Left = SystemParameters.VirtualScreenLeft - Width - 64;
            Top = SystemParameters.VirtualScreenTop;
            return;
        }
        var area = SystemParameters.WorkArea;
        const double margin = 24;
        const double title = 38;
        var scale = Math.Min(1, Math.Min(
            Math.Max(1, area.Width - margin * 2) / 1920,
            Math.Max(1, area.Height - title - margin * 2) / 1080));
        scale = Math.Max(2d / 3d, scale);
        Width = Math.Min(area.Width, 1920 * scale);
        Height = Math.Min(area.Height, 1080 * scale + title);
        Left = area.Left + Math.Max(0, (area.Width - Width) / 2);
        Top = area.Top + Math.Max(0, (area.Height - Height) / 2);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        TraceVisualAudit("window-loaded");
        var firstFrameClock = Stopwatch.StartNew();
        try
        {
            _startupSun = new StartupSunAnimation(StartupSun);
            await Dispatcher.Yield(DispatcherPriority.Background);
            TraceVisualAudit("native-loading-visible", $"frames={_startupSun.FrameCount};duration_ms={_startupSun.DurationMilliseconds}");
            if (_layout.VisualAudit is { } startupAudit && startupAudit.Query.Contains("interaction=startup", StringComparison.Ordinal))
                await VerifyNativeStartupAnimationAsync(startupAudit, firstFrameClock.ElapsedMilliseconds);
            if (_closing) return;
            TraceVisualAudit("storage-check-starting");
            if (!await _prepareStorage()) { StopStartupSun(); _closeAllowed = true; Close(); return; }
            TraceVisualAudit("storage-check-complete");
            if (_closing) return;
            if (!Directory.Exists(_layout.WebRoot)) throw new DirectoryNotFoundException("Cloudig local interface is missing.");
            TraceVisualAudit("webview-environment-starting");
            // Business state lives in flat Library records and appdata, never in the browser profile.
            // The profile stays inside the same explicit portable cache root.
            _webViewCache = WebViewCacheSession.Create(_layout.WebViewUserDataRoot);
            var environmentTask = CoreWebView2Environment.CreateAsync(userDataFolder: _webViewCache.ProfileRoot,
                options: new CoreWebView2EnvironmentOptions($"{LocalFileResponses.BrowserArguments} --disk-cache-size={CloudigCachePolicy.DiskCacheBytes} --media-cache-size={CloudigCachePolicy.MediaCacheBytes}"));
            // The Engine handshake only prepares this session's cache. Library
            // recovery/creation remains behind the first painted loading frame.
            await Task.WhenAll(environmentTask, PrepareEngineAsync());
            var environment = await environmentTask;
            _webViewEnvironment = environment;
            environment.BrowserProcessExited += (_, _) => _browserExited.TrySetResult();
            TraceVisualAudit("webview-environment-ready", environment.BrowserVersionString);
            await WebView.EnsureCoreWebView2Async(environment);
            _webViewCache.RegisterBrowser(checked((int)WebView.CoreWebView2.BrowserProcessId));
            TraceVisualAudit("webview-core-ready");
            ConfigureWebView();
            ApplyViewportScale();
            // Both origins are served before navigation; managed streams avoid
            // WebView's MAX_PATH-bound folder mapping for program and user data.
            BindLocalContent();
            if (_layout.VisualAudit is not null) WebView.CoreWebView2.NavigationCompleted += OnVisualAuditNavigationCompleted;
            var localInterfaceUrl = LocalInterfaceUrl();
            TraceVisualAudit("navigation-assign", localInterfaceUrl);
            WebView.Source = new Uri(localInterfaceUrl);

            // Paint the one real GIF before Library recovery/index work. Web
            // commands wait for authority readiness; the loading page does not.
            if (!await _loadingVisible.Task.WaitAsync(TimeSpan.FromSeconds(20))) throw new InvalidDataException("Cloudig loading image is unavailable.");
            TraceVisualAudit("loading-visible");
            if (_layout.VisualAudit is { } loadingAudit && (loadingAudit.Query.Contains("interaction=timezone", StringComparison.Ordinal) || loadingAudit.Query.Contains("interaction=startup", StringComparison.Ordinal)))
            {
                // Capture the loading page before Library recovery starts,
                // without delaying any ordinary launch.
                await Task.Delay(600);
                var loadingFile = Path.ChangeExtension(loadingAudit.OutputFile, ".loading.png");
                Directory.CreateDirectory(Path.GetDirectoryName(loadingFile)!);
                await using var loadingOutput = File.Create(loadingFile);
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, loadingOutput);
                if (loadingAudit.Query.Contains("interaction=startup", StringComparison.Ordinal)
                    && (StartupLoading.Visibility != Visibility.Collapsed || WebView.Visibility != Visibility.Visible || _startupSun is not null))
                    throw new InvalidDataException("The startup GIF did not hand off from native to WebView.");
            }
            await InitializeLibraryAsync();
            _libraryReady.TrySetResult(true);
        }
        catch (Exception error)
        {
            _libraryReady.TrySetResult(false);
            if (_closing || _resourcesClosed) return;
            TraceVisualAudit("startup-failed", $"{error.GetType().Name}: {error.Message}");
            if (_layout.VisualAudit is { } failedAudit)
            {
                await File.WriteAllTextAsync(Path.ChangeExtension(failedAudit.OutputFile, ".error.txt"), error.ToString());
                Environment.ExitCode = 1; await ShutdownResourcesAsync(); _closeAllowed = true; Close(); return;
            }
            StartupFailureText.Text = error is CloudigStorageException or CloudigLibraryStartupException ? error.Message : "采云暂时无法启动本地界面。请确认程序文件完整；已有资料不会自动迁移或覆盖。";
            StartupFailure.Visibility = Visibility.Visible;
            StopStartupSun();
            WebView.Visibility = Visibility.Collapsed;
        }
        finally { _startupFinished.TrySetResult(); }
    }

    private async Task PrepareEngineAsync()
    {
        var libraryRoot = _layout.LibraryRoot;
        _libraryRoot = libraryRoot;
        if (libraryRoot is not null && File.Exists(_layout.NodeExecutable) && File.Exists(_layout.EngineScript))
        {
            Directory.CreateDirectory(libraryRoot);
            TraceVisualAudit("engine-starting");
            _engine = await EngineJsonlClient.StartAsync(_layout.NodeExecutable, _layout.EngineScript, libraryRoot, cacheRoot: _layout.CacheRoot);
            TraceVisualAudit("engine-started");
        }
    }

    private async Task InitializeLibraryAsync()
    {
        var initialTheme = "dawn";
        if (_libraryRoot is { } libraryRoot && _engine is not null)
        {
            var recovered = await RecordStartupBoundary.InitializeAsync((command, payload, cancellation) => _engine.SendAsync(command, payload, cancellation), operation =>
            {
                var answer = MessageBox.Show(this, $"上次保存尚未完成，原文件与恢复材料均已保留。\n\n是：继续完成保存\n否：恢复到修改前\n取消：暂不读写资料库\n\n操作：{operation}", "采云 Cloudig · 处理未完成保存", MessageBoxButton.YesNoCancel, MessageBoxImage.Question, MessageBoxResult.Cancel);
                return Task.FromResult(answer == MessageBoxResult.Yes ? RecordRecoveryChoice.Complete : answer == MessageBoxResult.No ? RecordRecoveryChoice.Rollback : RecordRecoveryChoice.Cancel);
            }, confirmRestoreSettings: () => Task.FromResult(MessageBox.Show(this,
                "这里已有资料，但 CloudigLibrary.json 设置文件缺失。是否恢复默认设置？\n\n只重建设置文件，不改头像与昵称、时间节点、Mark 或会话。语言、主题、排序和解析选项将恢复默认。\n\nRestore default settings only? Existing identity, time, Mark and Conversation records will not be changed.",
                "采云 Cloudig · 恢复设置", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) == MessageBoxResult.Yes));
            TraceVisualAudit("library-ready", "valid");
              var preferences = await _engine.SendAsync("library.preferences.query", Json("{}"));
              if (preferences.TryGetProperty("theme", out var theme) && theme.GetString() == "star-night") initialTheme = "star-night";
              await ResolvePendingRecyclesAsync(recovered, preferences.TryGetProperty("language", out var language) && language.GetString() == "en");
        }
        ApplySurface(initialTheme, "welcome");
    }

    private async void OnVisualAuditNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_visualAuditStarted || _layout.VisualAudit is not { } audit) return;
        _visualAuditStarted = true;
        TraceVisualAudit("navigation-completed", $"success={e.IsSuccess};status={e.WebErrorStatus}");
        try
        {
            if (!e.IsSuccess) throw new InvalidDataException($"Visual audit navigation failed: {e.WebErrorStatus}.");
            await MatchVisualAuditViewportAsync(audit);
            VerifyNativeWindowBounds(audit);
            var facts = await WaitForVisualAuditReadyAsync(audit);
            if (audit.Query.Contains("resize=roundtrip", StringComparison.Ordinal))
            {
                await VerifyViewportRoundtripAsync(audit);
                facts = await WaitForVisualAuditReadyAsync(audit);
            }
            var auditTheme = facts.GetProperty("theme").GetString() ?? throw new InvalidDataException("Visual audit theme is missing.");
            var auditSurface = facts.GetProperty("surface").GetString() ?? throw new InvalidDataException("Visual audit surface is missing.");
            ApplySurface(auditTheme, auditSurface);
            await Dispatcher.Yield(DispatcherPriority.Render);
            TraceVisualAudit("page-ready");
            if (audit.Query.Contains("interaction=navigation-performance", StringComparison.Ordinal)) await VerifyNavigationPerformanceAsync(audit);
            if (audit.MoveTarget is not null) { await VerifyLibraryMoveAuditAsync(audit); return; }
            if (audit.Query.Contains("interaction=search-copy", StringComparison.Ordinal))
                await VerifySearchCopyAsync(audit);
            if (audit.Query.Contains("interaction=docs-navigation", StringComparison.Ordinal))
                await VerifyDocumentNavigationHoverAsync();
            if (audit.Query.Contains("interaction=author-contact", StringComparison.Ordinal))
                await VerifyAuthorContactAsync();
            if (audit.Query.Contains("interaction=update-check", StringComparison.Ordinal))
                await VerifyUpdateCheckAsync(audit);
            if (audit.Query.Contains("interaction=english-layout", StringComparison.Ordinal))
                await VerifyEnglishLayoutAsync(audit);
            if (audit.Query.Contains("interaction=standard-document", StringComparison.Ordinal))
                await VerifyStandardDocumentAsync(audit);
            if (audit.Query.Contains("interaction=document-refinements", StringComparison.Ordinal))
                await VerifyDocumentRefinementsAsync(audit);
            if (audit.Query.Contains("interaction=history-document", StringComparison.Ordinal))
                await VerifyHistoryDocumentAsync(audit);
            if (audit.Query.Contains("interaction=feature-guide-capture", StringComparison.Ordinal))
                await VerifyFeatureGuideCaptureAsync(audit);
            if (audit.Query.Contains("interaction=features-document", StringComparison.Ordinal))
                await VerifyFeaturesDocumentAsync(audit);
            if (audit.Query.Contains("interaction=license-document", StringComparison.Ordinal))
                await VerifyLicenseDocumentAsync(audit);
            if (audit.Query.Contains("interaction=bookmark-document", StringComparison.Ordinal))
                await VerifyBookmarkDocumentAsync(audit);
            if (audit.Query.Contains("interaction=bookmark-install", StringComparison.Ordinal))
                await VerifyBookmarkInstallAsync(audit);
            if (audit.Query.Contains("interaction=reader-row-menu", StringComparison.Ordinal))
                await VerifyReaderMenuAsync();
            if (audit.Query.Contains("interaction=reader-catalog-open", StringComparison.Ordinal))
                await VerifyReaderCatalogOpenAsync(audit);
            if (audit.Query.Contains("interaction=platform-json", StringComparison.Ordinal))
                await VerifyPlatformJsonAsync(audit);
            if (audit.Query.Contains("interaction=archive-splitter", StringComparison.Ordinal))
                await CaptureArchiverSplitterAsync(audit);
            if (audit.Query.Contains("interaction=workflow-normal", StringComparison.Ordinal))
                await VerifyArchiverWorkflowPaintAsync(audit);
            if (audit.Query.Contains("interaction=missing-records", StringComparison.Ordinal))
                await VerifyMissingSourceRecordsAsync(audit);
            if (audit.Query.Contains("interaction=source-capture-time", StringComparison.Ordinal))
                await VerifySourceCaptureTimeAsync(audit);
            if (audit.Query.Contains("interaction=archive-column-alignment", StringComparison.Ordinal))
                await VerifyArchiveColumnAlignmentAsync(audit);
            if (audit.Query.Contains("interaction=title-hover", StringComparison.Ordinal))
                await VerifyOverflowTextAsync(audit);
            if (audit.Query.Contains("interaction=external-refresh", StringComparison.Ordinal))
                await VerifyExternalArchiveRefreshAsync(audit);
            if (audit.Query.Contains("interaction=batch-delete", StringComparison.Ordinal))
                await VerifyBatchArchiveDeleteAsync(audit);
            if (audit.Query.Contains("interaction=parse-batch", StringComparison.Ordinal))
                await VerifyParseBatchAsync(audit);
            if (audit.Query.Contains("fixture=real", StringComparison.Ordinal) && audit.Query.Contains("interaction=archive-information", StringComparison.Ordinal))
                await VerifyArchiveInformationAsync(audit);
            if (audit.Query.Contains("fixture=real", StringComparison.Ordinal) && audit.Query.Contains("route=conversation-info", StringComparison.Ordinal))
            {
                var unset = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-conversation-time-display]')?.textContent.includes(document.documentElement.lang === 'en' ? 'Time covered by the content' : '内容覆盖的时间') && !document.querySelector('[data-conversation-time-inherit]')");
                if (unset != "true") throw new InvalidDataException("A new real archive did not open with unset Content Time.");
                var actionReadable = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const b=document.querySelector('[data-conversation-time-open]');return b.textContent.trim().length>0&&getComputedStyle(b).color===(document.documentElement.dataset.theme==='star-night'?'rgb(255, 169, 46)':'rgb(255, 255, 255)');})()");
                if (actionReadable != "true") throw new InvalidDataException("The remaining filled timeline action lost its theme text color.");
                TraceVisualAudit("content-time-unset-passed");
            }
            if (audit.Query.Contains("fixture=real", StringComparison.Ordinal) && audit.Query.TrimStart('?').Split('&').Contains("route=conversation", StringComparer.Ordinal))
            {
                if (audit.Query.Contains("interaction=summary-sequences", StringComparison.Ordinal)) await VerifySummarySequencesAsync(audit);
                else if (audit.Query.Contains("interaction=saved-cards", StringComparison.Ordinal)) await VerifySavedCardsAsync(audit);
                else if (audit.Query.Contains("interaction=saved-works", StringComparison.Ordinal)) await VerifySavedWorksAsync(audit);
                else if (audit.Query.Contains("interaction=saved-map", StringComparison.Ordinal)) await VerifySavedMapAsync(audit);
                else if (audit.Query.Contains("interaction=schedule-cards", StringComparison.Ordinal)) await VerifyScheduleCardsAsync(audit);
                else if (audit.Query.Contains("interaction=branch-only", StringComparison.Ordinal)) await VerifyReaderBranchRoundtripAsync(audit);
                else await VerifyReaderResourceScrollAsync(audit);
                if (audit.Query.Contains("interaction=nested-process", StringComparison.Ordinal)) await VerifyNestedProcessAsync(audit);
                if (audit.Query.Contains("claude-context=1", StringComparison.Ordinal)) await VerifyClaudeContextAsync(audit);
                if (audit.Query.Contains("source-empty=1", StringComparison.Ordinal)) await VerifyEmptySourceAsync(false);
            }
            if (audit.Query.Contains("claude-empty-source=1", StringComparison.Ordinal)) await VerifyEmptySourceAsync(true);
            if (audit.Query.Contains("parser-status=1", StringComparison.Ordinal)) await VerifyParserStatusAsync(audit);
            if (audit.Query.Contains("index-reopen=1", StringComparison.Ordinal)) await VerifyContainerReopenAsync(audit);
            if (audit.Query.Contains("interaction=claude-settings", StringComparison.Ordinal))
            {
                await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-claude-row]')?.click();document.querySelector('[data-claude-settings]').click();");
                await Task.Delay(180);
            }
            if (audit.Query.Contains("interaction=time-save", StringComparison.Ordinal)) await VerifyTimeSaveRoundtripAsync(audit);
            if (audit.Query.Contains("interaction=identity-save", StringComparison.Ordinal)) await VerifyIdentitySaveRoundtripAsync(audit);
            if (audit.Query.Contains("interaction=time-compatibility", StringComparison.Ordinal)) await VerifyTimeCompatibilityAsync(audit);
            if (audit.Query.Contains("interaction=record-compatibility", StringComparison.Ordinal)) await VerifyRecordCompatibilityAsync(audit);
            if (audit.Query.Contains("interaction=claude-parse", StringComparison.Ordinal)) await VerifyClaudeParseRoundtripAsync(audit);
            if (audit.Query.Contains("interaction=parse-destination", StringComparison.Ordinal) || audit.Query.Contains("interaction=parse-settings-directory", StringComparison.Ordinal)) await VerifyParseDestinationAsync(audit);
            if (audit.Query.Contains("interaction=timezone", StringComparison.Ordinal)) await VerifyTimeZonePickerAsync(audit);
            if (audit.Query.Contains("interaction=info-endpoints", StringComparison.Ordinal)) await VerifyConversationEndpointStripAsync(audit);
            if (audit.Query.Contains("interaction=info-modal", StringComparison.Ordinal)) await VerifyConversationModalAsync(audit);
            await VerifyIdentityNameGeometryAsync();
            // Report the state actually captured below, after native audit
            // interactions (settings/branch switches), not the initial page.
            facts = await WaitForVisualAuditReadyAsync(audit);
            // A real interaction may have left the initial page. Verify the
            // actual native brush before reporting its final surface, rather
            // than labelling a Reader caption with the initial Welcome name.
            auditTheme = facts.GetProperty("theme").GetString()!;
            auditSurface = facts.GetProperty("surface").GetString()!;
            var expectedCaption = WindowSurfaceStyles.Resolve(auditTheme, auditSurface);
            if (TitleBar.Background is not LinearGradientBrush actualCaption
                || actualCaption.GradientStops.Count != expectedCaption.Stops.Count
                || !actualCaption.GradientStops.Select((stop,index) => stop.Color == MediaColor(expectedCaption.Stops[index].Color)
                    && Math.Abs(stop.Offset - expectedCaption.Stops[index].Offset) < .000001).All(match => match))
                throw new InvalidDataException("Native caption does not match the final page and theme.");
            var directory = Path.GetDirectoryName(audit.OutputFile) ?? throw new InvalidDataException("Visual audit output directory is invalid.");
            Directory.CreateDirectory(directory);
            await using (var output = new FileStream(audit.OutputFile, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous))
            {
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
                await output.FlushAsync();
            }
            var bytes = await File.ReadAllBytesAsync(audit.OutputFile);
            if (bytes.Length < 24 || !bytes.AsSpan(1, 3).SequenceEqual("PNG"u8)) throw new InvalidDataException("Visual audit did not produce a PNG image.");
            var pixelWidth = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(16, 4));
            var pixelHeight = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(20, 4));
            var dpi = VisualTreeHelper.GetDpi(WebView);
            var titleBarFile = Path.Combine(directory, $"{Path.GetFileNameWithoutExtension(audit.OutputFile)}.titlebar.png");
            var titleBarBytes = CaptureTitleBarPng();
            await File.WriteAllBytesAsync(titleBarFile, titleBarBytes);
            var manifest = new
            {
                schema = "cloudig/visual-audit-run/1.0.0",
                captured_at = DateTimeOffset.UtcNow.ToString("O"),
                executable = new
                {
                    pid = Environment.ProcessId,
                    name = Path.GetFileName(Environment.ProcessPath),
                    sha256 = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(Environment.ProcessPath!))).ToLowerInvariant()
                },
                query = audit.Query,
                requested_viewport = new { width = audit.Width, height = audit.Height },
                viewport_scale = WebView.ZoomFactor,
                png = new
                {
                    file = Path.GetFileName(audit.OutputFile),
                    bytes = bytes.Length,
                    sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                    pixel_width = pixelWidth,
                    pixel_height = pixelHeight,
                    dpi_scale_x = dpi.DpiScaleX,
                    dpi_scale_y = dpi.DpiScaleY
                },
                titlebar = new
                {
                    file = Path.GetFileName(titleBarFile),
                    bytes = titleBarBytes.Length,
                    sha256 = Convert.ToHexString(SHA256.HashData(titleBarBytes)).ToLowerInvariant(),
                    surface = auditSurface,
                    theme = auditTheme
                },
                page = facts
            };
            await File.WriteAllTextAsync(
                Path.ChangeExtension(audit.OutputFile, ".json"),
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }) + "\n",
                new UTF8Encoding(false));
            if (audit.Query.Contains("motion=rooster", StringComparison.Ordinal) && auditTheme == "dawn")
                await CaptureRoosterMotionAsync(audit, facts);
            TraceVisualAudit("capture-complete");
            await ShutdownResourcesAsync();
            _closeAllowed = true;
            Close();
        }
        catch (Exception error)
        {
            TraceVisualAudit("capture-failed", $"{error.GetType().Name}: {error.Message}");
            try
            {
                var errorFile = Path.ChangeExtension(audit.OutputFile, ".error.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(errorFile)!);
                await File.WriteAllTextAsync(errorFile, $"{error.GetType().Name}: {error.Message}\n", new UTF8Encoding(false));
            }
            catch
            {
                // The explicit audit command reports failure through the process exit code as a final fallback.
            }
            Environment.ExitCode = 1;
            await ShutdownResourcesAsync();
            _closeAllowed = true;
            Close();
        }
    }

    private async Task VerifyIdentityNameGeometryAsync()
    {
        var result = await WebView.CoreWebView2.ExecuteScriptAsync("""
          (() => {
            for(const node of document.querySelectorAll('.welcome-identity-name, .reader-scene-identity strong')) {
              if(!node.getBoundingClientRect().width) continue;
              const original=node.textContent, party=node.dataset.identityName;
              try {
                node.textContent='短名'; let r=node.getBoundingClientRect(), a=node.parentElement.getBoundingClientRect();
                if(Math.abs((r.left+r.right-a.left-a.right)/2)>1) return false;
                node.textContent='This is a deliberately long display name'; r=node.getBoundingClientRect();
                if(Math.abs(party==='user' ? r.right-a.right : r.left-a.left)>1) return false;
              } finally { node.textContent=original; }
            } return true;
          })()
          """);
        if(result != "true") throw new InvalidOperationException("Cover identity names do not center short text or outward-align overflow.");
    }

    private async Task VerifyClaudeContextAsync(VisualAuditOptions audit)
    {
        async Task Click(string selector)
        {
            var point = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (point == "null") throw new InvalidDataException($"Claude context control is obstructed: {selector}");
            using var p=JsonDocument.Parse(point); var x=p.RootElement.GetProperty("x").GetDouble();var y=p.RootElement.GetProperty("y").GetDouble();
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
            await Task.Delay(180);
        }
        var setup=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const all=[...document.querySelectorAll('.cloudig-platform-context')],n=all.find(n=>/date context|日期提示/.test(n.querySelector('summary')?.textContent))??all[0],avatar=n?.closest('.cloudig-message-system')?.querySelector('.cloudig-system-avatar img');if(!n||n.open||!avatar?.complete||!avatar.naturalWidth||n.closest('.cloudig-message-user,.cloudig-message-assistant'))return null;n.dataset.contextProbe='';const g=n.closest('.cloudig-platform-context-group');if(g)g.dataset.contextGroupProbe='';return {group:!!g,avatar:true};})()");
        if(setup=="null")throw new InvalidDataException("Claude platform context missing or expanded by default");
        using var setupJson=JsonDocument.Parse(setup);var grouped=setupJson.RootElement.GetProperty("group").GetBoolean();
        if(grouped)await Click("[data-context-group-probe]>summary");
        await Click("[data-context-probe]>summary");
        var facts=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('[data-context-probe]'),p=n.querySelector('.cloudig-text'),gap=p?p.getBoundingClientRect().top-n.querySelector('summary').getBoundingClientRect().bottom:null;return {open:n.open,text:!!p&&p.textContent.length>0,lines:!!p&&p.textContent.includes('\\n'),inert:!!p&&p.childElementCount===0,compact:!!p&&gap>=0&&gap<=9&&!/^[ \\t]*[\\r\\n]/.test(p.textContent),gap,sourceNoticeHidden:document.querySelector('[data-reader-source-notice]')?.hidden===true,transport:!!p&&p.textContent.trimStart().startsWith('{\"type\":\"injected_prompt_block\"')};})()");
        using(var f=JsonDocument.Parse(facts)){
            var r=f.RootElement;if(!r.GetProperty("open").GetBoolean()||!r.GetProperty("text").GetBoolean()||!r.GetProperty("compact").GetBoolean()||!r.GetProperty("sourceNoticeHidden").GetBoolean()||!r.GetProperty("inert").GetBoolean()||r.GetProperty("transport").GetBoolean())throw new InvalidDataException($"Claude context disclosure failed: {facts}");
        }
        await using(var image=File.Create(Path.ChangeExtension(audit.OutputFile,".context-open.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
        await Click("[data-context-probe]>summary");if(grouped)await Click("[data-context-group-probe]>summary");
        TraceVisualAudit("claude-context-pointer-passed",facts);
    }

    private async Task VerifyNavigationPerformanceAsync(VisualAuditOptions audit)
    {
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal)) throw new InvalidDataException("Navigation performance requires an owned Library.");
        var resources = await WebView.CoreWebView2.ExecuteScriptAsync("JSON.stringify(performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration,start:r.startTime,size:r.transferSize})))");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".resources.json"),JsonSerializer.Deserialize<string>(resources));
        for (var i=0; i<100 && await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.route-transition').hidden")!="true"; i++) await Task.Delay(30);
        var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const n=document.querySelector('.welcome-archiver-button'),r=n?.getBoundingClientRect();if(!r||!n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))return null;return {x:r.left+r.width/2,y:r.top+r.height/2};})()
            """);
        if (raw == "null") throw new InvalidDataException("Welcome Archiver target is not reachable.");
        using var point = JsonDocument.Parse(raw);
        var clock = Stopwatch.StartNew();
        foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
        while (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('[data-page=archiver]')&&document.querySelector('.route-transition').hidden)") != "true")
        {
            if (clock.Elapsed > TimeSpan.FromSeconds(45)) throw new TimeoutException("Welcome to Archiver did not settle.");
            await Task.Delay(30);
        }
        var elapsed = clock.ElapsedMilliseconds;
        var icons = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>[...document.querySelectorAll('.archiver-source-row')].map(row=>{const marker=row.querySelector('.archiver-row-marker');return {platform:marker.dataset.platform,icon:marker.querySelector('.archiver-row-platform').getAttribute('src')};}))()
            """);
        using (var values=JsonDocument.Parse(icons)) foreach (var value in values.RootElement.EnumerateArray())
        {
            var platform=value.GetProperty("platform").GetString();
            if (!string.IsNullOrEmpty(platform) && !value.GetProperty("icon").GetString()!.Contains("platform-"+platform+".",StringComparison.Ordinal)) throw new InvalidDataException("Source row uses another platform's icon.");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".navigation.json"),JsonSerializer.Serialize(new { welcome_to_archiver_ms=elapsed, real_pointer=true, chrome_query_read_only=true, source_icons=JsonSerializer.Deserialize<JsonElement>(icons) },new JsonSerializerOptions { WriteIndented=true }));
        TraceVisualAudit("welcome-to-archiver-passed",$"elapsed_ms={elapsed}");
    }

    private async Task VerifyParserStatusAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (_libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Parser status audit needs its own Library.");
        var source = Directory.GetFiles(Path.Combine(library, "Inbox")).Single(); var sourceHash = SHA256.HashData(File.ReadAllBytes(source));
        var idsBefore = Directory.GetFiles(Path.Combine(library, "Conversations"), "*.json").Select(file => { using var d=JsonDocument.Parse(File.ReadAllText(file)); return d.RootElement.GetProperty("conversation_id").GetString(); }).Order().ToArray();
        async Task Wait(string condition)
        {
            for (var i=0;i<300;i++) { if(await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({condition})")=="true")return; await Task.Delay(50); }
            throw new InvalidDataException("Parser status did not settle: " + condition);
        }
        async Task Click(string selector)
        {
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """);
            if(raw=="null")throw new InvalidDataException("Parser status target obstructed: "+selector);
            using var p=JsonDocument.Parse(raw);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type,x=p.RootElement.GetProperty("x").GetDouble(),y=p.RootElement.GetProperty("y").GetDouble(),button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
        }
        await Wait("document.querySelector('[data-claude-status=update]').textContent.endsWith(' 1')");
        var geometry=await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{
              const toolbar=document.querySelector('.archiver-claude-toolbar'),bounds=toolbar.getBoundingClientRect();
              const buttons=[...toolbar.querySelectorAll('[data-claude-status]')],rects=buttons.map(n=>n.getBoundingClientRect()),nav=buttons[0].parentElement.getBoundingClientRect();
              const controls=[...toolbar.children].map(n=>n.getBoundingClientRect()).filter(r=>r.width&&r.height);
              const apart=(a,b)=>a.right<=b.left-1||b.right<=a.left-1||a.bottom<=b.top-1||b.bottom<=a.top-1;
              const inside=r=>r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;
              return {fits:buttons.length===5&&controls.every((r,i)=>inside(r)&&controls.slice(0,i).every(p=>apart(r,p)))
                &&rects.every((r,i)=>r.width>0&&r.left>=nav.left-1&&r.right<=nav.right+1&&r.top>=nav.top-1&&r.bottom<=nav.bottom+1&&rects.slice(0,i).every(p=>apart(r,p))),
                labels:buttons.map(n=>n.textContent),rows:new Set(controls.map(r=>Math.round(r.top))).size};
            })()
            """);
        using(var g=JsonDocument.Parse(geometry))if(!g.RootElement.GetProperty("fits").GetBoolean())throw new InvalidDataException("Parser status toolbar overlaps: "+geometry);
        await Click("[data-claude-status=update]");
        await Wait("document.querySelectorAll('[data-claude-row]').length===1&&document.querySelector('[data-claude-row]').dataset.status==='update'");
        await using(var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".updates.png")))await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
        await Click("[data-claude-extract]"); await Wait("!!document.querySelector('.cloudig-dialog')");
        await Click(".cloudig-dialog footer .cloudig-button-filled");
        await Wait("document.querySelector('[data-claude-status=update]').textContent.endsWith(' 0')&&document.querySelectorAll('[data-claude-row]').length===0");
        await Click("[data-claude-status=parsed]");
        await Wait("document.querySelectorAll('[data-claude-row]').length===2&&[...document.querySelectorAll('[data-claude-row]')].every(n=>n.dataset.status==='parsed')");
        var idsAfter=Directory.GetFiles(Path.Combine(library,"Conversations"),"*.json").Select(file=>{using var d=JsonDocument.Parse(File.ReadAllText(file));return d.RootElement.GetProperty("conversation_id").GetString();}).Order().ToArray();
        if(!idsBefore.SequenceEqual(idsAfter)||!sourceHash.SequenceEqual(SHA256.HashData(File.ReadAllBytes(source))))throw new InvalidDataException("Status update changed identities or source");
        await Click("[data-claude-status=all]");
        await Wait("document.querySelectorAll('[data-claude-row]').length>2");
        TraceVisualAudit("parser-status-pointer-passed",geometry);
    }

    private async Task VerifyEmptySourceAsync(bool container)
    {
        if (!container)
        {
            var facts = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=document.querySelector('[data-reader-source-notice]'),r=n?.getBoundingClientRect();return {valid:!!n&&!n.hidden&&n.dataset.kind==='source'&&!!n.textContent.trim()&&!document.querySelector('.cloudig-message')&&r.width>200&&r.left>=0&&r.right<=innerWidth,text:n?.textContent};})()");
            using var value = JsonDocument.Parse(facts);
            if (!value.RootElement.GetProperty("valid").GetBoolean()) throw new InvalidDataException("Empty Reader source was not explained: " + facts);
            TraceVisualAudit("reader-empty-source-passed", facts); return;
        }
        var point = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const row=document.querySelector('[data-claude-row][data-source-empty=true]'),note=row?.querySelector('.archiver-claude-empty-note'),b=row?.querySelector('.archiver-claude-select');if(!row||!note||!b)return null;row.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect(),n=note.getBoundingClientRect(),s=note.parentElement.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;row.dataset.emptySourceProbe='';return {x,y,hit:b.contains(document.elementFromPoint(x,y)),fits:n.left>=s.left-1&&n.right<=s.right+1&&n.height>0,text:note.textContent,before:b.getAttribute('aria-pressed')};})()");
        if (point == "null") throw new InvalidDataException("Claude source-empty row was not surfaced");
        using var p = JsonDocument.Parse(point); var r = p.RootElement;
        if (!r.GetProperty("hit").GetBoolean() || !r.GetProperty("fits").GetBoolean()) throw new InvalidDataException("Claude empty-source note/selection is clipped: " + point);
        foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = r.GetProperty("x").GetDouble(), y = r.GetProperty("y").GetDouble(), button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        await Task.Delay(180);
        var selected = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-claude-row][data-source-empty=true] .archiver-claude-select')?.getAttribute('aria-pressed')");
        if (selected != "\"true\"") throw new InvalidDataException("Empty source cannot be selected normally: " + selected);
        TraceVisualAudit("claude-empty-source-pointer-passed", point);
    }

    private async Task VerifyPlatformJsonAsync(VisualAuditOptions audit)
    {
        async Task Check(string expression)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({expression})") != "true")
                throw new InvalidDataException($"Platform JSON preview assertion failed: {expression}");
        }
        async Task Click(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()
                """);
            if (raw == "null") throw new InvalidDataException($"Platform JSON control missing: {selector}");
            using var point = JsonDocument.Parse(raw);
            var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {type="mouseMoved",x,y}));
            await Task.Delay(180);
            await Check($"document.querySelector({JsonSerializer.Serialize(selector)}).contains(document.elementFromPoint({x.ToString(System.Globalization.CultureInfo.InvariantCulture)},{y.ToString(System.Globalization.CultureInfo.InvariantCulture)}))");
            foreach (var type in new[] {"mousePressed", "mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {type,x,y,button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
            await Task.Delay(220);
        }
        await Check("(()=>{const n=[...document.querySelectorAll('.archiver-import-actions>button')],r=n.map(n=>n.getBoundingClientRect());return n.length===3&&r.every(q=>q.width>20&&q.left>=0&&q.right<=innerWidth)&&r.slice(1).every((q,i)=>q.left-r[i].right>=0&&q.left-r[i].right<=10&&Math.abs(q.top+q.height/2-r[i].top-r[i].height/2)<1)&&n.slice(0,2).every(n=>{const t=document.createRange();t.selectNodeContents(n);const r=n.getBoundingClientRect(),q=t.getBoundingClientRect();return q.left>=r.left+4&&q.right<=r.right-4&&q.top>=r.top&&q.bottom<=r.bottom;});})()");
        await Click("[data-archiver-parse-settings]");
        await Check("!document.querySelector('[data-archiver-parse-settings-popover]').hidden");
        await Click("[data-parse-settings-cancel]");
        await using (var capture = File.Create(Path.ChangeExtension(audit.OutputFile, ".toolbar.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, capture);
        var workflowVisible = await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('[data-highlight-source=\"import-claude\"]')?.getBoundingClientRect().width)");
        await Click(workflowVisible == "true" ? "[data-highlight-source=\"import-claude\"]" : "[data-archiver-shell-action=\"import-claude\"]");
        await Check("document.querySelectorAll('[data-json-index] [data-json-platform]').length===11");
        await Check("document.querySelector('.archiver-json-heading h1').textContent===(document.documentElement.lang==='en'?'Import Platform Files':'导入平台文件')");
        await Check("document.querySelectorAll('.archiver-json-groups>section').length===2");
        await Check("(()=>{const b=document.querySelector('[data-json-close]'),r=b.getBoundingClientRect(),t=document.createRange();t.selectNodeContents(b);const q=t.getBoundingClientRect();return q.left>=r.left+12&&q.right<=r.right-12;})()");
        await Check("[...document.querySelectorAll('[data-json-index] img')].every(n=>n.complete&&n.naturalWidth>0)");
        await Check("(()=>{const n=document.querySelector('[data-json-index]'),r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;})()");
        await Check("(()=>{const art=document.querySelector('.archiver-json-desk'),intro=document.querySelector('.archiver-json-intro');return art&&getComputedStyle(art).pointerEvents==='none'&&intro.getBoundingClientRect().right<=art.getBoundingClientRect().left;})()");
        await Check("(()=>{return [...document.querySelectorAll('[data-json-platform]')].every(n=>{const r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth+1&&[...n.querySelectorAll('strong,small,code')].every(t=>{const q=t.getBoundingClientRect();return q.left>=r.left+8&&q.right<=r.right-8&&q.top>=r.top+8&&q.bottom<=r.bottom-8;});});})()");
        await Check("(()=>{return [...document.querySelectorAll('[data-json-help]')].every(h=>{const r=h.getBoundingClientRect(),t=document.createRange();t.selectNodeContents(h.parentElement.querySelector('strong'));return r.left>=t.getBoundingClientRect().right&&r.width>=28&&r.height>=28;});})()");
        await using (var capture = File.Create(Path.ChangeExtension(audit.OutputFile, ".entry.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, capture);
        if (audit.Query.Contains("json-guide=true", StringComparison.Ordinal)) { await VerifyPlatformImportGuideAsync(audit); return; }
        if (audit.Query.Contains("source-picker=true", StringComparison.Ordinal))
        {
            foreach (var sourcePlatform in new[] { "chatgpt", "claude" })
            {
                var title = sourcePlatform == "chatgpt" ? "选择完整官方 ZIP，无需解压 / Select official ZIP exports" : "选择平台 JSON / Import Platform JSON";
                var owner = new System.Windows.Interop.WindowInteropHelper(this).Handle;
                var shown = NativeSourcePickerAudit.ObserveAndCancelAsync(owner, title);
                await Task.WhenAll(Click($"[data-json-platform=\"{sourcePlatform}\"]"), shown);
                TraceVisualAudit("source-picker-native-passed", JsonSerializer.Serialize(new { platform = sourcePlatform, dialog = shown.Result, cancelled = true }));
                await Check("!document.querySelector('[data-json-index]')&&!document.querySelector('.cloudig-dialog')");
                await Click("[data-archiver-shell-action=\"import-claude\"]");
            }
            TraceVisualAudit("platform-json-pointer-passed", "native ZIP and JSON pickers opened from actual cards, then cancelled");
            return;
        }
        var platform = System.Web.HttpUtility.ParseQueryString(audit.Query.TrimStart('?'))["json-platform"] ?? "index";
        var selectedPlatform = platform == "index" ? "codex" : platform;
        await Check($"document.querySelector('[data-json-platform=\"{selectedPlatform}\"]')!==null");
        TraceVisualAudit("platform-json-pointer-passed", JsonSerializer.Serialize(new { platform, agent_sources_available = true, official_preview_removed = true }));
    }

    private async Task VerifyReaderCatalogOpenAsync(VisualAuditOptions audit)
    {
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (() => {
                    const node=document.querySelector({{JsonSerializer.Serialize(selector)}});
                    if(!node || node.disabled) return null;
                    const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                    return {x,y};
                })()
                """);
            if (raw == "null") throw new InvalidDataException($"Reader journey control is missing or obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new
            {
                type="mouseMoved", x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble()
            }));
            // The collapsed rail deliberately reveals its handle on hover.
            await Task.Delay(80);
            var reachable = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const node=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()
                """);
            if (reachable != "true") throw new InvalidDataException($"Reader journey control is obstructed after hover: {selector}");
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new
                {
                    type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(),
                    button="left", buttons=type=="mousePressed"?1:0, clickCount=1
                }));
        }
        async Task WaitAsync(string condition)
        {
            for (var attempt=0; attempt<200; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({condition})") == "true") return;
                if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-dialog')?.textContent ?? null") is { } error && error != "null")
                    throw new InvalidDataException($"Reader catalog journey showed an error: {error}");
                await Task.Delay(50);
            }
            var stage = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.readerOpenStage ?? null");
            throw new TimeoutException($"Reader catalog journey did not finish; stage={stage}");
        }
        var timings = new List<double>();
        for (var round=0; round<2; round++)
        {
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'") == "true")
                await ClickAsync("[data-reader-catalog-toggle=expand]");
            var capability = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.reader-row-open')?.dataset.archiveCapability ?? null");
            if (capability == "null") throw new InvalidDataException("The real Reader catalog is empty");
            var started = Stopwatch.GetTimestamp();
            await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{window.__cloudigOpening=[];window.__cloudigOpeningObserver?.disconnect();window.__cloudigOpeningObserver=new MutationObserver(()=>{const title=document.querySelector('[data-reader-conversation-title]'),loading=document.querySelector('.reader-conversation-loading');if(title&&loading&&!loading.hidden)window.__cloudigOpening.push({title:title.textContent,insideMessages:Boolean(loading.closest('[data-reader-conversation-scroll]')),busy:document.querySelector('[data-reader-conversation-main]')?.getAttribute('aria-busy')});});window.__cloudigOpeningObserver.observe(document.querySelector('.app-root'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','aria-busy']});})()");
            await ClickAsync(".reader-row-open");
            await WaitAsync($"document.querySelector('.app-root').dataset.route === 'reader/conversation/' + {capability} && document.querySelector('[data-page=reader]').dataset.conversationReady === 'true' && document.querySelectorAll('.cloudig-message').length > 0");
            timings.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            var loadingEvidence = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{window.__cloudigOpeningObserver.disconnect();const seen=window.__cloudigOpening;return {seen:seen.length,valid:seen.length>0&&seen.every(x=>x.title&&x.insideMessages&&x.busy==='true'),first:seen[0]};})()");
            using (var loading = JsonDocument.Parse(loadingEvidence))
                if (!loading.RootElement.GetProperty("valid").GetBoolean()) throw new InvalidDataException($"Reader did not publish a title and message-local progress before loading: {loadingEvidence}");
            TraceVisualAudit("reader-opening-progress", loadingEvidence);
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.route-transition').hidden") != "true")
                throw new InvalidDataException("Opening a catalog row displayed the full-page loading transition");
            // Measure a painted layout, not the IPC-complete microtask before
            // the title's ResizeObserver/requestAnimationFrame alignment runs.
            await WebView.CoreWebView2.ExecuteScriptAsync("window.__cloudigReadingFrameReady=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__cloudigReadingFrameReady=true;}));");
            await WaitAsync("window.__cloudigReadingFrameReady === true");
            var readingBounds = await WebView.CoreWebView2.ExecuteScriptAsync("""
                (() => {
                    const page=document.querySelector('[data-page=reader]'),main=page.querySelector('.reader-main').getBoundingClientRect(),catalog=page.querySelector('.reader-catalog').getBoundingClientRect();
                    const boxes=['.reader-conversation-summary-row','[data-reader-conversation-title]','.reader-current-search','.reader-message-column'].map(selector=>{
                        const r=page.querySelector(selector).getBoundingClientRect();return {selector,left:r.left,right:r.right,inside:r.left>=main.left-.5&&r.right<=main.right+.5};
                    });
                    const identity=page.querySelector('.cloudig-message-identity'),r=identity?.getBoundingClientRect();
                    const visible=!!r&&r.height>0&&identity.contains(document.elementFromPoint(r.left+Math.min(8,r.width/2),r.top+r.height/2));
                    return {valid:catalog.right<=main.left+.5&&boxes.every(b=>b.inside)&&visible,overlay:page.dataset.catalogOverlay,collapsed:page.dataset.catalogCollapsed,boxes,visible};
                })()
                """);
            using (var bounds = JsonDocument.Parse(readingBounds))
                if (!bounds.RootElement.GetProperty("valid").GetBoolean()) throw new InvalidDataException($"Reader content is covered or outside its reading column: {readingBounds}");
            TraceVisualAudit("reader-reading-bounds", readingBounds);
            if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-inert-html [data-audit-witness=inert-record]'))") == "true")
            {
                var before = await WebView.CoreWebView2.ExecuteScriptAsync("[document.documentElement.dataset.theme,document.querySelector('.app-root').dataset.route]");
                await ClickAsync(".cloudig-inert-html [data-cloudig-inert=button]");
                var after = await WebView.CoreWebView2.ExecuteScriptAsync("[document.documentElement.dataset.theme,document.querySelector('.app-root').dataset.route]");
                if (before != after || await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-inert-html button,.cloudig-inert-html iframe,.cloudig-inert-html script,.cloudig-inert-html [onclick]'))") != "false")
                    throw new InvalidDataException("Imported HTML participated in application controls");
                if (await WebView.CoreWebView2.ExecuteScriptAsync("[...document.querySelectorAll('[data-audit-witness=inert-record] [data-cloudig-inert=input]')].map(n=>n.textContent).join('')==='☑☐'") != "true")
                    throw new InvalidDataException("Authored task-list state was lost");
                TraceVisualAudit("reader-inert-record-passed", after);
            }
            if (round == 0)
            {
                await ClickAsync(".reader-manage-archives");
                await WaitAsync("document.querySelector('.app-root').dataset.route === 'archiver' && document.querySelector('.route-transition').hidden");
                await ClickAsync(".archiver-start-reader");
                await WaitAsync("document.querySelector('.app-root').dataset.route === 'reader/cover' && document.querySelector('.route-transition').hidden");
            }
        }
        TraceVisualAudit("reader-catalog-open-passed", JsonSerializer.Serialize(new { native_clicks=2, archiver_roundtrip=true, open_ms=timings }));
        // Owned inline-image fixture: keep real resource resolution, native
        // disclosure clicks and its painted pixels together in one package.
        if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('[data-audit-inline-images]'))") == "true")
        {
            await WaitAsync("[...document.querySelectorAll('[data-audit-inline-images] img,li .cloudig-inline-resource img')].length===2 && [...document.querySelectorAll('[data-audit-inline-images] img,li .cloudig-inline-resource img')].every(i=>i.complete&&i.naturalWidth===160)");
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('td:has(.cloudig-inline-resource)').textContent === 'BeforeAfter'") != "true")
                throw new InvalidDataException("Inline image split its table cell");
            await using (var preview = File.Create(Path.ChangeExtension(audit.OutputFile, ".inline-table-list.png")))
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, preview);
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-reasoning > summary').scrollIntoView({block:'center'});");
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-reasoning').open") != "false")
                throw new InvalidDataException("Nested reasoning was not initially folded");
            await ClickAsync(".cloudig-reasoning > summary");
            await WaitAsync("Boolean(document.querySelector('.cloudig-nested-process > summary'))");
            await ClickAsync(".cloudig-nested-process > summary");
            await WaitAsync("document.querySelector('[data-audit-inline-nested] img')?.complete && document.querySelector('[data-audit-inline-nested] img')?.naturalWidth===160");
            var inlineFacts = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>({cell:document.querySelector('td:has(img)').textContent,images:[...document.querySelectorAll('.cloudig-inline-resource img')].map(i=>({width:i.naturalWidth,height:i.naturalHeight,source:i.src.split(':')[0]})),nested:document.querySelector('[data-audit-inline-nested]').textContent,privateTags:document.querySelectorAll('img[data-cloudig-resource]').length,errors:document.querySelectorAll('[data-cloudig-resource-error]').length}))()");
            using (var facts = JsonDocument.Parse(inlineFacts))
                if (facts.RootElement.GetProperty("images").GetArrayLength()!=3 || facts.RootElement.GetProperty("privateTags").GetInt32()!=0 || facts.RootElement.GetProperty("errors").GetInt32()!=0)
                    throw new InvalidDataException($"Inline resource resolution failed: {inlineFacts}");
            TraceVisualAudit("reader-inline-images-passed", inlineFacts);
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".inline-images.json"), inlineFacts);
            await using (var preview = File.Create(Path.ChangeExtension(audit.OutputFile, ".inline-nested.png")))
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, preview);
        }
        if (await WebView.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.cloudig-process-group .cloudig-reasoning'))") == "true")
        {
            var restoreCatalog = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.querySelector('[data-page=reader]');return p.dataset.catalogOverlay==='true'&&p.dataset.catalogCollapsed!=='true';})()") == "true";
            if (restoreCatalog)
                await ClickAsync("[data-reader-catalog-toggle=collapse]");
            await ClickAsync(".cloudig-process-group > summary");
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-process-group .cloudig-reasoning').open") != "true")
                await ClickAsync(".cloudig-process-group .cloudig-reasoning > summary");
            await WaitAsync("document.querySelector('.cloudig-process-group .cloudig-reasoning > .cloudig-fold-body')?.textContent.trim().length > 0");
            var processEvidence = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const g=document.querySelector('.cloudig-process-group'),b=g.querySelector('.cloudig-reasoning > .cloudig-fold-body'),list=document.querySelector('.cloudig-message-list'),rail=getComputedStyle(list,'::before'),axisX=list.getBoundingClientRect().left+parseFloat(rail.left)+parseFloat(rail.width)/2;const dots=[...document.querySelectorAll('.cloudig-process')].filter(n=>n.getBoundingClientRect().height>0).map(n=>{const s=getComputedStyle(n,'::before');return n.getBoundingClientRect().left+parseFloat(s.left)+parseFloat(s.width)/2;});return {open:g.open,labels:[...g.querySelectorAll('.cloudig-reasoning > summary')].map(n=>n.textContent),paragraphs:b.querySelectorAll('p').length,lines:b.querySelectorAll('br').length,color:getComputedStyle(b).color,bodyColor:getComputedStyle(document.querySelector('.cloudig-conversation-renderer')).color,navigationLeft:[...document.querySelectorAll('.reader-navigation-copy')].every(n=>getComputedStyle(n).textAlign==='left'),axisX,dots,dotAxisMaxError:Math.max(0,...dots.map(x=>Math.abs(x-axisX)))};})()");
            using (var process = JsonDocument.Parse(processEvidence))
                if (!process.RootElement.GetProperty("navigationLeft").GetBoolean() || process.RootElement.GetProperty("color").GetString() == process.RootElement.GetProperty("bodyColor").GetString()
                    || process.RootElement.GetProperty("dotAxisMaxError").GetDouble() > .1)
                    throw new InvalidDataException($"Reader process/navigation presentation mismatch: {processEvidence}");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".process-presentation.json"), processEvidence);
            await using (var preview = File.Create(Path.ChangeExtension(audit.OutputFile, ".process-expanded.png")))
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, preview);
            await ClickAsync(".cloudig-process-group > summary");
            if (restoreCatalog) await ClickAsync("[data-reader-catalog-toggle=expand]");
        }
    }

    private async Task VerifyReaderMenuAsync()
    {
        var columnsBefore=await WebView.CoreWebView2.ExecuteScriptAsync("['.reader-main','.reader-navigation'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return[r.x,r.y,r.width,r.height]})");
        if(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='true'") == "true")
        {
            var toggleRaw=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('[data-reader-catalog-toggle=expand]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()");
            using var toggle=JsonDocument.Parse(toggleRaw);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {type,x=toggle.RootElement.GetProperty("x").GetDouble(),y=toggle.RootElement.GetProperty("y").GetDouble(),button="left",clickCount=1}));
            await Task.Delay(200);
        }
        var columnsAfter=await WebView.CoreWebView2.ExecuteScriptAsync("['.reader-main','.reader-navigation'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return[r.x,r.y,r.width,r.height]})");
        if(columnsBefore != columnsAfter) throw new InvalidOperationException("Opening the narrow catalog displaced the article or navigation grid column.");
        var raw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.reader-list-row').getBoundingClientRect();return{x:r.left+70,y:r.top+20};})()");
        using var point = JsonDocument.Parse(raw);
        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type="mouseMoved", x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble() }));
        var hover = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.reader-list-row'),p=[...r.querySelectorAll('.reader-row-hover-paper')].filter(n=>getComputedStyle(n).display==='block'),theme=document.documentElement.dataset.theme==='star-night'?'StarNight':'Dawn';return {hover:r.matches(':hover'),paper:p.length===1&&p[0].src.includes(theme),corner:r.querySelector('.reader-row-hover-corner').getBoundingClientRect().width};})()");
        using var hoverFacts = JsonDocument.Parse(hover);
        if(!hoverFacts.RootElement.GetProperty("hover").GetBoolean() || !hoverFacts.RootElement.GetProperty("paper").GetBoolean() || Math.Abs(hoverFacts.RootElement.GetProperty("corner").GetDouble()-40)>.05)
            throw new InvalidOperationException($"Reader hover paper or enlarged corner is missing: {hover}");
        raw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('.reader-row-menu').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()");
        using var menu = JsonDocument.Parse(raw);
        foreach(var type in new[]{"mousePressed","mouseReleased"})
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=menu.RootElement.GetProperty("x").GetDouble(), y=menu.RootElement.GetProperty("y").GetDouble(), button="left", clickCount=1 }));
        var valid = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.querySelector('[data-reader-row-menu-portal]'),r=p.getBoundingClientRect(),buttons=[...p.querySelectorAll('.reader-row-action-panel button')].map(b=>({width:b.clientWidth,scroll:b.scrollWidth,height:b.getBoundingClientRect().height}));return {valid:!p.hidden&&r.top>=-.05&&r.bottom<=innerHeight+.05&&r.left>=-.05&&buttons.length===4&&buttons.every(b=>b.scroll<=b.width+1&&b.height>=23.95),hidden:p.hidden,box:r.toJSON(),buttons};})()");
        using var menuFacts = JsonDocument.Parse(valid);
        if(!menuFacts.RootElement.GetProperty("valid").GetBoolean()) throw new InvalidOperationException($"Reader action menu is clipped or its text is squeezed: {valid}");
        var inset = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.querySelector('.reader-row-action-panel'),r=p.getBoundingClientRect();return Math.abs(r.width-(document.documentElement.lang==='en'?174:120))<.05&&r.height<=210.05&&[...p.querySelectorAll('button svg')].every(s=>s.getBoundingClientRect().left-r.left>=12.95);})()");
        if(inset != "true") throw new InvalidOperationException("Reader action icons have no reliable inset from the paper edge.");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-reader-row-action=move]').click()");
        var destinations = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.querySelector('.reader-row-destination-panel'),r=p.getBoundingClientRect(),portal=document.querySelector('[data-reader-row-menu-portal]').getBoundingClientRect();return !p.hidden&&portal.left>=-.05&&portal.right<=innerWidth+.05&&portal.bottom<=innerHeight+.05&&[...p.querySelectorAll('button')].every(b=>{const text=document.createRange();text.selectNodeContents(b);return text.getBoundingClientRect().left-r.left>=12.95&&b.scrollWidth<=b.clientWidth+1;});})()");
        if(destinations != "true") throw new InvalidOperationException("Reader destination paper clips its text or loses its inset.");
        var binding = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (() => [...document.querySelectorAll('.reader-row-action-panel,.reader-row-destination-panel')].every(panel => {
                const box=panel.getBoundingClientRect(),head=getComputedStyle(panel,'::before'),style=getComputedStyle(panel),first=panel.querySelector('button').getBoundingClientRect();
                return Math.abs(parseFloat(head.height)-27)<.05 && Math.abs(parseFloat(head.backgroundSize.split(/\s+/)[1])-131.91)<.05 && head.zIndex==='1'
                    && Math.abs(parseFloat(style.paddingTop)-31)<.05 && Math.abs(first.top-box.top-31)<.5;
            }))()
            """);
        if(binding != "true") throw new InvalidOperationException("Reader menu binding is squashed or its action rows retain excess top space.");
        TraceVisualAudit("reader-hover-and-menu-passed");
    }

    private async Task CaptureArchiverSplitterAsync(VisualAuditOptions audit)
    {
        var frames = new List<object>();
        foreach (var (name, ratio) in new[] { ("minimum", .1), ("maximum", .9), ("center", .5) })
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const c=document.querySelector('[data-archiver-center]').getBoundingClientRect(),s=document.querySelector('[data-archiver-splitter]').getBoundingClientRect();return {left:c.left,width:c.width,x:s.left+s.width/2,y:s.top+Math.min(s.height/2,300)};})()");
            using var point = JsonDocument.Parse(raw);
            var start = point.RootElement;
            foreach (var type in new[] { "mouseMoved", "mousePressed" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=start.GetProperty("x").GetDouble(), y=start.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
            var x = start.GetProperty("left").GetDouble() + start.GetProperty("width").GetDouble() * ratio;
            foreach (var type in new[] { "mouseMoved", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y=start.GetProperty("y").GetDouble(), button="left", buttons=type=="mouseMoved"?1:0, clickCount=1 }));
            await Task.Delay(80);
            var facts = await WaitForVisualAuditReadyAsync(audit);
            var file = Path.ChangeExtension(audit.OutputFile, $".split-{name}.png");
            await using (var output = File.Create(file)) await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
            frames.Add(new { requested_ratio=ratio, png=Path.GetFileName(file), scene=facts.GetProperty("archiver_scene") });
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".splitter.json"), JsonSerializer.Serialize(frames, new JsonSerializerOptions { WriteIndented=true }) + "\n", new UTF8Encoding(false));
        TraceVisualAudit("archiver-splitter-captured", "minimum/maximum/center");
    }

    private async Task VerifySourceCaptureTimeAsync(VisualAuditOptions audit)
    {
        async Task Wait(string expression)
        {
            for (var i = 0; i < 300; i++) { if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return; await Task.Delay(50); }
            throw new InvalidDataException("Capture-time UI condition timed out: " + expression);
        }
        async Task Click(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:n.contains(document.elementFromPoint(x,y))};})()
                """);
            using var p = JsonDocument.Parse(raw); if (!p.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidDataException("Capture-time control obstructed: " + selector);
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = p.RootElement.GetProperty("x").GetDouble(), y = p.RootElement.GetProperty("y").GetDouble(), button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        }
        const string capturedRow = "(()=>{const rows=[...document.querySelectorAll('.archiver-source-row')],r=rows.find(n=>n.querySelector('.archiver-source-file').textContent==='conversations.json');return rows.length===4&&!!r&&/^20[2-9][0-9]-[0-9]{2}-[0-9]{2}/.test(r.children[2].textContent.trim());})()";
        await Wait(capturedRow);
        await Wait("document.querySelector('.archiver-source-file').textContent==='conversations.json'");
        await Click("[data-source-sort]");
        await Wait("document.querySelector('.archiver-source-file').textContent==='Older.json'"); await Wait(capturedRow);
        // Preserve the corrected date row and its real information panel.
        await Click(".archiver-source-file[title='conversations.json']");
        await using (var image = File.Create(Path.ChangeExtension(audit.OutputFile, ".source-list.png"))) await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
        await Click(".archiver-source-row:has(.archiver-source-file[title='conversations.json']) [data-source-claude]");
        await Wait("document.querySelector('[data-claude-source-name]')?.textContent==='conversations.json'&&/^20[2-9][0-9]-[0-9]{2}-[0-9]{2}/.test(document.querySelector('[data-claude-source-captured]')?.textContent?.trim()??'')");
        await using (var image = File.Create(Path.ChangeExtension(audit.OutputFile, ".claude-container.png"))) await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
        await Click("[data-claude-return]"); await Wait(capturedRow);
        TraceVisualAudit("source-capture-time-pointer-passed", "capture-column=true;creation-fallback=true;sort=asc;raw-mtime-preserved=true;claude-capture=true");
    }

    private async Task VerifyArchiveColumnAlignmentAsync(VisualAuditOptions audit)
    {
        async Task Click(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:n.contains(document.elementFromPoint(x,y))};})()
                """);
            using var p = JsonDocument.Parse(raw);
            if (!p.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidDataException("Archive time control obstructed: " + selector);
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=p.RootElement.GetProperty("x").GetDouble(), y=p.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
        }
        var cases = new List<JsonElement>();
        foreach (var field in new[] { "json_created", "json_modified", "content_start" })
        {
            await Click("[data-archive-time-field]");
            await Click($".archiver-filter-popover input[value={field}] + span");
            await Click(".archiver-filter-popover footer .cloudig-button-filled");
            for (var i=0; i<100; i++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector('[data-page=archiver]').dataset.selectedArchiveTimeField==='{field}'") == "true") break;
                await Task.Delay(50);
            }
            // Exercise scrollbar appearance/removal on actual Engine rows;
            // only this disposable audit page receives the temporary height.
            foreach (var height in new[] { "22px", "" })
            {
                await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{for(const n of document.querySelectorAll('.archiver-list-body'))n.style.maxHeight={{JsonSerializer.Serialize(height)}};})()
                    """);
                await Task.Delay(200);
                for (var i=0; i<60; i++)
                {
                    if (await WebView.CoreWebView2.ExecuteScriptAsync("[...document.querySelectorAll('.archiver-list-body')].every(n=>parseFloat(getComputedStyle(n.parentElement).getPropertyValue('--archiver-list-gutter'))===n.offsetWidth-n.clientWidth)") == "true") break;
                    await Task.Delay(50);
                }
                var raw = await WebView.CoreWebView2.ExecuteScriptAsync("""
                    (()=>[...document.querySelectorAll('.archiver-list-card')].map(card=>{
                      const body=card.querySelector('.archiver-list-body'),head=card.querySelector('.archiver-column-header'),row=body?.querySelector('.archiver-list-row');
                      if(!row)return null;
                      const delta=()=>[1,2,3].map(i=>head.children[i].getBoundingClientRect().left-row.children[i].getBoundingClientRect().left);
                      const fixed=delta(),prior=card.style.getPropertyValue('--archiver-list-gutter');
                      card.style.setProperty('--archiver-list-gutter','0px');const old=delta();card.style.setProperty('--archiver-list-gutter',prior);
                      const h=head.getBoundingClientRect(),t=head.children[2].getBoundingClientRect();
                      return {kind:body.hasAttribute('data-archive-list')?'archive':'source',gutter:body.offsetWidth-body.clientWidth,observed_gutter:prior,padding:getComputedStyle(head).paddingRight,delta:fixed,without_gutter:old,label:head.children[2].textContent,vertical_delta:(t.top+t.bottom-h.top-h.bottom)/2};
                    }).filter(Boolean))()
                    """);
                using var parsed = JsonDocument.Parse(raw);
                foreach (var row in parsed.RootElement.EnumerateArray())
                {
                    if (row.GetProperty("delta").EnumerateArray().Any(n=>Math.Abs(n.GetDouble())>.15) || Math.Abs(row.GetProperty("vertical_delta").GetDouble())>.6)
                        throw new InvalidDataException("Archive header and row grids disagree: " + raw);
                }
                cases.Add(parsed.RootElement.Clone());
            }
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".column-alignment.json"), JsonSerializer.Serialize(cases, new JsonSerializerOptions { WriteIndented=true }) + "\n", new UTF8Encoding(false));
        TraceVisualAudit("archive-column-alignment-passed", "first-parsed/file-modified/content;native-pointer;scroll/no-scroll;source+archive");
    }

    private async Task VerifyArchiveInformationAsync(VisualAuditOptions audit)
    {
        foreach (var selector in new[] { ".archiver-source-row", ".archiver-archive-row" })
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($"(()=>{{const n=document.querySelector({JsonSerializer.Serialize(selector)}),r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {{x,y,hit:n.contains(document.elementFromPoint(x,y))}};}})()");
            using var point = JsonDocument.Parse(raw);
            if (!point.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidDataException("Information row is obstructed: " + selector);
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble() }));
            await Task.Delay(150);
        }
        var facts = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const a=document.querySelector('[data-source-info]'),b=document.querySelector('[data-archive-info]');return {source:a.textContent,archive:b.textContent,type:[a,b].every(n=>{const s=getComputedStyle(n),size=parseFloat(s.fontSize);return size>=13&&size<=24&&Math.abs(parseFloat(s.lineHeight)-size*1.6875)<.02&&s.textAlign==='left';}),weight:[...a.querySelectorAll('span'),...b.querySelectorAll('span')].every(n=>getComputedStyle(n).fontWeight==='400')};})()");
        using var parsed = JsonDocument.Parse(facts);
        var result = parsed.RootElement;
        var source = result.GetProperty("source").GetString()!;
        var archive = result.GetProperty("archive").GetString()!;
        var english = await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.lang === 'en'") == "true";
        if (!source.Contains(".html", StringComparison.Ordinal) || !source.Contains(english ? "Captured" : "采集时间", StringComparison.Ordinal) || !source.Contains(english ? "Bookmark version" : "书签版本", StringComparison.Ordinal) || source.Contains(english ? "Not provided" : "未提供", StringComparison.Ordinal)
            || !archive.Contains(".json", StringComparison.Ordinal) || !archive.Contains(english ? "Content Time: Not set" : "内容时间：未设置", StringComparison.Ordinal) || !System.Text.RegularExpressions.Regex.IsMatch(archive, (english ? "Parser version" : "解析器版本") + @"：\d+\.\d+\.\d+")
            || !result.GetProperty("type").GetBoolean() || !result.GetProperty("weight").GetBoolean())
            throw new InvalidDataException($"Archive information has missing fields, clipped lines or incorrect typography: {facts}");
        var centering = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (() => {
                const artwork=[...document.querySelectorAll('.archiver-wave,.archiver-village')].find(n=>getComputedStyle(n).display!=='none').getBoundingClientRect();
                return [...document.querySelectorAll('.archiver-info-copy')].map(panel=>{
                    const box=panel.getBoundingClientRect(),rows=[...panel.children].map(n=>n.getBoundingClientRect());
                    const top=Math.min(...rows.map(r=>r.top)),bottom=Math.max(...rows.map(r=>r.bottom));
                    return {height:box.height,artworkHeight:artwork.height,artworkOffset:box.bottom-artwork.bottom,centerError:(top+bottom-box.top-box.bottom)/2,
                      overflow:panel.scrollHeight>panel.clientHeight+1,topInset:top-box.top,bottomInset:box.bottom-bottom,horizontal:panel.scrollWidth>panel.clientWidth+1};
                });
            })()
            """);
        using var centers = JsonDocument.Parse(centering);
        foreach(var panel in centers.RootElement.EnumerateArray())
            if(Math.Abs(panel.GetProperty("height").GetDouble()-panel.GetProperty("artworkHeight").GetDouble())>.5
                || Math.Abs(panel.GetProperty("artworkOffset").GetDouble())>.5 || panel.GetProperty("horizontal").GetBoolean()
                || (panel.GetProperty("overflow").GetBoolean() ? panel.GetProperty("topInset").GetDouble()<5 : Math.Abs(panel.GetProperty("centerError").GetDouble())>.5))
                throw new InvalidDataException($"Archiver information text is not centered on its actual artwork container: {centering}");
        // Small windows may need the existing inner scrollbar. Prove reachability
        // with wheel input instead of requiring every line to fit simultaneously.
        foreach (var selector in new[] { "[data-source-info]", "[data-archive-info]" })
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect();
                  return {x:r.x+r.width-24,y:r.y+r.height/2,overflow:n.scrollHeight>n.clientHeight+1};})()
                """);
            using var point = JsonDocument.Parse(raw);
            if (!point.RootElement.GetProperty("overflow").GetBoolean()) continue;
            var x=point.RootElement.GetProperty("x").GetDouble(); var y=point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type="mouseMoved", x, y }));
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type="mouseWheel", x, y, deltaX=0, deltaY=1000 }));
            await Task.Delay(250);
            var reached = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}}),r=n.getBoundingClientRect(),last=n.lastElementChild.getBoundingClientRect();
                  return {passed:n.scrollTop>0&&Math.abs(n.scrollHeight-n.clientHeight-n.scrollTop)<2&&last.bottom<=r.bottom-4,scrollTop:n.scrollTop,lastBottom:last.bottom,boxBottom:r.bottom};})()
                """);
            using var reach = JsonDocument.Parse(reached);
            if (!reach.RootElement.GetProperty("passed").GetBoolean()) throw new InvalidDataException("Information footer cannot be reached with wheel input: " + reached);
            TraceVisualAudit("archive-information-wheel-passed", selector + " " + reached);
        }
        await using (var image = File.Create(Path.ChangeExtension(audit.OutputFile, ".information-scroll.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
        TraceVisualAudit("archive-information-centered", centering);
        TraceVisualAudit("archive-information-passed", facts);
    }

    private async Task VerifyMissingSourceRecordsAsync(VisualAuditOptions audit)
    {
        var expectedLibrary = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (_libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), expectedLibrary, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Missing-record audit requires its owned Library.");
        var archiveDirectory = Path.Combine(expectedLibrary, "Conversations");
        var archives = Directory.GetFiles(archiveDirectory, "*.json").ToDictionary(file => file, File.ReadAllBytes);
        var inbox = Path.Combine(expectedLibrary, "Inbox");
        var sources = Directory.GetFiles(inbox).ToDictionary(file => file, File.ReadAllBytes);
        async Task WaitAsync(string condition)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(condition) == "true") return;
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Missing-record UI condition failed: {condition}");
        }
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;
                const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if (raw == "null") throw new InvalidDataException($"Missing-record control is obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {
                    type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
        }
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archiver-workflow-close]')?.click()");
        await WaitAsync("document.querySelectorAll('.archiver-source-dismiss').length===3");
        await ClickAsync(".archiver-source-dismiss");
        await WaitAsync("document.querySelectorAll('[data-missing-record-choice]').length===2");
        await WaitAsync("document.querySelector('[data-missing-record-choice=current]').checked&&!document.querySelector('[data-missing-record-choice=all]').checked");
        await using (var image = File.Create(Path.ChangeExtension(audit.OutputFile, ".missing-confirmation.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
        await ClickAsync("label:has([data-missing-record-choice=current])");
        await WaitAsync("document.querySelector('[data-missing-record-confirm]').disabled");
        await ClickAsync("label:has([data-missing-record-choice=all])");
        await WaitAsync("!document.querySelector('[data-missing-record-confirm]').disabled");
        await ClickAsync("[data-missing-record-confirm]");
        await WaitAsync("!document.querySelector('[data-missing-record-confirm]')&&document.querySelectorAll('.archiver-source-dismiss').length===0&&document.querySelectorAll('.archiver-source-row').length===1");
        if (archives.Count != 1 || Directory.GetFiles(archiveDirectory, "*.json").Length != archives.Count ||
            archives.Any(entry => !File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)) ||
            sources.Any(entry => !File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)))
            throw new InvalidDataException("Clearing queue records changed an archive or an existing source.");
        TraceVisualAudit("missing-records-passed", "cleared=3;retained_source=1;archive_bytes_unchanged=1;native_pointer=true");
    }

    private async Task VerifyExternalArchiveRefreshAsync(VisualAuditOptions audit)
    {
        var outputRoot = Path.GetDirectoryName(audit.OutputFile)!;
        var expectedLibrary = Path.GetFullPath(Path.Combine(outputRoot, "Library"));
        if (_libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), expectedLibrary, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("External refresh audit requires its own isolated Library.");
        var conversations = Path.Combine(expectedLibrary, "Conversations");
        var files = Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories);
        if (files.Length != 1) throw new InvalidDataException("External refresh audit requires exactly one prepared archive.");
        var sourceFiles = Directory.GetFiles(Path.Combine(expectedLibrary, "Inbox"));
        var beforeSources = sourceFiles.Select(file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))).ToArray();
        var backup = Path.Combine(outputRoot, "external-refresh-archive.json");
        var before = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.archiver-archive-row').length");
        if (before != "1") throw new InvalidDataException("Prepared archive is missing from the live UI.");
        File.Move(files[0], backup);
        try
        {
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archive-refresh]').click()");
            var completed = false;
            for (var attempt = 0; attempt < 100; attempt++)
            {
                var ready = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.archiver-archive-row').length===0 && document.querySelector('.archiver-source-row [data-status]')?.dataset.status==='pending' && document.querySelector('[data-archive-stat=files]')?.textContent==='0'");
                if (ready == "true") { completed = true; break; }
                await Task.Delay(100);
            }
            if (!completed) throw new InvalidDataException("External deletion did not refresh the live archive rows, counts and source status.");
            if (Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories).Length != 0)
                throw new InvalidDataException("Refresh recreated a deleted archive.");
            var afterSources = sourceFiles.Select(file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))).ToArray();
            if (!beforeSources.SequenceEqual(afterSources)) throw new InvalidDataException("Refresh changed Inbox sources.");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".external-refresh.json"),
                JsonSerializer.Serialize(new { status = "passed", before = 1, after = 0, source_status = "pending", source_bytes_unchanged = true, auto_parse = false }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
        }
        finally { File.Move(backup, files[0]); }
    }

    private async Task VerifyParseBatchAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (_libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Parse timing requires its own isolated Library.");
        var target = Path.Combine(library, "Conversations");
        var expected = Directory.GetFiles(Path.Combine(library, "Inbox"), "*.html").Length;
        if(expected == 0 || Directory.GetFiles(target, "*.json").Length != 0) throw new InvalidDataException("Parse timing must start with unparsed inputs.");
        var timer = System.Diagnostics.Stopwatch.StartNew();
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archiver-parse-all]').click()");
        for(var i=0;i<50;i++)
        {
            if(await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelectorAll('.cloudig-dialog-list li').length==={expected}")=="true")break;
            await Task.Delay(50);
        }
        if(await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelectorAll('.cloudig-dialog-list li').length==={expected}")!="true")throw new InvalidDataException("Batch scope confirmation did not show all source files.");
        var confirmationMs = timer.Elapsed.TotalMilliseconds;
        if(Directory.GetFiles(target, "*.json").Length!=0)throw new InvalidDataException("Parsing began before confirmation.");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-dialog footer .cloudig-button-filled').click()");
        timer.Restart();
        double? progressMs=null;
        var complete=false;
        for(var i=0;i<550;i++)
        {
            var progress=await WebView.CoreWebView2.ExecuteScriptAsync("!document.querySelector('[data-archiver-progress]').hidden");
            if (i % 50 == 0)
            {
                var failure = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[role=alertdialog] p')?.textContent ?? null");
                TraceVisualAudit("parse-batch-state", $"created={Directory.GetFiles(target, "*.json").Length};progress={progress};elapsed_ms={timer.ElapsedMilliseconds};error={failure}");
                if (failure != "null") throw new InvalidDataException($"Archiver reported a failure after parsing: {failure}");
            }
            if(progress=="true" && progressMs is null)progressMs=timer.Elapsed.TotalMilliseconds;
            if(Directory.GetFiles(target,"*.json").Length==expected && progress=="false") { complete=true;break; }
            await Task.Delay(100);
        }
        if(!complete)throw new InvalidDataException("Real WPF batch did not finish all archives within the finite timing run.");
        var parsedMs = timer.Elapsed.TotalMilliseconds;
        var allCompleted = $"document.querySelectorAll('[data-source-list] [data-status=complete]').length==={expected} && !document.querySelector('[data-source-list] [data-status=pending]')";
        for (var refresh = 0; refresh < 2; refresh++)
        {
            for (var i = 0; i < 50 && await WebView.CoreWebView2.ExecuteScriptAsync(allCompleted) != "true"; i++) await Task.Delay(100);
            if (await WebView.CoreWebView2.ExecuteScriptAsync(allCompleted) != "true") throw new InvalidDataException("Parsed outputs exist, but the source list did not mark every HTML complete.");
            if (refresh == 0) { await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-source-refresh]').click()"); await Task.Delay(300); }
        }
        var next = await _engine!.SendAsync("archiver.parse.plan", Json("{\"sources\":[],\"one_click\":true}"));
        if (next.GetProperty("total").GetInt32() != 0) throw new InvalidDataException("One-click parse incorrectly requeued completed HTML files.");
        TraceVisualAudit("parse-status-passed", $"completed={expected};pending=0;next_parse=0;refresh=true");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".parse-batch-timing.json"),JsonSerializer.Serialize(new { layer="real-wpf-button-to-refreshed-ui", selected=expected, created=Directory.GetFiles(target,"*.json").Length, completed_statuses=expected, pending_statuses=0, next_parse=0, confirmation_ms=confirmationMs, first_progress_ms=progressMs, confirmed_to_refreshed_ms=parsedMs, user_library_touched=false },new JsonSerializerOptions { WriteIndented=true }));
    }

    private async Task VerifyBatchArchiveDeleteAsync(VisualAuditOptions audit)
    {
        var outputRoot = Path.GetDirectoryName(audit.OutputFile)!;
        var expectedLibrary = Path.GetFullPath(Path.Combine(outputRoot, "Library"));
        if (_libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), expectedLibrary, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Batch-delete audit requires its own isolated Library.");
        var conversations = Path.Combine(expectedLibrary, "Conversations");
        var files = Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories);
        if (files.Length != 3) throw new InvalidDataException("Batch-delete audit requires exactly three prepared archives.");
        var marksDirectory = Path.Combine(expectedLibrary, "Marks");
        var marks = Directory.GetFiles(marksDirectory, "*.json", System.IO.SearchOption.AllDirectories);
        if (marks.Length != 1) throw new InvalidDataException("Batch-delete audit requires one paired Mark.");
        var backups = files.Concat(marks).ToDictionary(file => file, File.ReadAllBytes);
        var sources = Directory.GetFiles(Path.Combine(expectedLibrary, "Inbox"));
        var sourceHashes = sources.Select(file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))).ToArray();
        try
        {
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archive-select-all]').click()");
            var selectionReady = false;
            for (var attempt = 0; attempt < 50; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.archiver-archive-row[data-selected=true]').length===3") == "true") { selectionReady = true; break; }
                await Task.Delay(100);
            }
            if (!selectionReady) throw new InvalidDataException("Select-all did not finish selecting the three prepared archives.");
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archive-action=delete]').click()");
            var ready = false;
            for (var attempt = 0; attempt < 50; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-dialog-list li').length===3") == "true") { ready = true; break; }
                await Task.Delay(100);
            }
            if (!ready) throw new InvalidDataException("Select-all did not produce one exact three-file confirmation.");
            if (await WebView.CoreWebView2.ExecuteScriptAsync("[...document.querySelectorAll('.cloudig-dialog-list li span')].filter(n=>n.textContent.startsWith('Mark · ')).length===1") != "true")
                throw new InvalidDataException("Confirmation did not list the one paired Mark.");
            await using (var confirmationImage = File.Create(Path.ChangeExtension(audit.OutputFile, ".delete-confirmation.png")))
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, confirmationImage);
            if (Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories).Length != 3)
                throw new InvalidDataException("Delete changed files before confirmation.");
            if (!File.Exists(marks[0]) || !File.ReadAllBytes(marks[0]).SequenceEqual(backups[marks[0]]))
                throw new InvalidDataException("Delete changed the paired Mark before confirmation.");
            await WebView.CoreWebView2.ExecuteScriptAsync("""
                (()=>{window.__deleteProgressSamples=[];window.__deleteProgressObserver=new MutationObserver(()=>{
                  const panel=document.querySelector('[data-delete-progress]'),bar=panel?.querySelector('progress');if(!bar)return;
                  const sample={value:bar.value,total:bar.max,file:panel.querySelector('[data-progress-file]').textContent};
                  if(window.__deleteProgressSamples.at(-1)?.value!==sample.value)window.__deleteProgressSamples.push(sample);
                });window.__deleteProgressObserver.observe(document.querySelector('.app-root'),{subtree:true,childList:true,attributes:true,characterData:true});})()
                """);
            await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const d=document.querySelector('.cloudig-dialog-danger'),c=d.querySelector('input[type=checkbox]');if(c)c.click();d.querySelector('footer .cloudig-button-filled').click();})()");
            if (await WebView.CoreWebView2.ExecuteScriptAsync("!!document.querySelector('[data-delete-progress]')") == "true")
            {
                await using var progressImage = File.Create(Path.ChangeExtension(audit.OutputFile, ".delete-progress.png"));
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, progressImage);
            }
            var completed = false;
            for (var attempt = 0; attempt < 200; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.archiver-archive-row').length===0 && !document.querySelector('.cloudig-dialog') && !document.querySelector('[data-write-busy]')") == "true") { completed = true; break; }
                await Task.Delay(100);
            }
            if (!completed || Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories).Length != 0)
                throw new InvalidDataException("Batch-delete did not recycle all three exact selections.");
            if (Directory.GetFiles(marksDirectory, "*.json", System.IO.SearchOption.AllDirectories).Length != 0)
                throw new InvalidDataException("Batch-delete did not recycle the paired Mark.");
            if (!sourceHashes.SequenceEqual(sources.Select(file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))))))
                throw new InvalidDataException("Batch-delete changed Inbox source bytes.");
            var progressJson = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{window.__deleteProgressObserver.disconnect();if(document.querySelector('[data-delete-progress]'))throw new Error('Delete progress did not close');return window.__deleteProgressSamples;})()");
            using var progressDocument = JsonDocument.Parse(progressJson);
            var progressSamples = progressDocument.RootElement.Clone();
            if (!progressSamples.EnumerateArray().Select(sample => sample.GetProperty("value").GetInt32()).SequenceEqual(new[] { 0, 1, 2, 3 }))
                throw new InvalidDataException("Real delete progress did not record zero and all three successful files.");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".batch-delete.json"),
                JsonSerializer.Serialize(new { status = "passed", selected = 3, confirmed = 3, recycled = 3, recycled_mark_files = 1, remaining = 0, progress = progressSamples, source_bytes_unchanged = true, real_user_library_touched = false }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
        }
        finally
        {
            // Restore only this owned fixture for the other theme's independent run.
            foreach (var item in backups) if (!File.Exists(item.Key)) await File.WriteAllBytesAsync(item.Key, item.Value);
        }
    }

    private async Task VerifyOverflowTextAsync(VisualAuditOptions audit)
    {
        var expanded=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const root=document.querySelector('[data-page=reader]');if(root?.dataset.catalogCollapsed!=='true')return false;root.querySelector('[data-reader-catalog-toggle=expand]').click();return true;})()");
        var results=new List<JsonElement>();
        try
        {
            foreach(var selector in new[]{".reader-row-title",".archiver-source-file > span",".archiver-archive-title > span",".archiver-claude-row-title"})
            {
                var initial=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const node=[...document.querySelectorAll({{JsonSerializer.Serialize(selector)}})].find(n=>n.getBoundingClientRect().height>0);if(!node)return null;
                      if(!node.hasAttribute('data-overflow-text'))throw new Error('Missing shared title interaction');
                      window.__cloudigHoverAudit={node,original:node.textContent};node.textContent='短名';
                      const r=node.getBoundingClientRect();return {x:r.left+Math.min(12,r.width/2),y:r.top+r.height/2};})()
                    """);
                if(initial=="null") continue;
                using(var point=JsonDocument.Parse(initial))
                    await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseMoved",x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble()}));
                await Task.Delay(450);
                if(await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=window.__cloudigHoverAudit.node;return n.scrollLeft===0&&!n.dataset.scrolling;})()")!="true")
                    throw new InvalidOperationException("A short title moved on hover.");
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent","{\"type\":\"mouseMoved\",\"x\":1,\"y\":1}");
                var longPoint=await WebView.CoreWebView2.ExecuteScriptAsync("""
                    (()=>{const a=window.__cloudigHoverAudit,n=a.node;n.textContent=a.original;a.extended=n.scrollWidth<=n.clientWidth+1;
                      if(a.extended)n.textContent=(a.original+' / 完整长标题 branch01 (2) ').repeat(8);
                      const r=n.getBoundingClientRect();a.width=r.width;a.height=r.height;
                      return {x:r.left+Math.min(12,r.width/2),y:r.top+r.height/2};})()
                    """);
                using(var point=JsonDocument.Parse(longPoint))
                    await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{type="mouseMoved",x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble()}));
                var moved=false;
                for(var attempt=0;attempt<30;attempt++)
                {
                    if(await WebView.CoreWebView2.ExecuteScriptAsync("window.__cloudigHoverAudit.node.scrollLeft>20")=="true") { moved=true; break; }
                    await Task.Delay(100);
                }
                if(!moved) throw new InvalidOperationException($"Long title did not scroll on real pointer hover: {selector}");
                var facts=await WebView.CoreWebView2.ExecuteScriptAsync("""
                    (()=>{const a=window.__cloudigHoverAudit,n=a.node,r=n.getBoundingClientRect(),s=getComputedStyle(n);
                      return {selector:n.className||n.parentElement.className,extended:a.extended,left:n.scrollLeft,overflow:n.scrollWidth-n.clientWidth,
                        active:n.dataset.scrolling==='true',clip:s.textOverflow==='clip'&&s.overflowX==='hidden',stable:Math.abs(r.width-a.width)<1&&Math.abs(r.height-a.height)<1};})()
                    """);
                using(var data=JsonDocument.Parse(facts))
                {
                    if(!data.RootElement.GetProperty("active").GetBoolean()||!data.RootElement.GetProperty("clip").GetBoolean()||!data.RootElement.GetProperty("stable").GetBoolean())
                        throw new InvalidOperationException($"Title scroll changed its layout or lost clipping: {facts}");
                    results.Add(data.RootElement.Clone());
                }
                await using(var capture=File.Create(Path.ChangeExtension(audit.OutputFile,$".hover-{results.Count}.png")))
                    await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent","{\"type\":\"mouseMoved\",\"x\":1,\"y\":1}");
                if(await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const n=window.__cloudigHoverAudit.node;return n.scrollLeft===0&&!n.dataset.scrolling;})()")!="true")
                    throw new InvalidOperationException("Title did not reset on pointer leave.");
                await WebView.CoreWebView2.ExecuteScriptAsync("window.__cloudigHoverAudit.node.textContent=window.__cloudigHoverAudit.original;delete window.__cloudigHoverAudit");
            }
            if(results.Count==0) throw new InvalidOperationException("No visible list title was exercised.");
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".hover-text.json"),JsonSerializer.Serialize(results));
        }
        finally
        {
            await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const a=window.__cloudigHoverAudit;if(a)a.node.textContent=a.original;delete window.__cloudigHoverAudit;})()");
            if(expanded=="true") await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-reader-catalog-toggle=collapse]')?.click()");
        }
    }

    private async Task VerifyArchiverWorkflowPaintAsync(VisualAuditOptions audit)
    {
        // The import callback ordering is tested at the UI boundary without
        // opening a native picker on the user's desktop. Check the same shared
        // workflow toggle and the actual normal-page paint in this real host.
        var result = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const root=document.querySelector('[data-page=archiver]'),guide=root.querySelector('[data-archiver-workflow]');
              root.querySelector('[data-archiver-workflow-open]').click();const opened=!guide.hidden&&root.dataset.workflowOpen==='true';
              root.querySelector('[data-archiver-parse-settings]').click();const settingsPreserveGuide=!guide.hidden;
              root.querySelector('[data-parse-settings-cancel]').click();root.querySelector('[data-archiver-workflow-close]').click();
              const closed=guide.hidden&&root.dataset.workflowOpen==='false';
              const colors=[...root.querySelectorAll('.archiver-source-toolbar [data-source-status=pending],.archiver-list-row [data-status=pending]')].map(n=>getComputedStyle(n).color);
              const expected=document.documentElement.dataset.theme==='star-night'?'rgb(126, 94, 255)':'rgb(81, 37, 165)';
              return {opened,settingsPreserveGuide,closed,colors,expected,correctColors:colors.length>=2&&colors.every(color=>color===expected)};})()
            """);
        using var facts = JsonDocument.Parse(result);
        foreach (var key in new[] { "opened", "settingsPreserveGuide", "closed", "correctColors" })
            if (!facts.RootElement.GetProperty(key).GetBoolean()) throw new InvalidOperationException($"Archiver workflow/paint mismatch: {result}");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".archiver-refinements.json"), result);
        TraceVisualAudit("archiver-workflow-paint-passed");
    }

    private async Task VerifyScheduleCardsAsync(VisualAuditOptions audit)
    {
        // This probe owns the captured task card, not a full long-conversation
        // scroll benchmark. Stop when its lazy page has mounted at any width.
        for (var step = 0; step < 160; step++)
        {
            var found = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{if(document.querySelector('.cloudig-schedule')&&document.querySelector('.osis-emoji'))return true;const s=document.querySelector('[data-reader-conversation-scroll]');s.scrollTop+=Math.max(500,s.clientHeight*.8);return false;})()");
            if (found == "true") break;
            await Task.Delay(100);
        }
        var result = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const panel=document.querySelector('.cloudig-schedule');
              if(!panel) throw new Error('No captured schedule list');
              if(panel.tagName!=='SECTION'||panel.querySelector(':scope > summary')) throw new Error('Schedule list has an extra outer fold');
              const cards=[...panel.querySelectorAll('.cloudig-schedule-task')];
              const initiallyFolded=cards.every(c=>!c.open);
              for(const card of cards){card.querySelector(':scope > summary').click();card.dispatchEvent(new Event('toggle'));
                if(!card.open||!card.querySelector('.cloudig-schedule-prompt')?.textContent.trim()) throw new Error('Task did not open');
                const settings=card.querySelector('.cloudig-schedule-settings');
                if(!settings||settings.open) throw new Error('Missing original task');
                settings.open=true;settings.dispatchEvent(new Event('toggle'));
                if(!JSON.parse(settings.querySelector('pre').textContent).id) throw new Error('Missing original task data');settings.open=false;
                card.querySelector(':scope > summary').click();}
              panel.scrollIntoView({block:'start'});
              const r=panel.getBoundingClientRect(),owner=document.querySelector('[data-reader-conversation-scroll]').getBoundingClientRect();
              const emoji=document.querySelector('.osis-emoji');
              return {tasks:cards.length,initiallyFolded,closedAgain:cards.every(c=>!c.open),fits:r.left>=owner.left&&r.right<=owner.right+1,
                emojiFont:emoji?getComputedStyle(emoji).fontFamily:null};})()
            """);
        using var facts = JsonDocument.Parse(result);
        var value = facts.RootElement;
        if (value.GetProperty("tasks").GetInt32() != 3 || !value.GetProperty("initiallyFolded").GetBoolean()
            || !value.GetProperty("closedAgain").GetBoolean() || !value.GetProperty("fits").GetBoolean()
            || !(value.GetProperty("emojiFont").GetString() ?? "").Contains("Segoe UI Emoji", StringComparison.Ordinal))
            throw new InvalidOperationException($"Schedule cards did not retain reading/fold/font behavior: {result}");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".schedule-cards.json"), result);
        TraceVisualAudit("reader-schedule-cards-passed");
    }

    private async Task VerifyNestedProcessAsync(VisualAuditOptions audit)
    {
        var found = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const d=[...document.querySelectorAll('details.cloudig-reasoning')].find(d=>d.querySelector(':scope > summary')?.textContent==='已处理');
              if(!d)return false;d.dataset.auditNestedProcess='';return true;})()
            """);
        if(found!="true") throw new InvalidDataException("The real sample must contain a processed reasoning panel.");
        async Task ClickAsync(string selector)
        {
            var pointRaw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n)return null;
                  n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.left+Math.min(40,r.width/2),y=r.top+r.height/2;
                  if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Nested process control is obstructed');return {x,y};})()
                """);
            if(pointRaw=="null") throw new InvalidDataException($"Missing nested process control: {selector}");
            using var point = JsonDocument.Parse(pointRaw);
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new{
                    type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(),
                    button=type=="mouseMoved"?"none":"left", buttons=type=="mousePressed"?1:0, clickCount=type=="mouseMoved"?0:1
                }));
            await Task.Delay(100);
        }
        const string panel="[data-audit-nested-process]";
        await ClickAsync(panel+" > summary");
        var closed = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const p=document.querySelector('[data-audit-nested-process]'),ds=[...p.querySelectorAll('.cloudig-nested-process')];
              if(ds.length<2||ds.some(d=>d.open||d.getBoundingClientRect().height-d.querySelector(':scope > summary').getBoundingClientRect().height>1))return false;
              ds.forEach((d,i)=>d.dataset.auditNestedIndex=String(i));return p.open;})()
            """);
        if(closed!="true") throw new InvalidDataException("Inner reasoning groups are absent or not initially collapsed.");
        await using(var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".nested-closed.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
        await ClickAsync("[data-audit-nested-index='0'] > summary");
        var facts = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const p=document.querySelector('[data-audit-nested-process]'),ds=[...p.querySelectorAll('.cloudig-nested-process')],first=ds[0],heading=first.querySelector(':scope > summary'),r=document.querySelector('.cloudig-conversation-renderer');
              return {groups:ds.length,firstOpen:first.open,secondClosed:!ds[1].open,
                expanded:first.getBoundingClientRect().height>heading.getBoundingClientRect().height+10,
                themed:getComputedStyle(heading).color===getComputedStyle(r).getPropertyValue('--cloudig-muted').trim()||getComputedStyle(heading).color===getComputedStyle(p.querySelector(':scope > summary')).color,
                labels:ds.map(d=>d.querySelector(':scope > summary').textContent),extraAxisDots:ds.filter(d=>d.classList.contains('cloudig-process')).length,
                overflow:document.body.scrollWidth>document.body.clientWidth+1};})()
            """);
        using(var result=JsonDocument.Parse(facts))
        {
            var f=result.RootElement;
            if(!f.GetProperty("firstOpen").GetBoolean()||!f.GetProperty("secondClosed").GetBoolean()||!f.GetProperty("expanded").GetBoolean()
                ||!f.GetProperty("themed").GetBoolean()||f.GetProperty("overflow").GetBoolean()||f.GetProperty("extraAxisDots").GetInt32()!=0)
                throw new InvalidDataException($"Nested reasoning display failed: {facts}");
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".nested-process.json"),facts);
        await using(var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".nested-open.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
        await ClickAsync("[data-audit-nested-index='1'] > summary");
        var independent = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-audit-nested-index=\"0\"]').open&&document.querySelector('[data-audit-nested-index=\"1\"]').open");
        if(independent!="true") throw new InvalidDataException("The next reasoning level cannot open within its open parent.");
        await using(var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".nested-second.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
        await ClickAsync("[data-audit-nested-index='1'] > summary");
        var childClosed = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-audit-nested-index=\"0\"]').open&&!document.querySelector('[data-audit-nested-index=\"1\"]').open");
        if(childClosed!="true") throw new InvalidDataException("Closing the inner reasoning group also closed its parent.");
        await ClickAsync("[data-audit-nested-index='0'] > summary");
        TraceVisualAudit("reader-nested-process-passed",facts);
    }

    private async Task VerifyReaderResourceScrollAsync(VisualAuditOptions audit)
    {
        await VerifyReaderBranchRoundtripAsync(audit);
        await VerifyConversationImagesAsync(audit);
        var query = System.Web.HttpUtility.ParseQueryString(audit.Query.TrimStart('?'));
        var expected = int.TryParse(query["expected-messages"], out var count) ? count : (int?)null;
        var done = false;
        for(var step=0;step<(expected.HasValue ? 1200 : 160);step++)
        {
            // The bottom of the current page is not the end of the conversation.
            // Keep triggering the real scroll handler until the packaged Engine's
            // default path has arrived, rather than passing on its first 40 rows.
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const s=document.querySelector('[data-reader-conversation-scroll]');
                  document.querySelectorAll('.cloudig-resource-image').forEach(i=>i.loading='eager');
                  s.scrollTop={{(expected.HasValue ? "s.scrollHeight" : "s.scrollTop+Math.max(500,s.clientHeight*.8)")}};
                  return s.scrollTop+s.clientHeight>=s.scrollHeight-2
                    && {{(expected.HasValue ? $"document.querySelectorAll('.cloudig-message').length==={expected.Value}" : "true")}};})()
                """);
            await Task.Delay(100);
            if(raw=="true") { done=true; break; }
        }
        if(!done) throw new InvalidOperationException("Reader scroll did not reach its bounded test endpoint.");
        if(expected.HasValue) await VerifyReaderPaginationEndpointAsync(audit, expected.Value, query["expected-last-message"], query["expected-last-navigation"]);
        JsonElement result = default;
        for(var attempt=0;attempt<100;attempt++)
        {
            // A final streamed page can append lazy images after the last scroll
            // iteration. This audit inspects all resources, including offscreen
            // ones, so include those late arrivals rather than waiting forever.
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-resource-image').forEach(i=>i.loading='eager')");
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync("({messages:document.querySelectorAll('.cloudig-message').length,avatars:document.querySelectorAll('.cloudig-avatar img').length,images:document.querySelectorAll('.cloudig-resource-image').length,pending:[...document.querySelectorAll('.cloudig-resource-image,.cloudig-avatar img')].filter(i=>!i.complete).length,broken:[...document.querySelectorAll('.cloudig-resource-image,.cloudig-avatar img')].filter(i=>i.complete&&!i.naturalWidth).length,failed:document.querySelectorAll('[data-cloudig-resource-error=true]').length,loading:[...document.querySelectorAll('.cloudig-resource-state')].filter(n=>/正在|loading/i.test(n.textContent)).length,open_process:document.querySelectorAll('.cloudig-process[open]').length,errors:Number(document.documentElement.dataset.runtimeErrors??0)})");
            using var facts=JsonDocument.Parse(raw); result=facts.RootElement.Clone();
            var portraitSlots = int.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-avatar').length"));
            if(result.GetProperty("pending").GetInt32()==0 && result.GetProperty("loading").GetInt32()==0 && result.GetProperty("avatars").GetInt32()==portraitSlots) break;
            await Task.Delay(100);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".resource-scroll.json"),result.ToString());
        var expectedPortraits = int.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-avatar').length"));
        if(result.GetProperty("failed").GetInt32()!=0 || result.GetProperty("broken").GetInt32()!=0 || result.GetProperty("pending").GetInt32()!=0 || result.GetProperty("loading").GetInt32()!=0 || result.GetProperty("errors").GetInt32()!=0 || result.GetProperty("open_process").GetInt32()!=0 || result.GetProperty("avatars").GetInt32()!=expectedPortraits)
            throw new InvalidOperationException($"Reader resources failed after real scrolling: {result}");
        // An absent [open] attribute alone does not prove that process content
        // is hidden, nor does it catch duplicate native folds inside rich HTML.
        var foldRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const folds=[...document.querySelectorAll('details.cloudig-process')];
              const extraHeight=d=>d.getBoundingClientRect().height-(d.querySelector(':scope > summary')?.getBoundingClientRect().height??0);
              const leaked=folds.filter(d=>!d.open&&extraHeight(d)>1).length;
              const nativeOpen=[...document.querySelectorAll('.cloudig-rich details.thinking[open]')].filter(n=>n.getBoundingClientRect().height>0).length;
              const groups=[...document.querySelectorAll('.cloudig-process-group')],groupsFolded=groups.every(g=>!g.open);
              groups.forEach(g=>g.open=true);
              const first=folds[0];
              let opened=false,reclosed=false;
              if(first){first.querySelector('summary').click();first.dispatchEvent(new Event('toggle'));opened=first.open&&extraHeight(first)>1;first.querySelector('summary').click();reclosed=!first.open&&extraHeight(first)<=1;}
              const code=document.querySelector('.cloudig-code'),style=code?getComputedStyle(code):null;
              const statuses=[...document.querySelectorAll('.cloudig-process-static')];
              const staticSafe=statuses.every(n=>!n.querySelector('summary,button,[tabindex]')&&n.textContent.trim());
              const tool=folds.find(n=>n.classList.contains('cloudig-tool')),label=tool?.querySelector(':scope > summary > .cloudig-fold-label');
              let compact=true,complete=true;
              if(label){const original=label.textContent,oldOpen=tool.open,stress='Complete captured tool summary. '.repeat(80);label.textContent=stress;tool.open=false;
                const closedHeight=label.getBoundingClientRect().height;compact=getComputedStyle(label).whiteSpace==='nowrap'&&label.scrollWidth>label.clientWidth;
                tool.open=true;complete=label.textContent===stress&&label.getBoundingClientRect().height>closedHeight;label.textContent=original;tool.open=oldOpen;}
              const search=document.querySelector('.reader-catalog-search input'),searchStyle=search?getComputedStyle(search):null;
              const searchCentered=!search||search.value||searchStyle.paddingLeft===searchStyle.paddingRight;
              const navigationLeft=[...document.querySelectorAll('.reader-navigation-copy')].every(n=>getComputedStyle(n).textAlign==='left');
              groups.forEach(g=>g.open=false);
              return {folds:folds.length,groups:groups.length,groupsFolded,navigationLeft,leaked,nativeOpen,toggled:Boolean(first),opened,reclosed,staticStatuses:statuses.length,staticSafe,compactToolSummary:compact,fullExpandedSummary:complete,searchCentered:Boolean(searchCentered),code:style?{background:style.backgroundColor,text:style.color,border:style.borderTopColor}:null};})()
            """);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".folds-and-colors.json"),foldRaw);
        using(var foldFacts=JsonDocument.Parse(foldRaw))
        {
            var fold=foldFacts.RootElement;
            if(fold.GetProperty("leaked").GetInt32()!=0 || fold.GetProperty("nativeOpen").GetInt32()!=0
                || !fold.GetProperty("groupsFolded").GetBoolean() || !fold.GetProperty("navigationLeft").GetBoolean()
                || !fold.GetProperty("staticSafe").GetBoolean() || !fold.GetProperty("compactToolSummary").GetBoolean()
                || !fold.GetProperty("fullExpandedSummary").GetBoolean() || !fold.GetProperty("searchCentered").GetBoolean()
                || (fold.GetProperty("toggled").GetBoolean() && (!fold.GetProperty("opened").GetBoolean() || !fold.GetProperty("reclosed").GetBoolean())))
                throw new InvalidOperationException($"Reader process content did not actually collapse: {foldRaw}");
        }
        var textLayoutRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{
              const paragraphs=[],collapsed=[];let boundaries=0;
              const captureMinimum=Number(new URLSearchParams(location.search).get('expected-line-boundaries'))||1;
              const protectedSelector='pre,code,kbd,samp,math,svg,.katex,.katex-display,.temml,.cloudig-math';
              const containers=[...document.querySelectorAll('.cloudig-message-user .cloudig-rich p,.cloudig-message-user .cloudig-rich li,.cloudig-message-user .cloudig-rich td,.cloudig-message-user .cloudig-rich th,.cloudig-message-user .cloudig-text,.cloudig-message-user .cloudig-rich')];
              for(const p of containers){
                if(p.querySelector('p,li,td,th')||p.closest(protectedSelector)||p.getBoundingClientRect().height===0)continue;
                let previous=null,pending=false;const pairs=[];
                const point=(node,offset)=>{const r=document.createRange();r.setStart(node,offset);r.setEnd(node,offset+1);return r.getBoundingClientRect().top;};
                const walk=node=>{
                  if(node.nodeType===1){
                    if(node.matches(protectedSelector)||['normal','nowrap'].includes(node.style.whiteSpace)){previous=null;pending=false;return;}
                    if(node.localName==='br'){pending=true;return;}
                    for(const child of node.childNodes)walk(child);return;
                  }
                  if(node.nodeType!==3)return;
                  let offset=0;for(const part of node.data.split('\n')){
                    const first=part.search(/\S/u),last=part.search(/\S\s*$/u);
                    if(first>=0){const top=point(node,offset+first);
                      if(pending&&previous!==null)pairs.push({before:previous,after:top});
                      previous=point(node,offset+last);pending=false;
                    }
                    offset+=part.length+1;if(offset<=node.data.length)pending=true;
                  }
                };walk(p);
                if(!pairs.length)continue;
                if(pairs.length>=captureMinimum&&!document.querySelector('[data-audit-user-lines]'))p.dataset.auditUserLines='true';
                const index=paragraphs.length;
                paragraphs.push({boundaries:pairs.length,whiteSpace:getComputedStyle(p).whiteSpace,height:p.getBoundingClientRect().height,pairs});
                boundaries+=pairs.length;for(const pair of pairs)if(pair.after<=pair.before+1)collapsed.push({paragraph:index,...pair});
              }
              return {paragraphs,boundaries,collapsed,languages:[...document.querySelectorAll('pre.cloudig-code[data-language]')].map(p=>({label:p.dataset.language,displayed:getComputedStyle(p,'::before').content}))};})()
            """);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".text-layout.json"),textLayoutRaw);
        using(var textLayout=JsonDocument.Parse(textLayoutRaw))
        {
            var layout=textLayout.RootElement;
            var minimum=int.TryParse(query["expected-line-boundaries"],out var minimumLines)?minimumLines:0;
            if(layout.GetProperty("collapsed").GetArrayLength()!=0 || layout.GetProperty("boundaries").GetInt32()<minimum)
                throw new InvalidOperationException($"Reader authored user lines are flattened or absent: {textLayoutRaw}");
        }
        var diagramRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const cards=[...document.querySelectorAll('.cloudig-diagram')];return cards.map(card=>{
              const display=card.querySelector('.cloudig-diagram-display'),source=card.querySelector('.cloudig-diagram-source');
              const background=getComputedStyle(display).backgroundColor;
              const visible=node=>getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().height>0;
              const text=source?.textContent;let initial=!source||!visible(source),sourceOnly=true,restored=true;
              if(source){card.querySelector('[data-diagram-view="source"]').click();sourceOnly=visible(source)&&!visible(display)&&source.textContent===text;card.querySelector('[data-diagram-view="diagram"]').click();restored=visible(display)&&!visible(source);}
              const img=display.querySelector('img'),bounds=img?.getBoundingClientRect();
              return {format:card.dataset.diagramFormat,renderer:display.dataset.renderer??'captured',background,sourceCharacters:text?.length??0,initial,sourceOnly,restored,image:img?{naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,width:bounds.width,height:bounds.height}:null};});})()
            """);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".diagram-views.json"),diagramRaw);
        using(var diagrams=JsonDocument.Parse(diagramRaw))
            foreach(var diagram in diagrams.RootElement.EnumerateArray())
                if(diagram.GetProperty("background").GetString() is "rgba(0, 0, 0, 0)" or "transparent"
                    || (diagram.GetProperty("format").GetString()=="mermaid" && diagram.GetProperty("image").ValueKind==JsonValueKind.Null)
                    || !diagram.GetProperty("initial").GetBoolean() || !diagram.GetProperty("sourceOnly").GetBoolean() || !diagram.GetProperty("restored").GetBoolean())
                    throw new InvalidOperationException($"Reader diagram background or real view switch failed: {diagram}");
        var richLayoutRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const root=document.querySelector('.cloudig-conversation-renderer');
              for(const c of root.querySelectorAll('th[data-osis-align],td[data-osis-align]')) {
                const expected=c.dataset.osisAlign;if(['left','center','right'].includes(expected)&&getComputedStyle(c).textAlign!==expected)throw new Error('Captured table alignment was not applied: '+expected);
              }
              return {tables:[...root.querySelectorAll('.cloudig-rich table')].map(t=>({rows:[...t.rows].map(r=>[...r.cells].map(c=>({text:c.textContent,align:getComputedStyle(c).textAlign,rowspan:c.rowSpan,colspan:c.colSpan})))})),
                cards:[...root.querySelectorAll('.cloudig-rich div[style]')].filter(n=>n.style.borderRadius&&n.style.background).map(n=>({text:n.textContent,background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color,padding:getComputedStyle(n).padding,radius:getComputedStyle(n).borderRadius})),
                code:[...root.querySelectorAll('.cloudig-rich pre')].map(n=>({text:n.textContent,whiteSpace:getComputedStyle(n).whiteSpace})),
                references:[...root.querySelectorAll('.cloudig-source-link')].map(n=>({title:n.textContent,url:n.href}))};})()
            """);
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".rich-layout.json"),richLayoutRaw);
        var tableLayoutRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const root=document.querySelector('.cloudig-conversation-renderer');
              const facts=[...root.querySelectorAll('.cloudig-rich table')].map(table=>{
                const wrapper=table.parentElement,s=getComputedStyle(wrapper);
                if(!wrapper.classList.contains('cloudig-table-scroll')||s.overflowX!=='auto'||getComputedStyle(table).display!=='table')
                  throw new Error('Table lost its local scroll owner or table formatting context');
                return {tableWidth:table.getBoundingClientRect().width,wrapperWidth:wrapper.clientWidth,scrollWidth:wrapper.scrollWidth,rows:table.rows.length};
              });
              const original=root.querySelector('.cloudig-rich table');if(!original)return {tables:facts,stress:null};
              const wrapper=original.parentElement,probe=original.cloneNode(true),oldScroll=wrapper.scrollLeft;
              let stress;original.replaceWith(probe);
              try {
                for(const cell of probe.querySelectorAll('th,td'))cell.textContent='A longer explanation with naturally wrapping words. '.repeat(12);
                const cell=probe.querySelector('td')??probe.querySelector('th');
                const wrapped=wrapper.scrollWidth<=wrapper.clientWidth+2&&cell.getBoundingClientRect().height>parseFloat(getComputedStyle(cell).lineHeight)*2;
                if(!wrapped)throw new Error('Table prose did not wrap within the message width');
                const fixed=document.createElement('span');fixed.style.whiteSpace='nowrap';fixed.textContent='W'.repeat(300);cell.replaceChildren(fixed);
                const wide=wrapper.scrollWidth>wrapper.clientWidth+100;
                wrapper.scrollLeft=150;
                const local=wrapper.scrollLeft>0&&wrapper.getBoundingClientRect().width<=wrapper.parentElement.getBoundingClientRect().width+2;
                stress={proseWrapped:wrapped,wideOverflow:wide,localScroll:local,wrapperWidth:wrapper.clientWidth,wideScrollWidth:wrapper.scrollWidth,scrollLeft:wrapper.scrollLeft};
                if(!wide||!local)throw new Error('Unshrinkable table content escaped its local scrolling boundary');
              } finally {probe.replaceWith(original);wrapper.scrollLeft=oldScroll;}
              return {tables:facts,stress};})()
            """);
        if(tableLayoutRaw is "null" or "undefined") throw new InvalidOperationException("Reader table layout audit did not finish");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".table-layout.json"),tableLayoutRaw);
        foreach(var (selector, suffix) in new[]{("[data-audit-user-lines]", "user-lines"),(".cloudig-diagram:is([data-diagram-format=mermaid],[data-diagram-format=markmap],[data-diagram-format=svg])", "diagram"),(".cloudig-message-content > .cloudig-rich pre", "code"),(".cloudig-rich div[style*='border-radius']", "rich-card"),(".cloudig-rich table", "table"),(".cloudig-rich section:has(h2)", "rich-section"),(".cloudig-message:has(.cloudig-attachment-thumbnail)", "attachment")})
        {
            var located=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const target=document.querySelector({{JsonSerializer.Serialize(selector)}}),s=document.querySelector('[data-reader-conversation-scroll]');if(!target)return false;s.scrollTop+=target.getBoundingClientRect().top-s.getBoundingClientRect().top-16;return true;})()
                """);
            if(located!="true") continue;
            await Task.Delay(80);
            await using var capture=File.Create(Path.ChangeExtension(audit.OutputFile,$".{suffix}.png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
            if(suffix=="diagram")
            {
                var switched=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const card=document.querySelector({{JsonSerializer.Serialize(selector)}}),button=card?.querySelector('[data-diagram-view="source"]');if(!button)return false;button.click();return true;})()
                    """);
                if(switched=="true")
                {
                    await Task.Delay(80);
                    await using var sourceCapture=File.Create(Path.ChangeExtension(audit.OutputFile,".diagram-source.png"));
                    await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,sourceCapture);
                    await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(selector)})?.querySelector('[data-diagram-view=diagram]')?.click()");
                }
            }
        }
        // A loaded resource may still be a completely black or clipped chart.
        // The atlas shows every diagram, not just the first successful image;
        // it is an audit-only overview, not a substitute for the page captures.
        var atlasCountRaw = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.cloudig-diagram-display > img').length");
        var atlasCount = int.Parse(atlasCountRaw);
        for(var page = 0; page * 4 < atlasCount; page++)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{document.querySelector('[data-diagram-audit-atlas]')?.remove();
                  const pictures=[...document.querySelectorAll('.cloudig-diagram-display > img')].slice({{page * 4}},{{page * 4 + 4}});
                  const atlas=document.createElement('div');atlas.dataset.diagramAuditAtlas='';
                  atlas.style.cssText='position:fixed;inset:0;z-index:2147483647;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:12px;padding:12px;background:#e8e5df;box-sizing:border-box';
                  for(const [i,picture] of pictures.entries()){const cell=document.createElement('section');cell.style.cssText='min-width:0;min-height:0;display:grid;grid-template-rows:26px 1fr;padding:8px;background:'+getComputedStyle(picture.parentElement).backgroundColor;
                    const label=document.createElement('div');label.textContent='Diagram '+({{page * 4}}+i+1)+' / '+(picture.parentElement.dataset.renderer??'captured');label.style.cssText='color:#222;font:14px Segoe UI';
                    const image=picture.cloneNode();image.loading='eager';image.style.cssText='height:100%;width:100%;max-width:100%;max-height:100%;min-height:0;object-fit:contain';cell.append(label,image);atlas.append(cell);}
                  document.body.append(atlas);})()
                """);
            await Task.Delay(120);
            await using var atlasCapture=File.Create(Path.ChangeExtension(audit.OutputFile,$".diagram-atlas-{page + 1}.png"));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,atlasCapture);
        }
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-diagram-audit-atlas]')?.remove()");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-reader-conversation-scroll]').scrollTop=0");
        var headings = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const nodes=[...document.querySelectorAll('[data-assistant-continuation=true]')];return {continuations:nodes.length,repeated_portraits:nodes.filter(n=>n.querySelector(':scope > .cloudig-message-header .cloudig-message-identity')).length,anchors:nodes.every(n=>!!n.id),avatars:document.querySelectorAll('.cloudig-avatar img').length};})()");
        using (var facts = JsonDocument.Parse(headings))
            if (facts.RootElement.GetProperty("repeated_portraits").GetInt32() != 0 || !facts.RootElement.GetProperty("anchors").GetBoolean()) throw new InvalidDataException("Continuation headings lost anchors or repeated portraits.");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".process-headings.json"), headings);
        foreach (var probe in new[] { (Selector: ".cloudig-image img", Suffix: ".image.png"), (Selector: "[data-assistant-continuation=true]", Suffix: ".process-headings.png") })
        {
            var selected = await WebView.CoreWebView2.ExecuteScriptAsync($"(()=>{{const n=document.querySelector({JsonSerializer.Serialize(probe.Selector)});if(!n)return false;n.scrollIntoView({{block:'center',behavior:'instant'}});return true;}})()");
            if (selected != "true") continue;
            await Task.Delay(100);
            await using var picture = File.Create(Path.ChangeExtension(audit.OutputFile, probe.Suffix));
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, picture);
        }
        TraceVisualAudit("reader-resource-scroll-passed",result.ToString());
    }

    private async Task VerifyConversationImagesAsync(VisualAuditOptions audit)
    {
        var pointRaw = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const d=document.querySelector('.cloudig-conversation-images');if(!d)return null;
              if(d.open||d.querySelector('img'))throw new Error('Conversation images loaded before opening');
              const n=d.querySelector(':scope > summary');n.scrollIntoView({block:'center',behavior:'instant'});
              const r=n.getBoundingClientRect(),x=r.left+Math.min(40,r.width/2),y=r.top+r.height/2;
              if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Image gallery is obstructed');return {x,y};})()
            """);
        if(pointRaw=="null") return;
        using(var point=JsonDocument.Parse(pointRaw))
            foreach(var type in new[]{"mouseMoved","mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{
                    type,x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble(),
                    button=type=="mouseMoved"?"none":"left",buttons=type=="mousePressed"?1:0,clickCount=type=="mouseMoved"?0:1
                }));
        var loaded=false;
        for(var attempt=0;attempt<100;attempt++)
        {
            var ok=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const d=document.querySelector('.cloudig-conversation-images');d.querySelectorAll('img').forEach(i=>i.loading='eager');return d.open&&d.querySelectorAll('img').length>0&&!d.querySelector('.cloudig-resource-state,[data-cloudig-resource-error=true]')&&[...d.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0);})()");
            if(ok=="true"){loaded=true;break;} await Task.Delay(100);
        }
        if(!loaded)throw new InvalidDataException("Conversation images did not load from saved resources.");
        var result=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const d=document.querySelector('.cloudig-conversation-images'),r=d.getBoundingClientRect(),s=document.querySelector('[data-reader-conversation-scroll]').getBoundingClientRect();return {images:d.querySelectorAll('img').length,syntheticMessages:d.querySelectorAll('.cloudig-message,.cloudig-avatar').length,fits:r.left>=s.left-1&&r.right<=s.right+1};})()");
        using(var facts=JsonDocument.Parse(result))
            if(facts.RootElement.GetProperty("syntheticMessages").GetInt32()!=0||!facts.RootElement.GetProperty("fits").GetBoolean())throw new InvalidDataException("Conversation gallery changed message layout.");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".conversation-images.json"),result);
        await using var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".conversation-images.png"));
        await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
    }

    private async Task VerifyReaderPaginationEndpointAsync(VisualAuditOptions audit, int expected, string? lastMessage, string? lastNavigation)
    {
        var facts = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
            (()=>{const messages=[...document.querySelectorAll('.cloudig-message')];
              return {messages:messages.length,last_message:messages.at(-1)?.id??null};})()
            """);
        using(var document=JsonDocument.Parse(facts))
            if(document.RootElement.GetProperty("messages").GetInt32()!=expected || document.RootElement.GetProperty("last_message").GetString()!=lastMessage)
                throw new InvalidDataException($"Reader did not reach the expected default path: {facts}");
        if(lastNavigation is not null)
        {
            // Start at the top: a button click must really bring the last item
            // into view and must paginate navigation too (>200 in real Samples).
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-reader-conversation-scroll]').scrollTop=0");
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const b=document.querySelector('[data-reader-navigation-jump=last]');if(!b||b.disabled)return null;const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return b.contains(document.elementFromPoint(x,y))?{x,y}:null;})()");
            if(raw=="null") throw new InvalidDataException("Reader last-navigation control is not reachable");
            using var point=JsonDocument.Parse(raw);
            foreach(var type in new[]{"mousePressed","mouseReleased"})
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new {
                    type,x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble(),button="left",buttons=type=="mousePressed"?1:0,clickCount=1
                }));
            var reached=false;
            for(var attempt=0;attempt<300;attempt++)
            {
                var visible=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const n=document.getElementById({{JsonSerializer.Serialize(lastNavigation)}}),s=document.querySelector('[data-reader-conversation-scroll]');
                      if(!n)return false;const r=n.getBoundingClientRect(),b=s.getBoundingClientRect();return r.height>0&&r.top<b.bottom&&r.bottom>b.top;})()
                    """);
                if(visible=="true") { reached=true;break; }
                await Task.Delay(100);
            }
            if(!reached)
            {
                var diagnostic=await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const s=document.querySelector('[data-reader-conversation-scroll]'),n=document.getElementById({{JsonSerializer.Serialize(lastNavigation)}}),list=document.querySelector('[data-reader-navigation-list]');
                      return {expected:{{JsonSerializer.Serialize(lastNavigation)}},target:n?{rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display}:null,
                        scroll:{top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,rect:s.getBoundingClientRect().toJSON()},navigation:{count:list.children.length,current:[...list.children].findIndex(e=>e.dataset.current==='true')},
                        messages:[...document.querySelectorAll('.cloudig-message')].slice(-3).map(m=>({id:m.id,rect:m.getBoundingClientRect().toJSON()}))};})()
                    """);
                await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".navigation-failure.json"),diagnostic);
                await using var failureCapture=File.Create(Path.ChangeExtension(audit.OutputFile,".navigation-failure.png"));
                await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,failureCapture);
                throw new InvalidDataException("Reader last-navigation pointer did not reach its actual endpoint");
            }
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".pagination.json"),JsonSerializer.Serialize(new {expected_messages=expected,last_message=lastMessage,last_navigation=lastNavigation,pointer_last=lastNavigation is not null,observed=JsonSerializer.Deserialize<JsonElement>(facts)}));
        await using var capture=File.Create(Path.ChangeExtension(audit.OutputFile,".last-message.png"));
        await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,capture);
        TraceVisualAudit("reader-complete-pagination-passed",facts);
    }

    private async Task VerifyReaderBranchRoundtripAsync(VisualAuditOptions audit)
    {
        var initial = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const button=document.querySelector('.cloudig-message-user [data-branch-child]:not(:disabled)')??document.querySelector('[data-branch-child]:not(:disabled)');
              if(!button)return null;
              const group=button.closest('[data-branch-parent]');
              if(!group.getBoundingClientRect().height)throw new Error('Message branch control is hidden');
              const find=()=>[...document.querySelectorAll('[data-branch-parent]')].find(n=>n.dataset.branchParent===group.dataset.branchParent);
              window.__cloudigBranchAudit={find,parent:group.dataset.branchParent,original:group.dataset.branchSelected,target:button.dataset.branchChild,old:group};
              const a=window.__cloudigBranchAudit;
              return {parent:a.parent,original:a.original,target:a.target};})()
            """);
        if(initial=="null") return;
        try
        {
            foreach(var restoring in new[]{false,true})
            {
                // A rebuilt branch exists before its lazy images finish sizing.
                // Wait for a stable hit point instead of clicking coordinates
                // measured during that layout change, especially on restoration.
                string position = "null", previousPosition = "";
                var stablePositions = 0;
                for(var layoutAttempt=0;layoutAttempt<100;layoutAttempt++)
                {
                    position = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const a=window.__cloudigBranchAudit,g=a.find();a.old=g;
                      const button=[...g.querySelectorAll('[data-branch-child]')].find(b=>b.dataset.branchChild==={{(restoring ? "a.original" : "a.target")}});
                      document.querySelectorAll('.cloudig-resource-image').forEach(i=>i.loading='eager');
                      button.scrollIntoView({block:'center',behavior:'instant'});const r=button.getBoundingClientRect(),nav=button.closest('.reader-message-branches'),article=button.closest('.cloudig-message,.cloudig-message-envelope'),body=[...article.querySelectorAll('.cloudig-message-content')].at(-1).getBoundingClientRect();
                      const x=r.left+r.width/2,y=r.top+r.height/2;
                      const pending=[...document.querySelectorAll('.cloudig-resource-image,.cloudig-avatar img')].filter(i=>!i.complete).length;
                      const loading=[...document.querySelectorAll('.cloudig-resource-state')].some(n=>/正在|loading/i.test(n.textContent));
                      return {x,y,pending,loading,hit:document.elementFromPoint(x,y)?.closest('button')===button,separateRow:nav.parentElement===article&&nav.getBoundingClientRect().top>=body.bottom+4};})()
                    """);
                    using var layout = JsonDocument.Parse(position);
                    stablePositions = position==previousPosition && layout.RootElement.GetProperty("pending").GetInt32()==0 && !layout.RootElement.GetProperty("loading").GetBoolean() ? stablePositions+1 : 0;
                    if(stablePositions>=3) break;
                    previousPosition=position;
                    await Task.Delay(100);
                }
                if(stablePositions<3) throw new InvalidOperationException($"Reader branch hit point did not settle: {position}");
                using (var point = JsonDocument.Parse(position))
                {
                    if (!point.RootElement.GetProperty("hit").GetBoolean() || !point.RootElement.GetProperty("separateRow").GetBoolean())
                        throw new InvalidOperationException($"Branch controls are obscured or overlap the message bubble: {position}");
                    foreach (var type in new[] { "mousePressed", "mouseReleased" })
                        await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = point.RootElement.GetProperty("x").GetDouble(), y = point.RootElement.GetProperty("y").GetDouble(), button = "left", clickCount = 1 }));
                }
                TraceVisualAudit("reader-branch-native-pointer-passed", position);
                var completed=false;
                for(var attempt=0;attempt<150;attempt++)
                {
                    var condition=restoring ? "a.find()?.dataset.branchSelected===a.original" : "a.find()?.dataset.branchSelected===a.target";
                    var result=await WebView.CoreWebView2.ExecuteScriptAsync($"(()=>{{const a=window.__cloudigBranchAudit;return !a.old.isConnected&&({condition});}})()");
                    if(result=="true") { completed=true; break; }
                    await Task.Delay(100);
                }
                if(!completed) throw new InvalidOperationException($"Reader branch {(restoring ? "restore" : "switch")} did not replace the actual message path.");
            }
            await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".branch-roundtrip.json"),initial);
            TraceVisualAudit("reader-branch-switch-and-restore-passed",initial);
        }
        finally { await WebView.CoreWebView2.ExecuteScriptAsync("delete window.__cloudigBranchAudit"); }
    }

    private static string PrepareBookmarkAuditProfile(string deviceRoot)
    {
        // Explicit offscreen audit only. Never redirect a normal installation,
        // and never exercise mutations against the user's actual Chrome profile.
        var chromeRoot = Path.Combine(deviceRoot, "BookmarkAudit", "User Data");
        var profile = Path.Combine(chromeRoot, "Default");
        Directory.CreateDirectory(profile);
        File.WriteAllText(Path.Combine(chromeRoot, "Local State"), """{"profile":{"last_used":"Default","info_cache":{"Default":{"name":"Isolated installation test"}}}}""", new UTF8Encoding(false));
        var file = Path.Combine(profile, "Bookmarks");
        if (!File.Exists(file))
        {
            var document = System.Text.Json.Nodes.JsonNode.Parse("""
                {"version":1,"checksum":"","roots":{
                  "bookmark_bar":{"id":"1","guid":"00000000-0000-4000-8000-000000000001","name":"Bookmarks bar","type":"folder","children":[{"id":"4","guid":"00000000-0000-4000-8000-000000000004","name":"Unrelated bookmark","type":"url","url":"https://example.com/keep"}]},
                  "other":{"id":"2","guid":"00000000-0000-4000-8000-000000000002","name":"Other","type":"folder","children":[]},
                  "synced":{"id":"3","guid":"00000000-0000-4000-8000-000000000003","name":"Mobile","type":"folder","children":[]}}}
                """)!.AsObject();
            for (var index = 0; index < 400; index++)
                document["roots"]!["bookmark_bar"]!["children"]!.AsArray().Add(new System.Text.Json.Nodes.JsonObject {
                    ["id"]=(index+100).ToString(), ["guid"]=Guid.NewGuid().ToString("D"), ["name"]=$"Audit folder {index:D3}", ["type"]="folder",
                    ["date_added"]="0", ["date_modified"]="0", ["children"]=new System.Text.Json.Nodes.JsonArray()
                });
            var checksum = Cloudig.Bookmarks.ChromeBookmarkChecksums.Compute(document);
            document["checksum"] = checksum.Md5;
            document["checksum_sha256"] = checksum.Sha256;
            File.WriteAllText(file, document.ToJsonString(), new UTF8Encoding(false));
        }
        return chromeRoot;
    }

    private async Task VerifyBookmarkInstallAsync(VisualAuditOptions audit)
    {
        var results = new List<JsonElement>();
        if (audit.Width <= 1320)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('[data-archiver-bookmark-expand]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
            using var toggle = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x = toggle.RootElement.GetProperty("x").GetDouble(), y = toggle.RootElement.GetProperty("y").GetDouble(), button = "left", clickCount = 1 }));
            await Task.Delay(250);
        }
        foreach (var selector in new[] { "[data-bookmark-platform='chatgpt'][data-bookmark-operation='install']", "[data-bookmark-install-all]" })
        {
            var position = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{ document.querySelectorAll('.cloudig-notice-layer').forEach(n=>n.remove());
                  const b=document.querySelector({{JsonSerializer.Serialize(selector)}}); if(!b||b.disabled) return {hit:false, reason:'Installation button unavailable',buttons:[...document.querySelectorAll('.archiver-bookmark-install')].map(b=>({platform:b.dataset.bookmarkPlatform,operation:b.dataset.bookmarkOperation,disabled:b.disabled})),error:document.querySelector('.archiver-bookmark-status')?.textContent};
                  b.scrollIntoView({block:'nearest',inline:'nearest'}); const r=b.getBoundingClientRect();
                  const x=r.left+r.width/2,y=r.top+r.height/2;
                  return {x,y,hit:document.elementFromPoint(x,y)?.closest('button')===b}; })()
                """);
            using var point = JsonDocument.Parse(position);
            if (!point.RootElement.TryGetProperty("hit", out var hit) || !hit.GetBoolean()) throw new InvalidOperationException($"Bookmark button is covered: {selector}; {position}");
            var x = point.RootElement.GetProperty("x").GetDouble();
            var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", clickCount = 1 }));
            JsonElement outcome = default;
            for (var attempt = 0; attempt < 100; attempt++)
            {
                await Task.Delay(100);
                var raw = await WebView.CoreWebView2.ExecuteScriptAsync("({notice:document.querySelector('.cloudig-notice')?.textContent??'',error:document.querySelector('[role=alertdialog]')?.textContent??'',busy:document.querySelector('.archiver-page')?.dataset.bookmarkBusy==='true'})");
                using var value = JsonDocument.Parse(raw);
                outcome = value.RootElement.Clone();
                var notice = outcome.GetProperty("notice").GetString() ?? "";
                if (notice.Contains("安装完成", StringComparison.Ordinal) || notice.Contains("installed", StringComparison.OrdinalIgnoreCase) || outcome.GetProperty("error").GetString() is { Length: > 0 }) break;
            }
            if (string.IsNullOrEmpty(outcome.GetProperty("notice").GetString()) || !string.IsNullOrEmpty(outcome.GetProperty("error").GetString()))
                throw new InvalidOperationException($"Bookmark pointer-to-install failed: {selector}; {outcome}");
            results.Add(outcome);
            if (audit.Query.Contains("language=en", StringComparison.Ordinal))
                await CheckEnglishLayoutGeometryAsync(audit, results.Count == 1 ? "single-installed" : "all-installed");
        }
        var file = Path.Combine(_layout.DeviceRoot, Path.GetFileNameWithoutExtension(audit.OutputFile), "BookmarkAudit", "User Data", "Default", "Bookmarks");
        var contents = await File.ReadAllTextAsync(file);
        if (!contents.Contains("https://example.com/keep", StringComparison.Ordinal) || !contents.Contains("javascript:", StringComparison.Ordinal))
            throw new InvalidOperationException("Isolated bookmark install did not preserve unrelated content or write bookmarklets.");
        var gearRaw = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{document.querySelectorAll('.cloudig-notice-layer').forEach(n=>n.remove());const b=document.querySelector('[data-bookmark-target-settings]');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))};})()");
        using (var gear = JsonDocument.Parse(gearRaw))
        {
            if (!gear.RootElement.GetProperty("hit").GetBoolean()) throw new InvalidOperationException("Bookmark settings gear is covered");
            foreach (var type in new[] { "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x=gear.RootElement.GetProperty("x").GetDouble(), y=gear.RootElement.GetProperty("y").GetDouble(), button="left", clickCount=1 }));
        }
        var targets = await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const p=document.querySelector('[data-bookmark-target-popover]'),options=[...p.querySelector('select[data-bookmark-target-parent]').options],body=p.querySelector('.archiver-bookmark-target-body');const gaps=[...body.querySelectorAll('label:not(.cloudig-choice)')].map(l=>{const[a,b]=l.children;return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom;});return {open:!p.hidden,count:options.length,last:options.some(o=>o.textContent.includes('Audit folder 399')&&!o.disabled),gaps,height:p.getBoundingClientRect().height,scroll:body.scrollHeight>body.clientHeight+1};})()");
        using (var choices = JsonDocument.Parse(targets))
            if (!choices.RootElement.GetProperty("open").GetBoolean() || !choices.RootElement.GetProperty("last").GetBoolean()
                || choices.RootElement.GetProperty("gaps").EnumerateArray().Any(value=>Math.Abs(value.GetDouble()-5)>.2)
                || choices.RootElement.GetProperty("scroll").GetBoolean())
                throw new InvalidOperationException($"Bookmark target chooser lost later folders: {targets}");
        TraceVisualAudit("bookmark-complete-target-list-passed", targets);
        await using (var preview = File.Create(Path.ChangeExtension(audit.OutputFile, ".bookmark-targets.png")))
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, preview);
        foreach (var type in new[] { "keyDown", "keyUp" })
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key="Escape", code="Escape", windowsVirtualKeyCode=27 }));
        if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-bookmark-target-popover]').hidden") != "true")
            throw new InvalidOperationException("Bookmark settings did not close after native Escape");
        if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.archiver-page').dataset.bookmarkExpanded==='true'") == "true")
        {
            // At narrow widths the rail itself is also an intentional overlay.
            // Finish both interactions before checking background hit targets.
            foreach (var type in new[] { "keyDown", "keyUp" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key="Escape", code="Escape", windowsVirtualKeyCode=27 }));
            if (await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.archiver-page').dataset.bookmarkExpanded==='false'") != "true")
                throw new InvalidOperationException("Narrow bookmark rail did not close after native Escape");
            await Task.Delay(250);
        }
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".bookmark-install.json"), JsonSerializer.Serialize(new { scope = "isolated audit profile only", results }, new JsonSerializerOptions { WriteIndented = true }));
        TraceVisualAudit("bookmark-pointer-install-and-all-passed");
    }

    private async Task VerifyConversationEndpointStripAsync(VisualAuditOptions audit)
    {
        async Task ClickAsync(string selector)
        {
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;
                n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
            if(raw=="null") throw new InvalidDataException($"Endpoint control is obstructed: {selector}");
            using var point=JsonDocument.Parse(raw);
            foreach(var type in new[]{"mousePressed","mouseReleased"}) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",JsonSerializer.Serialize(new{
                type,x=point.RootElement.GetProperty("x").GetDouble(),y=point.RootElement.GetProperty("y").GetDouble(),button="left",buttons=type=="mousePressed"?1:0,clickCount=1}));
            await Task.Delay(100);
        }
        async Task<JsonElement> MeasureAsync()
        {
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync("""
                (()=>{const row=document.querySelector('.conversation-info-other-endpoint'),b=row.querySelector('[data-conversation-edit-other]'),r=b.getBoundingClientRect(),s=getComputedStyle(b),label=row.querySelector('strong'),same=row.querySelector('[data-conversation-other-same]'),confirm=row.querySelector('[data-conversation-time-confirm]');
                const available=row.getBoundingClientRect().width-label.getBoundingClientRect().width-parseFloat(getComputedStyle(label).marginRight)-(same.hidden?0:same.getBoundingClientRect().width+parseFloat(getComputedStyle(same).marginRight))-confirm.getBoundingClientRect().width-parseFloat(s.marginRight);
                const topLabel=document.querySelector('[data-conversation-endpoint-label]'),topStyle=getComputedStyle(topLabel),bottomStyle=getComputedStyle(label);
                const terran=document.querySelector('.conversation-info-endpoint-tabs > [data-conversation-axis=terran]');
                return {endpoint:row.dataset.endpoint,width:r.width,height:r.height,available,color:s.color,background:s.backgroundColor,border:s.borderTopWidth,border_color:s.borderTopColor,font:s.fontSize,extra_now:!!row.querySelector('[data-conversation-other-now]'),
                  choices:same.hidden?null:{circle_left_delta:same.querySelector('i').getBoundingClientRect().left-terran.querySelector('i').getBoundingClientRect().left,text_left_delta:same.querySelector('span').getBoundingClientRect().left-terran.querySelector('span').getBoundingClientRect().left},
                  labels:{top_font:topStyle.fontSize,bottom_font:bottomStyle.fontSize,top_weight:topStyle.fontWeight,bottom_weight:bottomStyle.fontWeight,top_line:topStyle.lineHeight,bottom_line:bottomStyle.lineHeight,left_delta:label.getBoundingClientRect().left-topLabel.getBoundingClientRect().left}};})()
                """);
            using var doc=JsonDocument.Parse(raw); var item=doc.RootElement.Clone();
            var night=audit.Query.Contains("theme=star-night",StringComparison.Ordinal);
            var choices=item.GetProperty("choices");
            if(choices.ValueKind!=JsonValueKind.Null && (Math.Abs(choices.GetProperty("circle_left_delta").GetDouble())>.5 || Math.Abs(choices.GetProperty("text_left_delta").GetDouble())>.5)) throw new InvalidDataException($"Endpoint choices are not in the same column: {choices}");
            var labels=item.GetProperty("labels");
            if(labels.GetProperty("top_font").GetString()!="18px" || labels.GetProperty("bottom_font").GetString()!="18px"
                || labels.GetProperty("top_weight").GetString()!="700" || labels.GetProperty("bottom_weight").GetString()!="700"
                || labels.GetProperty("top_line").GetString()!=labels.GetProperty("bottom_line").GetString()
                || Math.Abs(labels.GetProperty("left_delta").GetDouble())>.5) throw new InvalidDataException($"Endpoint labels differ in size or left edge: {labels}");
            if(item.GetProperty("extra_now").GetBoolean() || Math.Abs(item.GetProperty("width").GetDouble()-item.GetProperty("available").GetDouble())>.6
                || Math.Abs(item.GetProperty("height").GetDouble()-40)>.1 || item.GetProperty("font").GetString()!="18px"
                || item.GetProperty("background").GetString()!=(night?"rgb(45, 45, 45)":"rgb(174, 139, 127)")
                || item.GetProperty("color").GetString()!=(night?"rgb(226, 225, 225)":"rgb(45, 45, 45)")
                || item.GetProperty("border").GetString()!=(night?"2px":"0px")
                || (night&&item.GetProperty("border_color").GetString()!="rgb(81, 37, 165)")) throw new InvalidDataException($"Endpoint field differs from AI: {item}");
            return item;
        }
        var end=await MeasureAsync();
        await WebView.CoreWebView2.ExecuteScriptAsync("for(const [field,value] of [['year','1990'],['month','6'],['day','22']]){const n=document.querySelector('[data-point-band=historical] [data-endpoint-field='+field+']');n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}");
        await ClickAsync("[data-conversation-edit-other]"); var start=await MeasureAsync();
        if(start.GetProperty("endpoint").GetString()!="start" || start.GetProperty("width").GetDouble()<=end.GetProperty("width").GetDouble()+90) throw new InvalidDataException("Editing the end must leave a wider start field below.");
        await using(var stream=File.Create(Path.ChangeExtension(audit.OutputFile,".editing-end.png"))) await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);
        await ClickAsync("label:has([data-point-mode][value=now])"); await ClickAsync("[data-conversation-time-confirm]");
        var confirmed=false;
        for(var attempt=0;attempt<80;attempt++)
        {
            if(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-conversation-time-display]').textContent.includes(document.documentElement.lang==='en'?'Now':'现今')&&!document.querySelector('[data-conversation-time-warning]').textContent") == "true") {confirmed=true;break;}
            await Task.Delay(50);
        }
        if(!confirmed) throw new InvalidDataException("Expanded Now did not confirm through the endpoint editor.");
        await ClickAsync("[data-conversation-edit-other]"); await MeasureAsync();
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile,".endpoints.json"),JsonSerializer.Serialize(new{end,start,confirmed,native_pointer=true}));
        TraceVisualAudit("conversation-endpoint-strip-passed");
    }

    private async Task VerifyConversationModalAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal) || _libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Conversation modal audit requires its own record Library.");
        Dictionary<string, string> Snapshot() => new[] { "Conversations", "Marks" }.SelectMany(folder => Directory.GetFiles(Path.Combine(library, folder), "*", System.IO.SearchOption.AllDirectories))
            .ToDictionary(file => file, file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
        var before = Snapshot();
        var theme = audit.Query.Contains("theme=star-night", StringComparison.Ordinal) ? "star-night" : "dawn";
        var surfaces = new List<object>();
        async Task WaitAsync(string condition)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await WebView.CoreWebView2.ExecuteScriptAsync(condition) == "true") return;
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Conversation modal state timed out: {condition}");
        }
        async Task ClickAsync(string selector, bool backdrop = false)
        {
            var raw = "null";
            for (var attempt = 0; attempt < 60 && raw == "null"; attempt++)
            {
                raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;
                    if(!{{JsonSerializer.Serialize(backdrop)}})n.scrollIntoView({block:'nearest'});
                    const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
                    return r.width&&r.height&&({{JsonSerializer.Serialize(backdrop)}}?hit?.matches('.conversation-info-layer'):n.contains(hit))?{x,y}:null;})()
                    """);
                if (raw == "null") await Task.Delay(50);
            }
            if (raw == "null") throw new InvalidDataException($"Conversation modal control or backdrop is obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mousePressed", "mouseReleased" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {
                type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
        }
        async Task CheckSurfaceAsync(string page)
        {
            var expected = WindowSurfaceStyles.Resolve(theme, page);
            for (var attempt = 0; attempt < 100; attempt++)
            {
                var routeMatches = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                    document.querySelector('.app-root').dataset.route==={{JsonSerializer.Serialize(page)}}&&!!document.querySelector('[data-page="'+{{JsonSerializer.Serialize(page)}}+'"]')&&!document.querySelector('.route-host').inert
                    """) == "true";
                // Observe the actual IPC-driven WPF brush; never repair it from the test.
                if (routeMatches && TitleBar.Background is LinearGradientBrush brush && brush.GradientStops.Count == expected.Stops.Count
                    && brush.GradientStops.Select((stop, index) => stop.Color == MediaColor(expected.Stops[index].Color) && Math.Abs(stop.Offset - expected.Stops[index].Offset) < .0001).All(match => match))
                {
                    surfaces.Add(new { page, theme, stops = brush.GradientStops.Select(stop => new { color = stop.Color.ToString(), offset = stop.Offset }).ToArray() });
                    return;
                }
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Conversation modal left the route or native titlebar on the wrong surface: {page}");
        }
        async Task CaptureAsync(string suffix) { await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream); }
        const string editorReady = "document.querySelector('.app-root').dataset.route.startsWith('conversation/info/')&&document.querySelector('.route-host').inert&&document.querySelector('[data-conversation-info-dialog]')?.getAttribute('aria-modal')==='true'";
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archiver-workflow-close]')?.click()");
        await ClickAsync("[data-archive-edit]");
        await WaitAsync(editorReady);
        await CaptureAsync(".editor");
        await ClickAsync(".archiver-brand", backdrop: true);
        await WaitAsync("!document.querySelector('.conversation-info-layer')");
        await CheckSurfaceAsync("archiver");
        await ClickAsync(".archiver-brand");
        await CheckSurfaceAsync("welcome");
        await ClickAsync(".welcome-archiver-button");
        await CheckSurfaceAsync("archiver");
        await ClickAsync("[data-archive-edit]");
        await WaitAsync(editorReady);
        await WebView.CoreWebView2.ExecuteScriptAsync("const n=document.querySelector('[data-conversation-name]');n.value='Modal unsaved title';n.dispatchEvent(new Event('input',{bubbles:true}));");
        await ClickAsync(".archiver-brand", backdrop: true);
        await WaitAsync("!document.querySelector('[data-conversation-info-confirm]').hidden&&document.querySelector('[data-conversation-info-dialog]').inert");
        await CaptureAsync(".discard-confirmation");
        await ClickAsync("[data-conversation-confirm-secondary]");
        await WaitAsync("document.querySelector('[data-conversation-info-confirm]').hidden&&!document.querySelector('[data-conversation-info-dialog]').inert&&document.querySelector('[data-conversation-name]').value==='Modal unsaved title'");
        await ClickAsync(".archiver-brand", backdrop: true);
        await WaitAsync("!document.querySelector('[data-conversation-info-confirm]').hidden");
        await ClickAsync("[data-conversation-confirm-primary]");
        await WaitAsync("!document.querySelector('.conversation-info-layer')");
        await CheckSurfaceAsync("archiver");
        var after = Snapshot();
        if (before.Count != after.Count || before.Any(pair => !after.TryGetValue(pair.Key, out var sha) || sha != pair.Value)) throw new InvalidDataException("Conversation modal cancellation changed Conversation or Mark files.");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".modal.json"), JsonSerializer.Serialize(new {
            native_pointer = true, outside_click_only_closes = true, dirty_stay_preserved = true, discarded_without_writes = true, surfaces }));
        TraceVisualAudit("conversation-modal-boundary-passed");
    }

    // Renderer-local mouse input does not move the system pointer or activate
    // the offscreen WPF window. Exercise actual CSS :hover, including leaving.
    private async Task VerifyDocumentNavigationHoverAsync()
    {
        var snapshot = await WebView.CoreWebView2.ExecuteScriptAsync("[...document.querySelectorAll('.archiver-doc-card li button')].map(b=>{const r=b.getBoundingClientRect();return {x:r.right-18,y:r.top+r.height/2,top:r.top,height:r.height};})");
        using var positions = JsonDocument.Parse(snapshot);
        if (positions.RootElement.GetArrayLength() != 6) throw new InvalidOperationException("Expected six document navigation entries.");
        foreach (var index in new[] { 0, -1, 4 })
        {
            var x = index < 0 ? 1 : positions.RootElement[index].GetProperty("x").GetDouble();
            var y = index < 0 ? 1 : positions.RootElement[index].GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
            await Task.Delay(420);
            var result = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (() => {
                  const entries = [...document.querySelectorAll('.archiver-doc-card li button')], initial = {{snapshot}}, index = {{index}};
                  const visible = entries.flatMap(b => [...b.querySelectorAll('img')]).filter(i => getComputedStyle(i).display !== 'none' && Number(getComputedStyle(i).opacity) > .01);
                  if (entries.some((b,n) => { const r=b.getBoundingClientRect(); return r.top !== initial[n].top || r.height !== initial[n].height; })) return false;
                  if (index < 0) return visible.length === 0 && entries.every(b => !b.matches(':hover'));
                  const entry=entries[index], r=entry.getBoundingClientRect(), wing=visible[0]?.getBoundingClientRect(), copy=entry.querySelector('span').getBoundingClientRect();
                  const expected=document.documentElement.dataset.theme === 'dawn' ? 'rgb(205, 125, 124)' : 'rgb(126, 94, 255)';
                  return entry.matches(':hover') && visible.length === 1 && entry.contains(visible[0]) && wing.left > copy.right+2 && wing.right <= r.right
                    && getComputedStyle(entry).backgroundColor === expected && document.elementFromPoint(r.right-18,r.top+r.height/2)?.closest('button') === entry;
                })()
                """);
            if (result != "true") throw new InvalidOperationException($"Document navigation hover failed at entry {index}.");
        }
        TraceVisualAudit("document-hover-enter-leave-passed");
    }

    // Explicit offscreen audit only: record one real 24s seasonal cycle, cropped
    // to the existing scene. No extra window, live-library writes or normal-run timer.
    private async Task CaptureRoosterMotionAsync(VisualAuditOptions audit, JsonElement facts)
    {
        var scene = facts.GetProperty("geometry").GetProperty("archiver_right_scene");
        var directory = Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, Path.GetFileNameWithoutExtension(audit.OutputFile) + ".motion");
        Directory.CreateDirectory(directory);
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.archiver-weather').getAnimations({subtree:true}).forEach(a => a.currentTime = 0)");
        var clock = Stopwatch.StartNew();
        var frames = new List<object>();
        for (var index = 0; index < 100 && clock.ElapsedMilliseconds < 24500; index++)
        {
            var started = clock.ElapsedMilliseconds;
            await using var buffer = new MemoryStream();
            await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, buffer);
            buffer.Position = 0;
            var bitmap = BitmapDecoder.Create(buffer, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
            var scale = bitmap.PixelWidth / (double)audit.Width;
            var left = Math.Max(0, (int)Math.Floor((scene.GetProperty("x").GetDouble() - 64) * scale));
            var top = Math.Max(0, (int)Math.Floor((scene.GetProperty("y").GetDouble() - 8) * scale));
            var crop = new CroppedBitmap(bitmap, new Int32Rect(left, top, bitmap.PixelWidth - left, bitmap.PixelHeight - top));
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(crop));
            var filename = $"frame-{index:D3}.png";
            using (var output = File.Create(Path.Combine(directory, filename))) encoder.Save(output);
            frames.Add(new { file = filename, elapsed_ms = started });
            await Task.Delay((int)Math.Max(1, 250 - (clock.ElapsedMilliseconds - started)));
        }
        await File.WriteAllTextAsync(Path.Combine(directory, "frames.json"), JsonSerializer.Serialize(frames, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));
    }

    private async Task MatchVisualAuditViewportAsync(VisualAuditOptions audit)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            UpdateLayout();
            var widthDifference = audit.Width - WebView.ActualWidth;
            var heightDifference = audit.Height - WebView.ActualHeight;
            if (Math.Abs(widthDifference) < .25 && Math.Abs(heightDifference) < .25)
            {
                ApplyViewportScale();
                await Dispatcher.Yield(DispatcherPriority.Render);
                return;
            }
            Width = Math.Max(MinWidth, Width + widthDifference);
            Height = Math.Max(MinHeight, Height + heightDifference);
            await Dispatcher.Yield(DispatcherPriority.Loaded);
            await Task.Delay(40);
        }
        throw new InvalidDataException($"Visual audit viewport remained {WebView.ActualWidth:0.##}x{WebView.ActualHeight:0.##} instead of {audit.Width}x{audit.Height}.");
    }

    private async Task VerifyViewportRoundtripAsync(VisualAuditOptions audit)
    {
        const string stateScript = "JSON.stringify({route:document.querySelector('.app-root').dataset.route,fields:[...document.querySelectorAll('input,textarea,select')].map(n=>[n.name,n.value,n.checked])})";
        var before = await WebView.CoreWebView2.ExecuteScriptAsync(stateScript);
        var restoreCatalog = audit.Query.TrimStart('?').Split('&').Contains("route=reader", StringComparer.Ordinal)
            && await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]')?.dataset.catalogCollapsed!=='true'") == "true";
        await MatchVisualAuditViewportAsync(audit with { Width = 1280, Height = 720 });
        await WaitForVisualAuditReadyAsync(audit with { Width = 1280, Height = 720 });
        if (Math.Abs(WebView.ZoomFactor - 1) > .00001) throw new InvalidDataException("Small viewport retained large-screen zoom.");
        await MatchVisualAuditViewportAsync(audit);
        await WaitForVisualAuditReadyAsync(audit);
        if (restoreCatalog && await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]')?.dataset.catalogCollapsed==='true'") == "true")
        {
            // Entering the narrow layout intentionally closes the overlay.
            // Prove the user's expand action at the restored large scale;
            // do not mistake a valid collapsed column for a scaling failure.
            var raw=await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('[data-reader-catalog-toggle=expand]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
            using var point=JsonDocument.Parse(raw);var x=point.RootElement.GetProperty("x").GetDouble();var y=point.RootElement.GetProperty("y").GetDouble();
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type="mouseMoved", x, y }));
            await Task.Delay(150);
            if(await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector('[data-reader-catalog-toggle=expand]').contains(document.elementFromPoint({x.ToString(System.Globalization.CultureInfo.InvariantCulture)},{y.ToString(System.Globalization.CultureInfo.InvariantCulture)}))")!="true")
                throw new InvalidDataException("Reader catalog expand is obstructed after resize.");
            foreach(var type in new[]{"mousePressed","mouseReleased"}) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
            await Task.Delay(150);
            if(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-page=reader]').dataset.catalogCollapsed==='false'")!="true")
                throw new InvalidDataException("Reader catalog did not reopen after resize.");
            TraceVisualAudit("viewport-catalog-restored-by-pointer");
        }
        if (before != await WebView.CoreWebView2.ExecuteScriptAsync(stateScript)) throw new InvalidDataException("Viewport resizing changed the active route or input values.");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.viewportRoundtrip='passed'");
        TraceVisualAudit("viewport-roundtrip-passed", $"{audit.Width}x{audit.Height};zoom={WebView.ZoomFactor:0.######}");
    }

    private async Task<JsonElement> WaitForVisualAuditReadyAsync(VisualAuditOptions audit)
    {
        const string script = """
            (() => {
              const app = document.querySelector('.app-root');
              const transition = document.querySelector('.route-transition');
              const transitionStyle = transition ? getComputedStyle(transition) : null;
              const selectors = {
                app_root: ".app-root",
                reader_catalog: "[data-page='reader'] .reader-catalog",
                reader_main: "[data-page='reader'] .reader-main",
                reader_navigation: "[data-page='reader'] .reader-navigation",
                reader_title: "[data-page='reader'] .reader-conversation-title",
                reader_toolbar: "[data-page='reader'] .reader-conversation-toolbar",
                reader_message_column: "[data-page='reader'] .reader-message-column",
                archiver_bookmarks: "[data-page='archiver'] .archiver-bookmark-rail",
                archiver_center: "[data-page='archiver'] .archiver-center",
                archiver_docs: "[data-page='archiver'] .archiver-docs-rail",
                archiver_parser: "[data-page='archiver'] .archiver-parser-workspace",
                archiver_archive: "[data-page='archiver'] .archiver-archive-workspace",
                archiver_source_header: "[data-page='archiver'] .archiver-source-columns",
                archiver_archive_header: "[data-page='archiver'] .archiver-archive-columns",
                archiver_library_address: "[data-page='archiver'] .archiver-library-address",
                archiver_topbar_actions: "[data-page='archiver'] .archiver-topbar-actions",
                archiver_selected_actions: "[data-page='archiver'] [data-archive-selected-actions]",
                archiver_delete_action: "[data-page='archiver'] [data-archive-action='delete']",
                archiver_workflow: "[data-page='archiver'] .archiver-workflow:not([hidden])",
                archiver_brand_title_dawn: "[data-page='archiver'] .archiver-brand-title.archiver-theme-dawn",
                archiver_brand_title_star_night: "[data-page='archiver'] .archiver-brand-title.archiver-theme-star-night",
                archiver_brand_slogan_dawn: "[data-page='archiver'] [data-archiver-slogan]",
                archiver_brand_slogan_star_night: "[data-page='archiver'] [data-archiver-slogan]",
                archiver_bookmark_panel: "[data-page='archiver'] .archiver-bookmark-panel",
                archiver_bookmark_profile: "[data-page='archiver'] .archiver-profile-selector",
                archiver_bookmark_all: "[data-page='archiver'] .archiver-install-all",
                archiver_bookmark_caption: "[data-page='archiver'] .archiver-bookmark-caption",
                archiver_bookmark_icon: "[data-page='archiver'] .archiver-bookmark-row > img",
                archiver_doc_card: "[data-page='archiver'] .archiver-doc-card",
                archiver_import_html: "[data-page='archiver'] [data-archiver-shell-action='import-html']",
                archiver_import_claude: "[data-page='archiver'] [data-archiver-shell-action='import-claude']",
                archiver_parse_settings_button: "[data-page='archiver'] [data-archiver-parse-settings]",
                archiver_parse_all: "[data-page='archiver'] .archiver-parse-all",
                archiver_cock: "[data-page='archiver'] .archiver-cock",
                archiver_right_scene: "[data-page='archiver'] .archiver-right-scene.archiver-theme-dawn",
                archiver_rock: "[data-page='archiver'] .archiver-rock",
                archiver_sunflower: "[data-page='archiver'] .archiver-sunflower",
                archiver_astronaut: "[data-page='archiver'] .archiver-astronaut"
              };
              const round = value => Math.round(value * 100) / 100;
              const mathStruts = [...document.querySelectorAll('.katex :is(.katex-strut, .strut)[style]')].filter(node => /em$/.test(node.style.height));
              const mathUnstyled = mathStruts.filter(node => Math.abs(parseFloat(getComputedStyle(node).height) - parseFloat(node.style.height) * parseFloat(getComputedStyle(node).fontSize)) > .6).length;
              const images = [...document.images];
              const visibleImages = images.filter(image => {
                const rect = image.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
              });
              const failedImages = images.filter(image => image.complete && image.currentSrc && image.naturalWidth === 0);
              const geometry = {};
              for (const [name, selector] of Object.entries(selectors)) {
                const node = document.querySelector(selector);
                if (!node) continue;
                const rect = node.getBoundingClientRect();
                if (!(rect.width > 0 && rect.height > 0)) continue;
                geometry[name] = {
                  x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
                  client_width: node.clientWidth, client_height: node.clientHeight,
                  scroll_width: node.scrollWidth, scroll_height: node.scrollHeight
                };
              }
              return JSON.stringify({
                parser_history_releases: document.querySelectorAll('[data-parser-release]').length,
                archive_information_layout: [...document.querySelectorAll('.archiver-info-copy')].filter(n=>n.getBoundingClientRect().height>0).map(n=>{
                  const box=n.getBoundingClientRect(), children=[...n.children].filter(c=>c.getBoundingClientRect().height>0).map(c=>c.getBoundingClientRect());
                  return {top:box.top,bottom:box.bottom,text_top:children.length?Math.min(...children.map(r=>r.top)):box.top,text_bottom:children.length?Math.max(...children.map(r=>r.bottom)):box.bottom,scroll_height:n.scrollHeight,client_height:n.clientHeight,scrollable:n.hasAttribute('data-scroll-region')&&getComputedStyle(n).overflowY==='auto'};
                }),
                archiver_scene: (()=>{
                  const root=document.querySelector('[data-page=archiver]:not([data-archiver-mode=claude]):not([data-archiver-mode=json])'),center=root?.querySelector('[data-archiver-center]');
                  if(!center)return null;
                  const scene=center.querySelector('.archiver-center-scenes'),rect=n=>n.getBoundingClientRect().toJSON(),style=getComputedStyle(root);
                  return {center:rect(center),scene:rect(scene),ratio:parseFloat(style.getPropertyValue('--archiver-parser-basis'))/100,gap:parseFloat(style.getPropertyValue('--archiver-scene-gap')),information_height:parseFloat(style.getPropertyValue('--archiver-information-height')),dragging:root.dataset.splitDragging==='true',
                    workspaces:[...center.querySelectorAll(':scope > .archiver-workspace')].map(rect),lists:[...center.querySelectorAll('.archiver-list-card')].map(rect),
                    images:[...scene.querySelectorAll('.archiver-wave,.archiver-village')].filter(n=>getComputedStyle(n).display!=='none').map(n=>({file:n.getAttribute('src').split('/').at(-1),box:rect(n),clip:getComputedStyle(n).clipPath})),
                    decorations:[...scene.querySelectorAll('.archiver-scene-decoration')].map(rect),
                    controls:[...center.querySelectorAll('.archiver-workspace-header button')].filter(n=>n.getBoundingClientRect().width>0).map(n=>{
                      const b=n.getBoundingClientRect(),h=n.closest('.archiver-workspace-header').getBoundingClientRect();
                      return {label:n.getAttribute('aria-label')||n.textContent,inside:b.left>=h.left-.2&&b.right<=h.right+.2&&b.top>=h.top-.2&&b.bottom<=h.bottom+.2,
                        hit:n.disabled||document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest('button')===n};
                    })};
                })(),
                time_picker_button: (() => {
                  const button = document.querySelector('.time-editor-node-selection .cloudig-button');
                  if (!button) return null;
                  const box = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
                  const text = range.getBoundingClientRect();
                  return {left:text.left-box.left,right:box.right-text.right,top:text.top-box.top,bottom:box.bottom-text.bottom};
                })(),
                conversation_time_layout: (() => {
                  const panel = document.querySelector('[data-conversation-info-dialog]');
                  if (!panel) return null;
                  const heading = panel.querySelector('.conversation-info-time-mode-actions h3').getBoundingClientRect();
                  const button = panel.querySelector('[data-conversation-time-open]').getBoundingClientRect();
                  const scene = panel.querySelector(document.documentElement.dataset.theme === 'star-night' ? '.conversation-info-scene-star-night' : '.conversation-info-scene-dawn');
                  return { preset_heading_center: round(heading.y + heading.height / 2), timeline_button_center: round(button.y + button.height / 2),
                    presets: [...panel.querySelectorAll('[data-conversation-presets] > button')].map(node => {const r=node.getBoundingClientRect();return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),scroll_width:node.scrollWidth};}),
                    scene_filter: getComputedStyle(scene).filter };
                })(),
                claude_layout: (() => {
                  const page=document.querySelector('[data-page="archiver"][data-archiver-mode="claude"]');if(!page)return null;
                  const quote=page.querySelector('.archiver-claude-quote'),button=page.querySelector('[data-claude-one-click]'),title=page.querySelector('.archiver-claude-title-main'),copy=title.querySelector('p');
                  const r=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);const t=range.getBoundingClientRect();
                  const h=title.getBoundingClientRect(),c=copy.getBoundingClientRect();
                  const popup=page.querySelector('[data-claude-settings-popover]'),gear=page.querySelector('[data-claude-settings]').getBoundingClientRect();
                  const menu=popup&&!popup.hidden?popup.getBoundingClientRect():null;
                  const countHeadings=[...page.querySelectorAll('.archiver-claude-columns > span')].slice(1,3).map(n=>{const b=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);const text=range.getBoundingClientRect();return {width:b.width,text_width:text.width,left:text.left,right:text.right};});
                  return {count_headings:countHeadings,header_text_fits:countHeadings.every(n=>n.text_width<=n.width+.5),quote_overflow:quote.scrollHeight-quote.clientHeight,button_left_inset:t.left-r.left,button_right_inset:r.right-t.right,facts_inside:c.left>=h.left&&c.right<=h.right,title_height:h.height,menu_below_anchor:menu?menu.top>=gear.bottom+8:null,menu_inside:menu?menu.bottom<=innerHeight-12:null};
                })(),
                input_controls: (() => {
                  const visible=node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0;
                  const zones=[...document.querySelectorAll('select.cloudig-endpoint-zone')].filter(visible).map(node=>{
                    const r=node.getBoundingClientRect(),f=node.closest('.cloudig-endpoint-input-frame').getBoundingClientRect();
                    return {left:r.left,right:r.right,frame_left:f.left,frame_right:f.right,value:node.value,options:node.options.length};
                  });
                  const note=document.querySelector('.archiver-settings-note');
                  const centers=note&&visible(note)?[note.querySelector('svg'),note.querySelector('span')].map(node=>{const r=node.getBoundingClientRect();return r.top+r.height/2;}):null;
                  const tick=document.querySelector('.reader-navigation-filters input:checked + i');
                  const s=tick&&visible(tick)?getComputedStyle(tick,'::after'):null;
                  const markFrame=s?getComputedStyle(tick):null;
                  const choices=[...document.querySelectorAll('.archiver-parse-settings-popover .cloudig-choice > span,.archiver-claude-settings-popover .cloudig-choice > span')].filter(visible).map(node=>{const s=getComputedStyle(node),mark=getComputedStyle(node,'::before');return{align:s.alignItems,margin:mark.marginTop};});
                  const time=document.querySelector('[data-conversation-time-display] strong');
                  return {timezones:zones,parse_note_centers:centers,parse_choice_alignment:choices,time_summary_lines:time?[...time.children].map(n=>n.textContent):null,navigation_mark:s?{left:s.left,top:s.top,width:s.width,height:s.height,mask:s.maskImage,frame_content_width:parseFloat(markFrame.width)-parseFloat(markFrame.borderLeftWidth)-parseFloat(markFrame.borderRightWidth),frame_content_height:parseFloat(markFrame.height)-parseFloat(markFrame.borderTopWidth)-parseFloat(markFrame.borderBottomWidth)}:null};
                })(),
                reader_search_hint: (() => {
                  const input=document.querySelector('[data-reader-search-input]');if(!input||!input.clientWidth)return null;
                  const s=getComputedStyle(input),context=document.createElement('canvas').getContext('2d');context.font=s.font;
                  const textWidth=context.measureText(input.placeholder).width,available=input.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight);
                  return {text:input.placeholder,text_width:textWidth,available_width:available,align:s.textAlign,fits:textWidth<=available+1};
                })(),
                reader_title_layout: (() => {
                  const content = document.querySelector('.reader-conversation-title-content');
                  const title = content?.querySelector('h1');
                  if (!title) return null;
                  const style = getComputedStyle(content);
                  const rail = document.querySelector('.reader-return-rail');
                  const bird = Array.from(document.querySelectorAll('.reader-return-birds')).find(node => getComputedStyle(node).display !== 'none');
                  const option = document.querySelector('.reader-navigation-filters label');
                  const header = content.closest('.reader-conversation-title').getBoundingClientRect();
                  const first = content.querySelector('.reader-conversation-summary-row').getBoundingClientRect();
                  const last = content.querySelector('.reader-conversation-facts').getBoundingClientRect();
                  return { mode: content.dataset.titleLayout, natural_width: Number(content.dataset.titleNaturalWidth), l1: Number(content.dataset.titleL1), l2: Number(content.dataset.titleL2), align: getComputedStyle(title).textAlign, padding_top: style.paddingTop, padding_bottom: style.paddingBottom, horizontal_overflow: title.scrollWidth - title.clientWidth, content_top_inset: first.top - header.top, content_bottom_inset: header.bottom - last.bottom, vertical_overflow: content.scrollHeight - header.height, rail_background: rail ? getComputedStyle(rail).backgroundColor : null, bird_shadow: bird ? getComputedStyle(bird).filter : null, option_border: option ? getComputedStyle(option).borderTopWidth : null };
                })(),
                document_surface: (()=>{const n=document.querySelector('.standard-document');if(!n)return null;const r=n.getBoundingClientRect(),h=n.parentElement.getBoundingClientRect(),s=n.querySelector('.standard-scroll');return {ready:n.dataset.documentReady==='true',inside:Math.abs(r.x-h.x)<1&&Math.abs(r.width-h.width)<1&&r.bottom<=innerHeight+1,scroll_owner:Boolean(s&&s.clientHeight>0&&s.scrollWidth<=s.clientWidth+1)};})(),
                ready: document.documentElement.dataset.ready === 'true',
                boot_state: document.documentElement.dataset.bootState ?? null,
                boot_error: document.documentElement.dataset.bootError ?? null,
                runtime_errors: Number(document.documentElement.dataset.runtimeErrors ?? 0),
                reader_open_stage: document.documentElement.dataset.readerOpenStage ?? null,
                conversation_ready: document.querySelector('[data-conversation-ready="true"]') !== null,
                math_struts: mathStruts.length,
                math_unstyled: mathUnstyled,
                route: app?.dataset.route ?? null,
                surface: app?.dataset.surface ?? null,
                theme: document.documentElement.dataset.theme ?? null,
                theme_roundtrip: document.documentElement.dataset.themeRoundtrip ?? null,
                language: document.documentElement.lang || null,
                width: innerWidth,
                height: innerHeight,
                viewport_roundtrip: document.documentElement.dataset.viewportRoundtrip ?? null,
                fonts: document.fonts?.status ?? 'unsupported',
                platform_cards: [...document.querySelectorAll('.reader-platform-button')].filter(n=>n.getBoundingClientRect().width>0).map(n=>({platform:n.dataset.platform,background:getComputedStyle(n).backgroundColor,filter:getComputedStyle(n.querySelector('img')).filter})),
                information_titles: [...document.querySelectorAll('.archiver-info-copy')].filter(n=>n.getBoundingClientRect().width>0&&n.querySelector('strong')).map(n=>{const t=n.querySelector('strong'),r=t.getBoundingClientRect(),b=n.getBoundingClientRect();return {height:r.height,line_height:parseFloat(getComputedStyle(t).lineHeight),top:r.top,box_top:b.top,scroll_top:n.scrollTop};}),
                images: visibleImages.every(image => image.complete && image.naturalWidth > 0) && failedImages.length === 0,
                images_deferred: images.filter(image => !image.complete && !visibleImages.includes(image)).length,
                images_failed: failedImages.slice(0, 10).map(image => (image.currentSrc.startsWith('data:') ? image.currentSrc.split(',')[0] : image.currentSrc).slice(0, 160)),
                transition: !!transition && !transition.hidden && transitionStyle?.display !== 'none' && transitionStyle?.visibility !== 'hidden' && Number.parseFloat(transitionStyle?.opacity ?? '1') > .01,
                body_scroll_width: document.documentElement.scrollWidth,
                body_client_width: document.documentElement.clientWidth,
                body_scroll_height: document.documentElement.scrollHeight,
                body_client_height: document.documentElement.clientHeight,
                geometry
              });
            })()
            """;
        var lastFrame = "unavailable";
        for (var attempt = 0; attempt < 240; attempt++)
        {
            var encoded = await WebView.CoreWebView2.ExecuteScriptAsync(script);
            var json = JsonSerializer.Deserialize<string>(encoded);
            if (!string.IsNullOrWhiteSpace(json))
            {
                lastFrame = json;
                using var document = JsonDocument.Parse(json);
                var root = document.RootElement;
                var ready = root.TryGetProperty("ready", out var readyValue) && readyValue.GetBoolean();
                if (root.TryGetProperty("boot_state", out var bootState) && bootState.GetString() == "failed"
                    || root.TryGetProperty("runtime_errors", out var runtimeErrors) && runtimeErrors.GetInt32() > 0)
                    throw new InvalidOperationException($"Visual audit encountered a failed page: {lastFrame}");
                if (root.TryGetProperty("images_failed", out var failedImages) && failedImages.GetArrayLength() > 0)
                    throw new InvalidOperationException($"Visual audit encountered broken images: {lastFrame}");
                var fonts = root.TryGetProperty("fonts", out var fontsValue) && fontsValue.GetString() is "loaded" or "unsupported";
                if (ready && fonts && root.TryGetProperty("reader_search_hint", out var searchHint) && searchHint.ValueKind == JsonValueKind.Object && !searchHint.GetProperty("fits").GetBoolean())
                    throw new InvalidDataException($"Reader search placeholder is clipped: {searchHint}");
                var images = root.TryGetProperty("images", out var imagesValue) && imagesValue.GetBoolean();
                var transition = root.TryGetProperty("transition", out var transitionValue) && transitionValue.GetBoolean();
                var width = root.TryGetProperty("width", out var widthValue) ? widthValue.GetInt32() : 0;
                var height = root.TryGetProperty("height", out var heightValue) ? heightValue.GetInt32() : 0;
                var sceneSettled = !root.TryGetProperty("archiver_scene", out var scene) || scene.ValueKind == JsonValueKind.Null
                    || Math.Abs(scene.GetProperty("information_height").GetDouble() - scene.GetProperty("scene").GetProperty("height").GetDouble()) < .15;
                // Central documentation deliberately hides the Archiver list
                // artwork. Validate the active reading surface instead.
                if (root.TryGetProperty("document_surface", out var publication) && publication.ValueKind != JsonValueKind.Null)
                    sceneSettled = publication.GetProperty("ready").GetBoolean() && publication.GetProperty("inside").GetBoolean() && publication.GetProperty("scroll_owner").GetBoolean();
                if (ready && fonts && images && !transition && sceneSettled && Math.Abs(width - audit.Width / WebView.ZoomFactor) <= 1 && Math.Abs(height - audit.Height / WebView.ZoomFactor) <= 1) return root.Clone();
            }
            await Task.Delay(50);
        }
        throw new TimeoutException($"Visual audit page did not reach a complete deterministic frame: {lastFrame}");
    }

    private string LocalInterfaceUrl()
    {
        var files = new[]
        {
            Path.Combine(_layout.WebRoot, "index.html"),
            Path.Combine(_layout.WebRoot, "shell.js"),
            Path.Combine(_layout.WebRoot, "shell.css"),
            Path.Combine(_layout.WebRoot, "runtime", "conversation-renderer.js"),
            Path.Combine(_layout.WebRoot, "runtime", "conversation-renderer.css")
        };
        var buildStamp = files.Select(File.GetLastWriteTimeUtc).Select(value => value.Ticks).DefaultIfEmpty(0).Max();
        var query = $"?cloudig-build={buildStamp}";
        if (_layout.VisualAudit?.Query is { Length: > 1 } auditQuery) query += $"&{auditQuery[1..]}";
        return $"{BridgePolicy.AppOrigin}/index.html{query}";
    }

    private void ConfigureWebView()
    {
        var core = WebView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.NavigationStarting += OnNavigationStarting;
        core.FrameNavigationStarting += (_, args) => { if (!_bridge.IsAllowedFrameNavigation(args.Uri)) args.Cancel = true; };
        core.NewWindowRequested += OnNewWindowRequested;
        core.ProcessFailed += (_, args) => TraceVisualAudit(
            "webview-process-failed",
            $"kind={args.ProcessFailedKind};reason={args.Reason};exit={args.ExitCode};process={args.ProcessDescription}");
        core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.WebMessageReceived += OnWebMessageReceived;
        if (_layout.VisualAudit is not null)
            core.WebResourceResponseReceived += (_, args) =>
            {
                if (args.Request.Uri.StartsWith("https://cloudig-runtime.local/", StringComparison.Ordinal))
                    TraceVisualAudit("runtime-response", $"{args.Response.StatusCode};{args.Request.Uri}");
            };
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        TraceVisualAudit("navigation-starting", e.Uri);
        if (_bridge.IsAllowedTopLevelNavigation(e.Uri)) return;
        e.Cancel = true;
        if (e.IsUserInitiated && BridgePolicy.IsExternalHttp(e.Uri)) OpenExternal(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (e.IsUserInitiated && BridgePolicy.IsExternalHttp(e.Uri)) OpenExternal(e.Uri);
    }

    private bool OpenExternal(string value, bool showFailure = true)
    {
        if (_layout.VisualAudit?.Query.Contains("interaction=bookmark-document", StringComparison.Ordinal) == true)
        {
            if (!BridgePolicy.IsExternalHttp(value)) return false;
            _bookmarkDocumentExternalRequests.Add(value);
            TraceVisualAudit("example-browser-launch-plan", value);
            return true; // Observe the real UI/bridge request, without opening browser tabs during an offscreen audit.
        }
        var opened = ExternalBrowserLauncher.TryOpen(value);
        if (!opened && showFailure)
        {
            TraceVisualAudit("external-open-failed");
            if (_layout.VisualAudit is null) MessageBox.Show(this,
                "无法打开默认浏览器。请检查 Windows 的默认浏览器设置后重试。\n\nCould not open the default browser. Check Windows default browser settings and retry.",
                "采云 Cloudig", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        return opened;
    }

    private async Task VerifyParseDestinationAsync(VisualAuditOptions audit)
    {
        var settingsMode = audit.Query.Contains("interaction=parse-settings-directory", StringComparison.Ordinal);
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal) || _libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Parse destination audit requires its own record Library.");
        var conversations = Path.Combine(library, "Conversations");
        Dictionary<string, string> Snapshot(string root) => Directory.GetFiles(root, "*", System.IO.SearchOption.AllDirectories).ToDictionary(file => file, file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
        string Settings() { using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(library, "CloudigLibrary.json"))); return doc.RootElement.GetProperty("settings").GetRawText(); }
        string? ConversationId(string original, bool filename)
        {
            foreach (var file in Directory.GetFiles(conversations, "*.json", System.IO.SearchOption.AllDirectories))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                if (doc.RootElement.GetProperty("title").TryGetProperty(filename ? "filename" : "original", out var title) && title.GetString() == original) return doc.RootElement.GetProperty("conversation_id").GetString();
            }
            return null;
        }
        void Same(Dictionary<string, string> before, string root) { var after = Snapshot(root); if (before.Count != after.Count || before.Any(pair => !after.TryGetValue(pair.Key, out var sha) || sha != pair.Value)) throw new InvalidDataException("Parse destination inspection/cancel changed files."); }
        async Task WaitAsync(string condition)
        {
            for (var attempt = 0; attempt < 200; attempt++)
            {
                var error = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[role=alertdialog]')?.textContent??null");
                if (error != "null") throw new InvalidDataException($"Parse destination UI failed: {error}");
                if (await WebView.CoreWebView2.ExecuteScriptAsync(condition) == "true") return;
                await Task.Delay(50);
            }
            throw new InvalidDataException($"Parse destination UI timed out: {condition}");
        }
        async Task ClickAsync(string selector)
        {
            var raw = "null";
            for (var attempt = 0; attempt < 50 && raw == "null"; attempt++)
            {
                raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;
                n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                return r.width&&r.height&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()
                """);
                if (raw == "null") await Task.Delay(50);
            }
            if (raw == "null") throw new InvalidDataException($"Parse destination control is obstructed: {selector}");
            using var point = JsonDocument.Parse(raw);
            foreach (var type in new[] { "mousePressed", "mouseReleased" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new {
                type, x=point.RootElement.GetProperty("x").GetDouble(), y=point.RootElement.GetProperty("y").GetDouble(), button="left", buttons=type=="mousePressed"?1:0, clickCount=1 }));
        }
        async Task CaptureAsync(string suffix) { await using var stream = File.Create(Path.ChangeExtension(audit.OutputFile, suffix + ".png")); await WebView.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream); }
        var sourceBefore = Snapshot(Path.Combine(library, "Inbox")); var settingsBefore = Settings();
        var suffix = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(audit.OutputFile)))[..6];
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-archiver-workflow-close]')?.click()");
        foreach (var flow in new[] { "html", "claude" })
        {
            if (flow == "claude") { await ClickAsync("[data-source-claude]"); await WaitAsync("document.querySelector('.app-root').dataset.route==='archiver/claude'&&!!document.querySelector('[data-claude-extract]')"); }
            var opener = flow == "html" ? "[data-source-parse]" : "[data-claude-extract]";
            var priorId = ConversationId(flow == "html" ? "视觉校验" : "Claude UI · 分支与选择", flow == "html");
            var before = Snapshot(conversations);
            if (settingsMode)
            {
                var panel = flow == "html" ? "[data-archiver-parse-settings-popover]" : "[data-claude-settings-popover]";
                var settingsOpener = flow == "html" ? "[data-archiver-parse-settings]" : "[data-claude-settings]";
                var prefix = flow == "html" ? "parse" : "claude";
                var settingsAtOpen = Settings();
                await ClickAsync(settingsOpener);
                var settingsFolder = "设置-" + flow + "-" + suffix;
                await ClickAsync(panel + " [data-parse-directory-new]"); await ClickAsync(panel + " [data-parse-directory-name]");
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text=settingsFolder }));
                await CaptureAsync("." + flow + "-settings-create");
                await ClickAsync(panel + " [data-parse-directory-create]");
                await WaitAsync($"document.querySelector('{panel} .cloudig-parse-target-editor').hidden&&document.querySelector('{panel} [data-parse-directory]').selectedOptions[0].textContent==={JsonSerializer.Serialize(settingsFolder)}");
                if (!Directory.Exists(Path.Combine(conversations, settingsFolder))) throw new InvalidDataException("Settings did not create the directory.");
                await ClickAsync(panel + $" [data-{prefix}-settings-cancel]"); Same(before, conversations);
                if (Settings() != settingsAtOpen) throw new InvalidDataException("Cancelled settings changed the stored default.");
                await ClickAsync(settingsOpener);
                if (await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector('{panel} [data-parse-directory]').selectedOptions[0].textContent==={JsonSerializer.Serialize(settingsFolder)}") == "true") throw new InvalidDataException("Cancelled directory leaked into the default.");
                await ClickAsync(panel + " [data-parse-directory]");
                await WaitAsync($"document.querySelector('{panel} [data-parse-directory]').matches(':open')");
                await CaptureAsync("." + flow + "-settings-picker");
                var chosen = await WebView.CoreWebView2.ExecuteScriptAsync($"(()=>{{const s=document.querySelector('{panel} [data-parse-directory]');return [...s.options].findIndex(o=>o.textContent==={JsonSerializer.Serialize(settingsFolder)});}})()");
                if (!int.TryParse(chosen, out var optionIndex) || optionIndex < 0) throw new InvalidDataException("Created directory was lost after reopening settings.");
                await ClickAsync(panel + $" [data-parse-directory] option:nth-of-type({optionIndex + 1})");
                await WaitAsync($"document.querySelector('{panel} [data-parse-directory]').selectedOptions[0].textContent==={JsonSerializer.Serialize(settingsFolder)}");
                var preserve = panel + $" [data-{prefix}-setting='preserve_previous']";
                if (await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(preserve)}).checked") != "true") await ClickAsync(preserve);
                await ClickAsync(panel + $" [data-{prefix}-settings-save]");
                await WaitAsync($"document.querySelector('{panel}').hidden");
                var expectedTheme = audit.Query.Contains("theme=star-night", StringComparison.Ordinal) ? "star-night" : "dawn";
                await WaitAsync($"document.documentElement.dataset.theme==={JsonSerializer.Serialize(expectedTheme)}");
                using (var settings = JsonDocument.Parse(Settings()))
                    if (settings.RootElement.GetProperty("default_output_directory").GetString() != "Conversations/" + settingsFolder) throw new InvalidDataException("Settings did not persist the chosen default.");
                await ClickAsync(flow == "html" ? "[data-source-select-all]" : "[data-claude-select-all]");
                await WaitAsync(flow == "html" ? "document.querySelector('[data-source-select-all]').getAttribute('aria-pressed')==='true'" : "document.querySelector('[data-claude-select-all]').getAttribute('aria-pressed')==='true'");
                await ClickAsync(flow == "html" ? "[data-archiver-parse-all]" : "[data-claude-one-click]");
                await WaitAsync("!!document.querySelector('.cloudig-dialog [data-parse-directory]')");
                await WaitAsync($"document.querySelector('.cloudig-dialog [data-parse-directory]').selectedOptions[0].textContent==={JsonSerializer.Serialize(settingsFolder)}");
                await ClickAsync(".cloudig-dialog footer .cloudig-button-filled");
                var settingsTargetDir = Path.Combine(conversations, settingsFolder); var settingsElapsed = Stopwatch.StartNew();
                while (Directory.GetFiles(settingsTargetDir, "*.json").Length == 0 && settingsElapsed.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(50);
                if (Directory.GetFiles(settingsTargetDir, "*.json").Length == 0) throw new InvalidDataException("One-click parse ignored its saved target.");
                await WaitAsync(flow == "html" ? "document.querySelector('[data-archiver-progress]').hidden" : "document.querySelector('[data-claude-progress]').hidden");
                TraceVisualAudit("parse-settings-directory-passed", $"flow={flow};created=true;cancel_keeps_directory=true;save_default=true;one_click_output=true;native_pointer=true");
                continue;
            }
            await ClickAsync(opener); await WaitAsync("!!document.querySelector('[data-parse-directory]')&&document.querySelectorAll('.cloudig-dialog-list li').length===1");
            await ClickAsync(".cloudig-dialog footer .cloudig-button-outline"); await WaitAsync("!document.querySelector('.cloudig-dialog')"); Same(before, conversations);
            await ClickAsync(opener); await WaitAsync("!!document.querySelector('[data-parse-directory]')");
            await ClickAsync("[data-parse-directory]"); await WaitAsync("document.querySelector('[data-parse-directory]').matches(':open')");
            await CaptureAsync("." + flow + "-directory-list");
            foreach (var type in new[] { "keyDown", "keyUp" }) await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27 }));
            await WaitAsync("!!document.querySelector('.cloudig-dialog')&&!document.querySelector('[data-parse-directory]').matches(':open')");
            await ClickAsync("[data-parse-directory-new]"); await ClickAsync("[data-parse-directory-name]");
            var folder = "解析-" + flow + "-" + suffix;
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text=folder }));
            await CaptureAsync("." + flow + "-create");
            await ClickAsync("[data-parse-directory-create]");
            await WaitAsync($"document.querySelector('.cloudig-parse-target-editor').hidden&&document.querySelector('[data-parse-directory]').selectedOptions[0].textContent==={JsonSerializer.Serialize(folder)}");
            if (!Directory.Exists(Path.Combine(conversations, folder))) throw new InvalidDataException("New directory was not created by the UI.");
            await ClickAsync(".cloudig-dialog footer .cloudig-button-filled");
            var target = Path.Combine(conversations, folder); var elapsed = Stopwatch.StartNew();
            while (Directory.GetFiles(target, "*.json").Length != 1 && elapsed.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(50);
            if (Directory.GetFiles(target, "*.json").Length != 1) throw new InvalidDataException("Parsed output did not use the selected directory.");
            await WaitAsync(flow == "html" ? "document.querySelector('[data-archiver-progress]').hidden" : "document.querySelector('[data-claude-progress]').hidden");
            using var record = JsonDocument.Parse(File.ReadAllText(Directory.GetFiles(target, "*.json")[0]));
            if (priorId is not null && record.RootElement.GetProperty("conversation_id").GetString() != priorId) throw new InvalidDataException("Retargeted reparse changed Conversation identity.");
            if (Settings() != settingsBefore) throw new InvalidDataException("Single-run destination changed persistent settings.");
            // Confirm the preselected root without touching its picker. The output
            // choice must move a safe reparse, not depend on a change DOM event.
            var movedId = record.RootElement.GetProperty("conversation_id").GetString();
            await ClickAsync(opener); await WaitAsync("!!document.querySelector('.cloudig-dialog [data-parse-directory]')");
            await WaitAsync("document.querySelector('.cloudig-dialog [data-parse-directory]').value==='root'");
            await ClickAsync(".cloudig-dialog footer .cloudig-button-filled");
            var returnElapsed = Stopwatch.StartNew(); var returned = false;
            while (returnElapsed.Elapsed < TimeSpan.FromSeconds(15))
            {
                returned = Directory.GetFiles(conversations, "*.json").Any(file => { using var doc=JsonDocument.Parse(File.ReadAllText(file));return doc.RootElement.GetProperty("conversation_id").GetString()==movedId; });
                if (returned && Directory.GetFiles(target, "*.json").Length == 0) break;
                await Task.Delay(50);
            }
            if (!returned || Directory.GetFiles(target, "*.json").Length != 0) throw new InvalidDataException("Confirmed unchanged root did not move the reparse back.");
            await WaitAsync(flow == "html" ? "document.querySelector('[data-archiver-progress]').hidden" : "document.querySelector('[data-claude-progress]').hidden");
            TraceVisualAudit("parse-confirmed-root-move-passed", $"flow={flow};uuid_preserved=true;picker_unchanged=true");
            TraceVisualAudit("parse-destination-flow-passed", $"flow={flow};cancel_unchanged=true;target={folder};uuid_preserved=true;native_pointer=true");
        }
        Same(sourceBefore, Path.Combine(library, "Inbox"));
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, settingsMode ? ".parse-settings-directory.json" : ".parse-destination.json"), JsonSerializer.Serialize(new { flows=2, settings=settingsMode, create=true, cancel_unchanged=true, original_sources_unchanged=true, persistent_settings_unchanged=!settingsMode, native_pointer=true }));
    }

    private async Task VerifyClaudeParseRoundtripAsync(VisualAuditOptions audit)
    {
        var library = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(audit.OutputFile)!, "Library"));
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal) || _libraryRoot is null || !string.Equals(Path.GetFullPath(_libraryRoot), library, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Claude parse audit requires its own real record Library.");
        var target = Path.Combine(library, "Conversations");
        Dictionary<string, string> Snapshot() => Directory.GetFiles(target, "*.json").ToDictionary(file => file, file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
        void Unchanged(Dictionary<string, string> before)
        {
            if (before.Any(pair => !File.Exists(pair.Key) || Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pair.Key))) != pair.Value))
                throw new InvalidDataException("Claude preview/cancel or preserve changed an existing Conversation.");
        }
        async Task WaitAsync(string expression)
        {
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(15))
            {
                var error = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[role=alertdialog]')?.textContent??null");
                if (error != "null") throw new InvalidDataException($"Claude UI failed: {error}");
                if (await WebView.CoreWebView2.ExecuteScriptAsync(expression) == "true") return;
                await Task.Delay(40);
            }
            throw new InvalidDataException($"Claude UI condition timed out: {expression}");
        }
        async Task ScopeAsync(int expected)
        {
            var before = Snapshot();
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-claude-one-click]').click()");
            await WaitAsync($"document.querySelectorAll('.cloudig-dialog-list li').length==={expected}");
            Unchanged(before);
            if (Directory.GetFiles(target, "*.json").Length != before.Count) throw new InvalidDataException("Claude parsed before confirmation.");
        }
        async Task CompleteAsync(int expected)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-dialog footer .cloudig-button-filled').click()");
            var deadline = Stopwatch.StartNew();
            while (Directory.GetFiles(target, "*.json").Length != expected && deadline.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(40);
            if (Directory.GetFiles(target, "*.json").Length != expected) throw new InvalidDataException("Claude UI did not create the expected independent records.");
            await WaitAsync("document.querySelector('[data-claude-progress]').hidden&&document.querySelectorAll('[data-claude-row][data-status=parsed]').length===2");
        }
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const r=document.querySelector('[data-claude-progress]');document.documentElement.dataset.auditClaudeProgress='0';new MutationObserver(()=>{if(!r.hidden)document.documentElement.dataset.auditClaudeProgress='1';}).observe(r,{attributes:true,attributeFilter:['hidden']});})()");
        var sourceFile = Path.Combine(library, "Inbox", "conversations.json");
        var sourceHash = SHA256.HashData(File.ReadAllBytes(sourceFile));
        var ready = int.Parse(await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('[data-claude-row][data-status=ready]').length"));
        if (ready > 0)
        {
            if (ready != 2) throw new InvalidDataException("Claude audit fixture must contain exactly two unparsed records.");
            var before = Snapshot();
            await ScopeAsync(2); // No selection: the default includes every unparsed record.
            await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('.cloudig-dialog footer .cloudig-button-outline').click()");
            await WaitAsync("!document.querySelector('.cloudig-dialog')");
            Unchanged(before);
            await ScopeAsync(2);
            await CompleteAsync(before.Count + 2);
        }
        var preserved = Snapshot();
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{document.querySelector('[data-claude-settings]').click();for(const i of document.querySelectorAll('[data-claude-setting]'))i.checked=['parse_selected','preserve_previous'].includes(i.dataset.claudeSetting);document.querySelector('[data-claude-settings-save]').click();})()");
        await WaitAsync("document.querySelector('[data-claude-settings-popover]').hidden");
        await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-claude-row]').click()");
        await WaitAsync("document.querySelectorAll('[data-claude-row][data-selected=true]').length===1");
        await ScopeAsync(1); // Selected-only plus preserve writes one independent copy.
        await CompleteAsync(preserved.Count + 1);
        Unchanged(preserved);
        if (!sourceHash.SequenceEqual(SHA256.HashData(File.ReadAllBytes(sourceFile)))) throw new InvalidDataException("Claude source changed during extraction.");
        await WaitAsync("document.documentElement.dataset.auditClaudeProgress==='1'");
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{document.querySelector('[data-claude-settings]').click();for(const i of document.querySelectorAll('[data-claude-setting]'))i.checked=['parse_unparsed','parse_selected'].includes(i.dataset.claudeSetting);document.querySelector('[data-claude-settings-save]').click();})()");
        await WaitAsync("document.querySelector('[data-claude-settings-popover]').hidden");
        TraceVisualAudit("claude-parse-roundtrip-passed", $"default_unparsed={ready};selected_only=1;preserved={preserved.Count};source_unchanged=true;progress=true");
    }

    private async Task VerifyIdentitySaveRoundtripAsync(VisualAuditOptions audit)
    {
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal)) throw new InvalidDataException("Identity save audit requires an owned real Library.");
        async Task Wait(string condition)
        {
            for (var i = 0; i < 200; i++) { if (await WebView.CoreWebView2.ExecuteScriptAsync($"Boolean({condition})") == "true") return; await Task.Delay(50); }
            throw new TimeoutException("Identity save did not reach " + condition);
        }
        async Task Pointer(string selector)
        {
            await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(selector)})?.scrollIntoView({{block:'nearest'}})");
            await Task.Delay(80);
            var raw = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                (()=>{const n=document.querySelector({{JsonSerializer.Serialize(selector)}});if(!n||n.disabled)return null;const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()
                """);
            if (raw == "null") throw new InvalidDataException("Identity pointer target obstructed: " + selector);
            using var point = JsonDocument.Parse(raw); var x = point.RootElement.GetProperty("x").GetDouble(); var y = point.RootElement.GetProperty("y").GetDouble();
            foreach (var type in new[] { "mouseMoved", "mousePressed", "mouseReleased" })
                await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type, x, y, button = "left", buttons = type == "mousePressed" ? 1 : 0, clickCount = 1 }));
        }
        const string field = "[data-identity-global-grid] .identity-card-name input";
        const string name = "Identity roundtrip · 身份保存";
        async Task Type(string text)
        {
            await Pointer(field);
            await WebView.CoreWebView2.ExecuteScriptAsync($"document.querySelector({JsonSerializer.Serialize(field)}).select()");
            await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.insertText", JsonSerializer.Serialize(new { text }));
        }
        async Task Reopen()
        {
            await Wait("!document.querySelector('[data-identity-dialog]')");
            await Pointer(".welcome-identity-user");
            await Wait($"document.querySelector({JsonSerializer.Serialize(field)})?.value==={JsonSerializer.Serialize(name)}");
        }
        await Type(name); await Pointer("[data-identity-save]"); await Reopen();
        await Type("Discard this draft"); await Pointer("[data-identity-cancel]");
        await Wait("!document.querySelector('[data-identity-status]').hidden");
        await Pointer("[data-identity-cancel]"); await Reopen();
        TraceVisualAudit("identity-save-roundtrip-passed", "native_pointer=true;saved_reopened=true;cancel_preserved=true");
    }

    private async Task VerifyTimeSaveRoundtripAsync(VisualAuditOptions audit)
    {
        if (!audit.Query.Contains("fixture=real", StringComparison.Ordinal)) throw new InvalidDataException("Time save audit cannot use simulated commands.");
        var name = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
            (()=>{const q=new URLSearchParams(location.search),name='UI roundtrip '+q.get('theme')+' '+q.get('language')+' {{audit.Width}}';
              document.documentElement.dataset.auditTimeName=name;
              document.querySelector('[data-time-editor-action="kind-periodic"]').click();
              for(const [key,value] of [['name',name],['count','12'],['prefix','第'],['unit','月']]){
                const input=document.querySelector('[data-time-editor-metadata] [name="'+key+'"]');
                if(!input)throw new Error('Time input missing: '+key);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
              document.querySelector('[data-time-editor-save]').click();return name;})()
            """);
        async Task SavedAndReopenAsync(int count)
        {
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(15))
            {
                var ready = await WebView.CoreWebView2.ExecuteScriptAsync("""
                    (()=>{const impact=document.querySelector('[data-time-editor-impact]');
                      if(impact&&!impact.hidden){const choice=impact.querySelector('input[name="strategy"][value="in_place"]');
                        if(choice){choice.click();impact.querySelector('[data-time-impact-confirm]').click();}return false;}
                      if(document.querySelector('[data-time-editor-layer]'))return false;
                      const name=document.documentElement.dataset.auditTimeName;
                      const row=[...document.querySelectorAll('[data-time-sovereign-list] .time-cover-row')].find(r=>r.querySelector('strong')?.textContent===name);
                      if(!row)return false;row.querySelector('[data-time-node-action="edit"]').click();return true;})()
                    """);
                if (ready == "true")
                {
                    while (deadline.Elapsed < TimeSpan.FromSeconds(15))
                    {
                        var reopened = await WebView.CoreWebView2.ExecuteScriptAsync($$"""
                            (()=>{const h=document.querySelector('[data-time-editor-metadata]');return !!h&&h.querySelector('[name="name"]')?.value===document.documentElement.dataset.auditTimeName&&h.querySelector('[name="count"]')?.value==='{{count}}';})()
                            """);
                        if (reopened == "true") return;
                        await Task.Delay(80);
                    }
                }
                await Task.Delay(80);
            }
            var status = await WebView.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-time-editor-status]')?.textContent??document.querySelector('[role=alertdialog]')?.textContent??''");
            throw new InvalidDataException($"Time create/edit/reopen did not finish: {status}");
        }
        await SavedAndReopenAsync(12);
        await WebView.CoreWebView2.ExecuteScriptAsync("(()=>{const input=document.querySelector('[data-time-editor-metadata] [name=count]');input.value='24';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-time-editor-save]').click();})()");
        await SavedAndReopenAsync(24);
        TraceVisualAudit("time-save-roundtrip-passed", name);
    }

    private async Task VerifyTimeZonePickerAsync(VisualAuditOptions audit)
    {
        var opened = await WebView.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", JsonSerializer.Serialize(new
        {
            expression = """
                (()=>{const select=document.querySelector('.cloudig-endpoint-zone');
                  if(!select||!CSS.supports('appearance','base-select'))throw new Error('Themed timezone picker unavailable');
                  select.value='Z';select.dispatchEvent(new Event('input',{bubbles:true}));
                  select.scrollIntoView({block:'nearest'});select.focus();select.showPicker();return true;})()
                """,
            userGesture = true, returnByValue = true
        }));
        if (opened.Contains("exceptionDetails", StringComparison.Ordinal)) throw new InvalidDataException(opened);
        await Task.Delay(120);
        var facts = await WebView.CoreWebView2.ExecuteScriptAsync("""
            (()=>{const s=document.querySelector('.cloudig-endpoint-zone'),p=getComputedStyle(s,'::picker(select)'),r=s.getBoundingClientRect();
              return{open:s.matches(':open'),value:s.value,theme:document.documentElement.dataset.theme,
                appearance:getComputedStyle(s).appearance,background:p.backgroundColor,color:p.color,border:p.borderTopColor,
                maxHeight:p.maxHeight,scrollbar:p.scrollbarColor,options:s.options.length,
                withinViewport:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight};})()
            """);
        using var document = JsonDocument.Parse(facts);
        var row = document.RootElement;
        if (!row.GetProperty("open").GetBoolean() || !row.GetProperty("withinViewport").GetBoolean()
            || row.GetProperty("appearance").GetString() != "base-select" || row.GetProperty("options").GetInt32() < 114)
            throw new InvalidDataException($"Timezone picker failed: {facts}");
        var night = row.GetProperty("theme").GetString() == "star-night";
        if (row.GetProperty("background").GetString() != (night ? "rgb(45, 45, 45)" : "rgb(241, 222, 210)")
            || row.GetProperty("color").GetString() != (night ? "rgb(226, 225, 225)" : "rgb(45, 45, 45)"))
            throw new InvalidDataException($"Timezone picker theme failed: {facts}");
        await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".timezone.json"), facts);
        TraceVisualAudit("timezone-picker-passed");
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_closing) return;
        WebBridgeRequest request;
        try
        {
            request = _bridge.Parse(e.Source, e.WebMessageAsJson);
            if (request.Command is "reader.archives.query" or "reader.view.open" or "reader.view.page")
                TraceVisualAudit("reader-request", request.Command);
            if (request.Command is "archiver.sources.query" or "archiver.parse.plan" or "archiver.parse.commit" or "shell.bookmarks.query")
                TraceVisualAudit("archiver-request", request.Command);
        }
        catch
        {
            var id = _bridge.CorrelationId(e.Source, e.WebMessageAsJson);
            if (id is not null) PostError(new WebBridgeRequest(id, "", Json("{}")), "CLOUDIG_WEB_REQUEST_INVALID", "页面请求格式无效 / Invalid page request");
            return;
        }

        if (_libraryRoot is not null && PortableLibraryMove.IsPending(_libraryRoot) && request.Command is not ("shell.loading" or "shell.surface" or "engine.handshake"))
        {
            PostError(request, "CLOUDIG_LIBRARY_MOVE_PENDING", "正在整体搬迁，已暂停新的读写。请等待完成或重新打开处理。");
            return;
        }

        if (request.Command == "shell.loading")
        {
            var ready = request.Payload.TryGetProperty("ready", out var state) && state.ValueKind == JsonValueKind.True;
            if (request.Payload.TryGetProperty("stage", out var stage) && stage.GetString() == "decoded")
            {
                // Hidden WebView cannot paint RAFs. Reveal it only after its
                // copy of the same GIF is decoded, then wait for the painted ack.
                if (ready && !_resourcesClosed && !_closing)
                {
                    WebView.Visibility = Visibility.Visible;
                    StopStartupSun();
                    TraceVisualAudit("web-loading-decoded");
                }
            }
            else _loadingVisible.TrySetResult(ready);
            PostResponse(request, true, Json("{}"));
            return;
        }
        if (!await _libraryReady.Task)
        {
            PostError(request, "CLOUDIG_STARTUP_FAILED", "采云初始化未完成 / Cloudig initialization did not complete");
            return;
        }
        if (request.Command == "shell.surface")
        {
            try
            {
                ApplySurface(request.Payload);
                PostResponse(request, true, Json("{\"applied\":true}"));
            }
            catch
            {
                PostError(request, "CLOUDIG_SURFACE_INVALID", "界面主题状态无效");
            }
            return;
        }
        if (request.Command == "shell.openExternal")
        {
            var url = request.Payload.TryGetProperty("url", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            if (!BridgePolicy.IsExternalHttp(url)) PostError(request, "CLOUDIG_EXTERNAL_URL_INVALID", "外部链接无效");
            else
            {
                if (OpenExternal(url!, showFailure: false)) PostResponse(request, true, Json("{\"opened\":true}"));
                else PostError(request, "CLOUDIG_EXTERNAL_OPEN_FAILED", "Could not open the default browser.");
            }
            return;
        }
        if (request.Command == "shell.example.open")
        {
            await OpenPublicExampleAsync(request);
            return;
        }
        if (request.Command == "request.cancel")
        {
            var target = request.Payload.TryGetProperty("target", out var value) ? value.GetString() : null;
            CancellationTokenSource? operation = null;
            var cancelled = target is not null && _webRequests.TryGetValue(target, out operation);
            if (cancelled) operation!.Cancel();
            PostResponse(request, true, Json(cancelled ? "{\"cancelled\":true}" : "{\"cancelled\":false}"));
            return;
        }
        if (request.Command.StartsWith("shell.bookmarks.", StringComparison.Ordinal))
        {
            await HandleBookmarkRequestAsync(request);
            return;
        }
        if (request.Command == "shell.library.info")
        {
            try
            {
                ExactProperties(request.Payload);
                PostResponse(request, true, BookmarkJson(new
                {
                    available = _libraryRoot is not null,
                    displayPath = _libraryRoot is null ? "Cloudig" : LibraryMoveBoundary.DisplayPath(_libraryRoot)
                }));
            }
            catch
            {
                PostError(request, "CLOUDIG_LIBRARY_REQUEST_INVALID", "资料库信息请求无效");
            }
            return;
        }
        if (_engine is null && request.Command is not ("shell.checkUpdates" or "shell.checkStartupUpdate"))
        {
            PostError(request, "CLOUDIG_LIBRARY_UNAVAILABLE", "尚未选择可用的采云资料库");
            return;
        }

        var cancellation = new CancellationTokenSource();
        if (!_webRequests.TryAdd(request.Request, cancellation))
        {
            cancellation.Dispose();
            PostError(request, "CLOUDIG_WEB_REQUEST_REPLAY", "页面请求已失效");
            return;
        }
        try
        {
            JsonElement result;
            if (request.Command is "shell.checkUpdates" or "shell.checkStartupUpdate")
            {
                ExactProperties(request.Payload);
                result = await QueryUpdateAsync(request.Command == "shell.checkStartupUpdate", cancellation.Token);
            }
            else if (request.Command == "shell.update.prepare") result = await PrepareUpdateAsync(request, cancellation.Token);
            else if (request.Command == "shell.update.install") result = ScheduleUpdate(request.Payload);
            else if (request.Command == "shell.example.download")
            {
                ExactProperties(request.Payload, "example", "format");
                TraceVisualAudit("example-download-start", request.Payload.GetRawText());
                var downloaded = await Task.Run(() => new ExampleDownloadClient().DownloadAsync(Path.Combine(_layout.WebRoot, "pages", "document", "content", "examples.json"), _libraryRoot!, RequiredString(request.Payload, "example"), RequiredString(request.Payload, "format"),
                    progress => Dispatcher.BeginInvoke(() => PostEvent(request, JsonSerializer.SerializeToElement(new { phase = "downloading", bytes = progress.Bytes, total = progress.Total }))), cancellation.Token), cancellation.Token);
                result = JsonSerializer.SerializeToElement(new { saved = true, existing = downloaded.Existing, path = Path.GetRelativePath(_libraryRoot!, downloaded.Path).Replace('\\', '/') });
                TraceVisualAudit("example-download-complete", result.GetRawText());
            }
            else if (request.Command == "shell.recycleArchive") result = await RecycleArchiveAsync(request.Payload, cancellation.Token);
            else if (request.Command == "shell.pickSource") result = await PickSourcesAsync(request, request.Payload, cancellation.Token);
            else if (request.Command == "shell.pickIdentityAvatar") result = await PickIdentityAvatarAsync(request.Payload, cancellation.Token);
            else if (request.Command == "shell.discardIdentityAvatar") result = await DiscardIdentityAvatarAsync(request.Payload, cancellation.Token);
            else if (request.Command == "identity.commit") result = await CommitIdentityAsync(request.Payload, cancellation.Token);
            else if (request.Command == "shell.openManagedFolder") result = OpenManagedFolder(request.Payload);
            else if (request.Command == "shell.saveResource") result = await SaveResourceAsync(request.Payload, cancellation.Token);
            else if (request.Command == "shell.copyMarkdown") result = await CopyMarkdownAsync(request, cancellation.Token);
            else if (request.Command == "systemLog.reveal") result = await RevealSystemLogFileAsync(request.Payload, cancellation.Token);
            else if (request.Command == "shell.libraryMove.plan") result = await PlanLibraryMoveAsync(request, request.Payload, cancellation.Token);
            else if (request.Command == "shell.libraryMove.commit") result = await CommitLibraryMoveAsync(request, request.Payload, cancellation.Token);
            else
            {
                result = await _engine!.SendWithEventsAsync(
                    request.Command,
                    request.Payload,
                    value => Dispatcher.BeginInvoke(() => PostEvent(request, value)),
                    cancellation.Token);
            }
            PostResponse(request, true, result);
        }
        catch (EngineRemoteException error)
        {
            PostError(request, error.Code, error.Message);
        }
        catch (BookmarkCapabilityException error)
        {
            PostError(request, error.Code, error.Message);
        }
        catch (LibraryMoveCapabilityException error)
        {
            PostError(request, error.Code, error.Message);
        }
        catch (SystemLogRevealException error)
        {
            PostError(request, error.Code, error.Message);
        }
        catch (OperationCanceledException)
        {
            PostError(request, "CLOUDIG_CANCELLED", "操作已取消");
        }
        catch (Exception error) when (request.Command == "shell.example.download" && error is IOException or InvalidDataException or JsonException or KeyNotFoundException or InvalidOperationException or System.Net.Http.HttpRequestException or UnauthorizedAccessException)
        {
            TraceVisualAudit("example-download-failed", error.Message);
            PostError(request, "CLOUDIG_EXAMPLE_DOWNLOAD_FAILED", "范例下载未完成；请检查网络及docs目录。同名本地文件不会被覆盖。 / Example download did not complete. Check your connection and docs folder; existing files are preserved.");
        }
        catch (Exception error) when (request.Command.StartsWith("shell.update.", StringComparison.Ordinal) && error is IOException or InvalidDataException or UnauthorizedAccessException or System.Net.Http.HttpRequestException)
        {
            PostError(request, "CLOUDIG_UPDATE_FAILED", "更新未完成，请完成其它操作后重试；无法验证的安装包不会运行。 / Update did not complete. Finish other operations and retry; unverified installers are never run.\n" + error.Message);
        }
        catch (InvalidDataException) when (request.Command == "shell.checkUpdates")
        {
            PostError(request, "CLOUDIG_UPDATE_REQUEST_INVALID", "检查更新请求无效");
        }
        catch (InvalidDataException)
        {
            PostError(request, "CLOUDIG_RECYCLE_TARGET_CHANGED", "档案已经变化，请刷新列表后重试");
        }
        catch
        {
            PostError(request, "CLOUDIG_ENGINE_UNAVAILABLE", "本地引擎暂时不可用");
        }
        finally
        {
            _webRequests.TryRemove(request.Request, out _);
            cancellation.Dispose();
        }
    }

    private async Task<JsonElement> PlanLibraryMoveAsync(WebBridgeRequest request, JsonElement payload, CancellationToken cancellationToken)
    {
        ExactProperties(payload);
        if (_libraryRoot is null || !_libraryRoot.Equals(Path.TrimEndingDirectorySeparator(_layout.BaseDirectory), StringComparison.OrdinalIgnoreCase))
            throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_TEST_ROOT", "当前是与程序分开的测试资料目录；整体搬家须从完整采云文件夹启动。");
        if (_pickerTokens.Count > 0 || _webRequests.Count != 1) throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_BUSY", "请先完成其他采云操作。");
        var target = _layout.VisualAudit?.MoveTarget;
        if (target is null)
        {
            var dialog = new OpenFolderDialog { Title = "选择整个采云的新位置（普通空文件夹）", Multiselect = false, InitialDirectory = Path.GetDirectoryName(_libraryRoot) ?? _libraryRoot };
            if (dialog.ShowDialog(this) != true) return Json("{\"cancelled\":true}");
            target = dialog.FolderName;
        }
        try
        {
            PortableStorageBoundary.Verify(target);
            var plan = await PortableLibraryMove.PreviewAsync(_libraryRoot, target, cancellationToken);
            var capability = MoveCapability(); _libraryMovePlans.Clear(); _libraryMovePlans.TryAdd(capability, plan);
            return BookmarkJson(new { cancelled = false, plan = capability, source = plan.SourceRoot, target = plan.TargetRoot, bytes = plan.TotalBytes, files = plan.TotalFiles, directories = plan.TotalDirectories, estimate = true });
        }
        catch (OperationCanceledException) { throw; }
        catch (InvalidDataException error) { throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_TARGET_INVALID", error.Message, error); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_PLAN_FAILED", error.Message, error); }
    }

    private async Task<JsonElement> CommitLibraryMoveAsync(WebBridgeRequest request, JsonElement payload, CancellationToken cancellationToken)
    {
        ExactProperties(payload, "plan");
        if (!_libraryMovePlans.TryRemove(RequiredString(payload, "plan"), out var plan) || _libraryRoot is null || !_libraryRoot.Equals(plan.SourceRoot, StringComparison.OrdinalIgnoreCase))
            throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_PLAN_STALE", "搬迁计划已失效，请重新选择目标。");
        if (_engine is null || _webRequests.Count != 1 || _pickerTokens.Count > 0) throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_BUSY", "请先完成其他采云操作。");
        var endpoints = await _engine.SendAsync("library.move.endpoints", BookmarkJson(new { target = plan.TargetRoot }), cancellationToken);
        PortableMoveRequest job;
        try { job = await PortableLibraryMove.BeginAsync(plan.SourceRoot, plan.TargetRoot, endpoints.GetProperty("source").GetString()!, endpoints.GetProperty("target").GetString()!, cancellationToken); }
        catch (InvalidDataException error) { throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_PLAN_STALE", error.Message, error); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { throw new LibraryMoveCapabilityException("CLOUDIG_LIBRARY_MOVE_PREPARE_FAILED", "尚未移动任何文件。如有待处理搬迁，请重新打开采云选择继续或取消。\n\n" + error.Message, error); }
        // Send the page's acknowledgment before disposing its WebView.
        _closing = true;
        _ = Dispatcher.BeginInvoke(new Action(async () => await CloseForLibraryMoveAsync(job)), DispatcherPriority.Background);
        return Json("{\"status\":\"restarting\"}");
    }

    private async Task CloseForLibraryMoveAsync(PortableMoveRequest job)
    {
        Hide();
        try
        {
            await _startupFinished.Task;
            await ShutdownResourcesAsync();
            if (_webViewEnvironment is not null && !_browserExited.Task.IsCompletedSuccessfully) throw new IOException("网页显示进程尚未退出，采云没有开始搬迁。请稍后重新打开处理。");
            var prepared = await PortableLibraryMove.FreezeAsync(job);
            var start = PortableLibraryMove.HelperStartInfo(prepared);
            if (_layout.VisualAudit is { MoveTarget: not null } audit)
                start.Environment["CLOUDIG_TEST_RESTART_AUDIT"] = JsonSerializer.Serialize(new[] { "--visual-audit-output", audit.OutputFile, "--visual-audit-query", "screenshot=1&fixture=real&route=reader&theme=dawn&language=zh-CN&phase=motion-freeze", "--visual-audit-width", audit.Width.ToString(), "--visual-audit-height", audit.Height.ToString() });
            using var helper = Process.Start(start) ?? throw new IOException("无法启动退出后的搬迁程序。");
            TraceVisualAudit("library-move-helper-started", $"pid={helper.Id};owner={Environment.ProcessId}");
        }
        catch (Exception error)
        {
            if (_layout.VisualAudit is { } audit) { await File.WriteAllTextAsync(Path.ChangeExtension(audit.OutputFile, ".error.txt"), error.ToString()); Environment.ExitCode = 1; }
            else MessageBox.Show(this, "整体搬迁尚未完成，原文件仍在原位置。请重新打开采云，选择继续或取消。\n\n" + error.Message, "采云 Cloudig · 搬迁已停止", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally { _closeAllowed = true; Close(); }
    }

    private void BindLocalContent()
    {
        if (WebView.CoreWebView2 is null) return;
        var viewRoot = _engine is null ? null : Path.Combine(_engine.RuntimeRoot, "Views");
        if (viewRoot is not null) Directory.CreateDirectory(viewRoot);
        _localFiles?.Dispose();
        _localFiles = new LocalFileResponses(_layout.WebRoot, viewRoot);
        WebView.CoreWebView2.AddWebResourceRequestedFilter("https://cloudig.local/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        WebView.CoreWebView2.AddWebResourceRequestedFilter("https://cloudig-runtime.local/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        WebView.CoreWebView2.AddWebResourceRequestedFilter("https://cloudig-work.invalid/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        WebView.CoreWebView2.AddWebResourceRequestedFilter("https://cloudig-map.local/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        WebView.CoreWebView2.WebResourceRequested += (_, args) =>
        {
            var response = _localFiles?.Open(args.Request.Uri, args.Request.Method);
            if (response is null) return;
            args.Response = WebView.CoreWebView2.Environment.CreateWebResourceResponse(response.Content, response.Status, response.Reason, response.Headers);
        };
    }

    private static string MoveCapability()
    {
        var value = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return $"lm_{value}";
    }

    private async Task HandleBookmarkRequestAsync(WebBridgeRequest request)
    {
        var cancellation = new CancellationTokenSource();
        if (!_webRequests.TryAdd(request.Request, cancellation))
        {
            cancellation.Dispose();
            PostError(request, "CLOUDIG_WEB_REQUEST_REPLAY", "页面请求已失效");
            return;
        }
        try
        {
            var payload = request.Payload;
            JsonElement result;
            if (request.Command == "shell.bookmarks.query")
            {
                ExactProperties(payload, "profile");
                // Bookmark discovery/parsing/checksums contain synchronous work.
                // A background summary must not freeze the window or its loading GIF.
                result = BookmarkJson(await Task.Run(() => _bookmarks.QueryAsync(RequiredString(payload, "profile"), cancellation.Token), cancellation.Token));
            }
            else if (request.Command == "shell.bookmarks.target.query")
            {
                ExactProperties(payload, "profile", "store");
                result = BookmarkJson(await Task.Run(() => _bookmarks.QueryTargetAsync(
                    RequiredString(payload, "profile"),
                    RequiredString(payload, "store"),
                    cancellation.Token), cancellation.Token));
            }
            else if (request.Command == "shell.bookmarks.target.save")
            {
                ExactProperties(payload, "folder_name", "parent", "place_first", "profile", "store");
                result = BookmarkJson(await _bookmarks.SaveTargetAsync(
                    RequiredString(payload, "profile"),
                    RequiredString(payload, "store"),
                    RequiredString(payload, "parent"),
                    RequiredString(payload, "folder_name"),
                    RequiredBoolean(payload, "place_first"),
                    cancellation.Token));
            }
            else if (request.Command == "shell.bookmarks.copy")
            {
                ExactProperties(payload, "platform", "profile");
                var source = await _bookmarks.ReadSourceAsync(
                    RequiredString(payload, "platform"),
                    RequiredString(payload, "profile"),
                    cancellation.Token);
                Clipboard.SetDataObject(source, true);
                result = Json("{\"copied\":true}");
            }
            else if (request.Command is "shell.bookmarks.install" or "shell.bookmarks.remove")
            {
                ExactProperties(payload, "platforms", "profile");
                var platforms = RequiredStringArray(payload, "platforms");
                var mutation = request.Command.EndsWith("install", StringComparison.Ordinal)
                    ? await _bookmarks.InstallAsync(RequiredString(payload, "profile"), platforms, cancellation.Token)
                    : await _bookmarks.RemoveAsync(RequiredString(payload, "profile"), platforms, cancellation.Token);
                result = BookmarkJson(mutation);
            }
            else
            {
                throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", "Unknown bookmark command.");
            }
            PostResponse(request, true, result);
        }
        catch (BookmarkCapabilityException error)
        {
            PostError(request, error.Code, error.Message);
        }
        catch (OperationCanceledException)
        {
            PostError(request, "CLOUDIG_CANCELLED", "操作已取消");
        }
        catch
        {
            PostError(request, "CLOUDIG_BOOKMARK_OPERATION_FAILED", "书签操作未能完成");
        }
        finally
        {
            _webRequests.TryRemove(request.Request, out _);
            cancellation.Dispose();
        }
    }

    private static JsonElement BookmarkJson<T>(T value) => JsonSerializer.SerializeToElement(value, new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    });

    private static void ExactProperties(JsonElement payload, params string[] expected)
    {
        var actual = payload.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        var orderedExpected = expected.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(orderedExpected, StringComparer.Ordinal)) throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", "Bookmark request shape is invalid.");
    }

    private static string RequiredString(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", $"Bookmark request requires {property}.");
        }
        return value.GetString()!;
    }

    private static bool RequiredBoolean(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", $"Bookmark request requires {property}.");
        }
        return value.GetBoolean();
    }

    private static string[] RequiredStringArray(JsonElement payload, string property)
    {
        if (!payload.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", $"Bookmark request requires {property}.");
        }
        var result = value.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null).ToArray();
        if (result.Length is < 1 or > 12 || result.Any(string.IsNullOrWhiteSpace))
        {
            throw new BookmarkCapabilityException("CLOUDIG_BOOKMARK_REQUEST_INVALID", "Bookmark platform selection is invalid.");
        }
        return result.Select(item => item!).ToArray();
    }

    private async Task<JsonElement> PickSourcesAsync(WebBridgeRequest request, JsonElement payload, CancellationToken cancellationToken)
    {
        if (_libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        var properties = payload.EnumerateObject().ToArray();
        if (!payload.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String || properties.Any(p => p.Name is not ("kind" or "platform")))
        {
            throw new InvalidDataException("Source picker request is invalid.");
        }
        var kind = kindValue.GetString();
        var platform = payload.TryGetProperty("platform", out var platformValue) && platformValue.ValueKind == JsonValueKind.String ? platformValue.GetString() : null;
        if (kind != "platform_json" && properties.Length != 1) throw new InvalidDataException("Unexpected source platform selection.");
        if (kind == "platform_json" && platform is not ("claude" or "deepseek" or "grok" or "qwen" or "mistral" or "chatgpt" or "cline" or "sillytavern" or "kimi-code" or "claude-code" or "codex")) throw new InvalidDataException("Unsupported platform file source.");
        var zippedExport = kind == "platform_json" && platform is "grok" or "mistral" or "chatgpt";
        var agentJsonl = kind == "platform_json" && platform is "sillytavern" or "kimi-code" or "claude-code" or "codex";
        var dialog = new OpenFileDialog
        {
            CheckFileExists = true,
            CheckPathExists = true,
            Multiselect = true,
            RestoreDirectory = true,
            Title = zippedExport ? "选择完整官方 ZIP，无需解压 / Select official ZIP exports" : agentJsonl ? "选择 Agent Tool JSONL / Import Agent Tool JSONL" : kind is "claude_json" or "platform_json" ? "选择平台 JSON / Import Platform JSON" : "选择采云书签 HTML",
            Filter = zippedExport ? "Official export ZIP (*.zip)|*.zip" : agentJsonl ? "Agent Tool JSONL (*.jsonl)|*.jsonl" : kind is "claude_json" or "platform_json" ? "Platform JSON (*.json)|*.json" : "采云书签 HTML (*.html)|*.html"
        };
        if (kind is not ("html" or "claude_json" or "platform_json")) throw new InvalidDataException("Source picker kind is invalid.");
        TraceVisualAudit("source-picker-request", JsonSerializer.Serialize(new { kind, platform, title = dialog.Title, filter = dialog.Filter }));
        if (dialog.ShowDialog(this) != true) return Json("{\"cancelled\":true,\"items\":[]}");
        if (dialog.FileNames.Length is < 1 or > 100) throw new InvalidDataException("Source picker selection count is invalid.");
        var staged = new List<SourcePickerResult>();
        try
        {
            for (var index = 0; index < dialog.FileNames.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var picker = SourcePickerBoundary.CreateToken();
                var currentIndex = index + 1;
                var result = await SourcePickerBoundary.StageAsync(
                    _engine!.RuntimeRoot,
                    dialog.FileNames[index],
                    picker,
                    cancellationToken,
                    (completed, total) => Dispatcher.BeginInvoke(() => PostEvent(request, JsonSerializer.SerializeToElement(new
                    {
                        phase = "import-staging",
                        file = new { index = currentIndex, total = dialog.FileNames.Length },
                        bytes = new { completed, total }
                    }))));
                _pickerTokens.TryAdd(picker, 0);
                staged.Add(result);
                if (kind == "platform_json" && platform is "grok" or "mistral" or "chatgpt")
                {
                    var companions = await _engine.SendAsync("source.assets.plan", JsonSerializer.SerializeToElement(new { picker }), cancellationToken);
                    if (companions.GetProperty("platform").GetString() != platform) throw new InvalidDataException("文件与所选平台不符，请从对应平台入口导入。 / The selected file belongs to a different platform.");
                    if (companions.GetProperty("available").GetBoolean()) await SourcePickerBoundary.StageCompanionsAsync(_engine.RuntimeRoot, dialog.FileNames[index], picker, cancellationToken,
                        (completed, total) => Dispatcher.BeginInvoke(() => PostEvent(request, JsonSerializer.SerializeToElement(new { phase = "import-attachments", file = new { index = currentIndex, total = dialog.FileNames.Length }, items = new { completed, total } }))));
                }
            }
            return JsonSerializer.SerializeToElement(new
            {
                cancelled = false,
                items = staged.Select(value => new { picker = value.Picker, filename = value.Filename, bytes = value.Bytes }).ToArray()
            });
        }
        catch
        {
            foreach (var item in staged)
            {
                SourcePickerBoundary.RemoveOwned(_engine!.RuntimeRoot, item.Picker);
                _pickerTokens.TryRemove(item.Picker, out _);
            }
            throw;
        }
    }

    private async Task<JsonElement> PickIdentityAvatarAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        ExactProperties(payload);
        var dialog = new OpenFileDialog
        {
            CheckFileExists = true,
            CheckPathExists = true,
            Multiselect = false,
            RestoreDirectory = true,
            Title = "选择采云头像",
            Filter = "头像图片 (*.png;*.jpg;*.jpeg;*.gif;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.webp"
        };
        if (dialog.ShowDialog(this) != true) return Json("{\"cancelled\":true}");
        var picker = SourcePickerBoundary.CreateToken();
        var result = await SourcePickerBoundary.StageAsync(_engine!.RuntimeRoot, dialog.FileName, picker, cancellationToken);
        _pickerTokens.TryAdd(picker, 0);
        return BookmarkJson(new { cancelled = false, picker = result.Picker, filename = result.Filename, bytes = result.Bytes });
    }

    private async Task<JsonElement> DiscardIdentityAvatarAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        ExactProperties(payload, "picker");
        var picker = RequiredString(payload, "picker");
        if (!_pickerTokens.ContainsKey(picker)) return Json("{\"discarded\":false}");
        await _engine!.SendAsync("identity.avatar.discard", payload, cancellationToken);
        SourcePickerBoundary.RemoveOwned(_engine.RuntimeRoot, picker);
        _pickerTokens.TryRemove(picker, out _);
        return Json("{\"discarded\":true}");
    }

    private async Task<JsonElement> CommitIdentityAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_engine is null) throw new InvalidOperationException("Library is unavailable.");
        var result = await _engine.SendAsync("identity.commit", payload, cancellationToken);
        var stack = new Stack<JsonElement>();
        stack.Push(payload);
        while (stack.Count > 0)
        {
            var value = stack.Pop();
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in value.EnumerateObject())
                {
                    if (property.Name == "picker" && property.Value.ValueKind == JsonValueKind.String)
                    {
                        var picker = property.Value.GetString();
                        if (picker is not null) _pickerTokens.TryRemove(picker, out _);
                    }
                    else stack.Push(property.Value);
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray()) stack.Push(item);
            }
        }
        return result;
    }

    private async Task<JsonElement> SaveResourceAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_engine is null || _libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        ExactProperties(payload, "view", "resource");
        var result = await _engine.SendAsync("reader.resource.materialize", payload, cancellationToken);
        var uri = BridgePolicy.RuntimeUri(RequiredString(result, "virtual_path"));
        if (!uri.AbsolutePath.Contains("/assets/", StringComparison.Ordinal)) throw new InvalidDataException("Resource capability is invalid.");
        var source = Path.Combine(_engine!.RuntimeRoot, "Views", uri.AbsolutePath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
        var rawName = result.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String ? name.GetString() : null;
        var filename = Path.GetFileName(rawName ?? Path.GetFileName(source));
        filename = string.Concat(filename.Where(character => !Path.GetInvalidFileNameChars().Contains(character)));
        var dialog = new Microsoft.Win32.SaveFileDialog { FileName = string.IsNullOrWhiteSpace(filename) ? "attachment.bin" : filename, Title = "保存附件 / Save attachment", OverwritePrompt = true };
        if (dialog.ShowDialog(this) != true) return Json("{\"cancelled\":true}");
        cancellationToken.ThrowIfCancellationRequested();
        var staging = Path.Combine(Path.GetDirectoryName(dialog.FileName)!, $".cloudig-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
            await using (var output = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await input.CopyToAsync(output, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(staging, dialog.FileName, true);
        }
        finally { if (File.Exists(staging)) File.Delete(staging); }
        return Json("{\"saved\":true}");
    }

    private async Task<JsonElement> CopyMarkdownAsync(WebBridgeRequest request, CancellationToken cancellationToken)
    {
        var prepared = await _engine!.SendWithEventsAsync("reader.archive.copyMarkdown.prepare", request.Payload,
            value => Dispatcher.BeginInvoke(() => PostEvent(request, value)), cancellationToken);
        try
        {
            var text = await Task.Run(() => MarkdownClipboardPayload.ReadAsync(_libraryRoot!, RequiredString(prepared, "file"), prepared.GetProperty("bytes").GetInt64(), RequiredString(prepared, "sha256"), cancellationToken), cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            Clipboard.SetText(text);
            return JsonSerializer.SerializeToElement(new { copied = true, messages = prepared.GetProperty("messages").GetInt32() });
        }
        finally { await _engine.SendAsync("reader.archive.copyMarkdown.release", JsonSerializer.SerializeToElement(new { copy = RequiredString(prepared, "copy") }), CancellationToken.None); }
    }

    private JsonElement OpenManagedFolder(JsonElement payload)
    {
        if (_libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        var properties = payload.EnumerateObject().ToArray();
        if (properties.Length != 1 || properties[0].Name != "folder" || properties[0].Value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("Managed folder request is invalid.");
        }
        var target = properties[0].Value.GetString() switch
        {
            "library" => _libraryRoot,
            "inbox" => Path.Combine(_libraryRoot, "Inbox"),
            "conversations" => Path.Combine(_libraryRoot, "Conversations"),
            "exports" => Path.Combine(_libraryRoot, "Exports"),
            _ => throw new InvalidDataException("Managed folder name is invalid.")
        };
        var root = Path.GetFullPath(_libraryRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        target = Path.GetFullPath(target);
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase) && !target.Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Managed folder escaped the Library root.");
        }
        if (!Directory.Exists(target)) throw new DirectoryNotFoundException("Managed folder is missing.");
        var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        start.ArgumentList.Add(target);
        Process.Start(start);
        return Json("{\"opened\":true}");
    }

    private async Task<JsonElement> RevealSystemLogFileAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_engine is null || _libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        ExactProperties(payload, "file");
        var file = RequiredString(payload, "file");
        var planned = await _engine.SendAsync(
            "systemLog.reveal",
            JsonSerializer.SerializeToElement(new { file }),
            cancellationToken);
        var managedPath = planned.TryGetProperty("path", out var pathValue) ? pathValue.GetString() : null;
        if (string.IsNullOrEmpty(managedPath)) throw new SystemLogRevealException("CLOUDIG_SYSTEM_LOG_FILE_INVALID", "System Log reveal plan is incomplete.");
        var target = SystemLogRevealBoundary.ResolveExistingFile(_libraryRoot, managedPath);
        cancellationToken.ThrowIfCancellationRequested();
        var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        start.ArgumentList.Add("/select,");
        start.ArgumentList.Add(target);
        Process.Start(start);
        return Json("{\"located\":true}");
    }

    private async Task<JsonElement> RecycleArchiveAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_engine is null || _libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        var properties = payload.EnumerateObject().ToArray();
        if (properties.Length != 1 || properties[0].Name != "archive" || properties[0].Value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("Recycle request is invalid.");
        }
        var archive = properties[0].Value.GetString();
        if (string.IsNullOrEmpty(archive)) throw new InvalidDataException("Recycle archive capability is invalid.");
        var plan = await _engine.SendAsync(
            "reader.archive.recycle.plan",
            JsonSerializer.SerializeToElement(new { archive }),
            cancellationToken);
        return await ExecuteRecyclePlanAsync(plan, cancellationToken);
    }

    private async Task<JsonElement> ExecuteRecyclePlanAsync(JsonElement plan, CancellationToken cancellationToken)
    {
        if (_engine is null || _libraryRoot is null) throw new InvalidOperationException("Library is unavailable.");
        var planToken = plan.GetProperty("plan").GetString();
        if (string.IsNullOrEmpty(planToken)) throw new InvalidDataException("Recycle plan is incomplete.");
        var completed = false;
        try
        {
            var started = await _engine.SendAsync("reader.archive.recycle.begin", JsonSerializer.SerializeToElement(new { plan = planToken }), cancellationToken);
            await ArchiveRecycleBoundary.RecycleFilesAsync(_libraryRoot, started.GetProperty("files"),
                (target, token) => Task.Run(() => FileSystem.DeleteFile(target, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin), token), cancellationToken);
            var result = await _engine.SendAsync(
                "reader.archive.recycle.complete",
                JsonSerializer.SerializeToElement(new { plan = planToken }),
                cancellationToken);
            completed = true;
            return result;
        }
        finally
        {
            if (!completed)
            {
                try { await _engine.SendAsync("reader.archive.recycle.release", JsonSerializer.SerializeToElement(new { plan = planToken }), CancellationToken.None); }
                catch { /* The durable intent remains for explicit recovery after restart. */ }
            }
        }
    }

    private async Task ResolvePendingRecyclesAsync(JsonElement startup, bool english)
    {
        if (_engine is null) return;
        if (startup.TryGetProperty("recycle_issues", out var issues) && issues.GetArrayLength() > 0)
            MessageBox.Show(this, english ? "A deletion record in appdata/recycle could not be read. It and all remaining originals were preserved. No deletion was resumed." : "appdata/recycle 中有无法读取的删除记录，记录和剩余原件已保留，没有自动继续删除。", "Cloudig", MessageBoxButton.OK, MessageBoxImage.Warning);
        if (!startup.TryGetProperty("pending_recycles", out var operations)) return;
        foreach (var operation in operations.EnumerateArray())
        {
            var id = operation.GetProperty("operation").GetString() ?? throw new InvalidDataException("Recycle operation is missing.");
            var files = string.Join("\n", operation.GetProperty("files").EnumerateArray().Select(file => file.GetProperty("path").GetString()));
            var message = english
                ? $"A previous deletion was interrupted:\n\n{files}\n\nYes: move the remaining originals to the Windows Recycle Bin.\nNo: keep the remaining files and end this deletion.\nCancel: leave it pending until the next startup. Files already recycled can be restored from Windows."
                : $"上次删除没有完成：\n\n{files}\n\n是：继续将剩余原件移入 Windows 回收站。\n否：保留剩余文件，结束这次删除。\n取消：暂不处理，下次启动再提醒。已移入回收站的文件仍可在 Windows 中恢复。";
            var choice = MessageBox.Show(this, message, english ? "Unfinished deletion" : "未完成的删除", MessageBoxButton.YesNoCancel, MessageBoxImage.Question, MessageBoxResult.Cancel);
            if (choice == MessageBoxResult.Yes)
            {
                var plan = await _engine.SendAsync("reader.archive.recycle.resume", JsonSerializer.SerializeToElement(new { operation = id }));
                await ExecuteRecyclePlanAsync(plan, CancellationToken.None);
            }
            else if (choice == MessageBoxResult.No)
                await _engine.SendAsync("reader.archive.recycle.keepRemaining", JsonSerializer.SerializeToElement(new { operation = id }));
        }
    }

    private void ApplySurface(JsonElement payload)
    {
        var theme = payload.GetProperty("theme").GetString();
        var page = payload.GetProperty("page").GetString();
        if (theme is not ("dawn" or "star-night") || page is not ("welcome" or "reader" or "archiver")) throw new InvalidDataException();
        ApplySurface(theme, page);
    }

    private void ApplySurface(string theme, string page)
    {
        WindowSurfaceStyle style;
        try
        {
            style = WindowSurfaceStyles.Resolve(theme, page);
        }
        catch (ArgumentOutOfRangeException error)
        {
            throw new InvalidDataException("Window surface request is invalid.", error);
        }
        var caption = new LinearGradientBrush { StartPoint = new Point(0, .5), EndPoint = new Point(1, .5) };
        foreach (var stop in style.Stops) caption.GradientStops.Add(new GradientStop(MediaColor(stop.Color), stop.Offset));
        var border = new SolidColorBrush(MediaColor(style.Border));
        var foreground = new SolidColorBrush(MediaColor(style.Foreground));
        Resources["CaptionForegroundBrush"] = foreground;
        Resources["CaptionButtonHoverBrush"] = new SolidColorBrush(style.LightCaptionControls
            ? Color.FromArgb(20, 0, 0, 0)
            : Color.FromArgb(34, 255, 255, 255));
        Resources["CaptionButtonPressedBrush"] = new SolidColorBrush(style.LightCaptionControls
            ? Color.FromArgb(34, 0, 0, 0)
            : Color.FromArgb(52, 255, 255, 255));
        TitleBar.Background = caption;
        TitleBar.BorderBrush = border;
        WindowFrame.BorderBrush = border;
        TitleText.Foreground = foreground;
        MinimizeButton.Foreground = foreground;
        MaximizeButton.Foreground = foreground;
        CloseButton.Foreground = foreground;
        Background = caption;
        StartupFailure.Background = caption;
        var fallback = style.WebFallback;
        WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(fallback.Red, fallback.Green, fallback.Blue);
    }

    private static Color MediaColor(WindowSurfaceColor color) => Color.FromRgb(color.Red, color.Green, color.Blue);

    private byte[] CaptureTitleBarPng()
    {
        var dpi = VisualTreeHelper.GetDpi(TitleBar);
        var width = Math.Max(1, (int)Math.Ceiling(TitleBar.ActualWidth * dpi.DpiScaleX));
        var height = Math.Max(1, (int)Math.Ceiling(TitleBar.ActualHeight * dpi.DpiScaleY));
        var bitmap = new RenderTargetBitmap(width, height, dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
        bitmap.Render(TitleBar);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        return stream.ToArray();
    }

    private void PostResponse(WebBridgeRequest request, bool ok, JsonElement result)
    {
        if (_resourcesClosed || WebView.CoreWebView2 is null) return;
        if (request.Command is "reader.archives.query" or "reader.view.open" or "reader.view.page")
            TraceVisualAudit("reader-response", request.Command);
        if (request.Command is "archiver.sources.query" or "archiver.parse.plan" or "archiver.parse.commit" or "shell.bookmarks.query")
            TraceVisualAudit("archiver-response", request.Command);
        WebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            protocol = BridgePolicy.Protocol,
            kind = "response",
            request = request.Request,
            command = request.Command,
            ok,
            result
        }));
    }

    private void PostEvent(WebBridgeRequest request, JsonElement value)
    {
        if (_resourcesClosed || WebView.CoreWebView2 is null) return;
        WebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            protocol = BridgePolicy.Protocol,
            kind = "event",
            request = request.Request,
            command = request.Command,
            @event = value
        }));
    }

    private void PostError(WebBridgeRequest request, string code, string message)
    {
        if (_resourcesClosed || WebView.CoreWebView2 is null) return;
        if (request.Command.StartsWith("reader.", StringComparison.Ordinal))
            TraceVisualAudit("reader-error", $"{request.Command}:{code}");
        WebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            protocol = BridgePolicy.Protocol,
            kind = "response",
            request = request.Request,
            command = request.Command,
            ok = false,
            error = new { code, message }
        }));
    }

    private static JsonElement Json(string value)
    {
        using var document = JsonDocument.Parse(value);
        return document.RootElement.Clone();
    }

    private void MinimizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void ToggleMaximizeWindow(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void UpdateMaximizeGlyph()
    {
        var maximized = WindowState == WindowState.Maximized;
        MaximizeGlyph.Visibility = maximized ? Visibility.Collapsed : Visibility.Visible;
        RestoreGlyph.Visibility = maximized ? Visibility.Visible : Visibility.Collapsed;
        MaximizeButton.ToolTip = maximized ? "还原" : "最大化";
    }

    private void CloseWindow(object sender, RoutedEventArgs e) => Close();

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_closeAllowed) return;
        e.Cancel = true;
        if (_closing) return;
        var answer = MessageBox.Show(this, "确定关闭采云吗？", "采云 Cloudig", MessageBoxButton.YesNo, MessageBoxImage.None, MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes) return;
        _closing = true;
        Hide();
        _loadingVisible.TrySetResult(false);
        await _startupFinished.Task;
        await ShutdownResourcesAsync();
        _closeAllowed = true;
        Close();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        StopStartupSun();
        if (_engine is not null && !string.IsNullOrEmpty(_engine.RuntimeRoot))
        {
            foreach (var picker in _pickerTokens.Keys) SourcePickerBoundary.RemoveOwned(_engine.RuntimeRoot, picker);
            _pickerTokens.Clear();
        }
        foreach (var request in _webRequests.Values) request.Dispose();
        _webRequests.Clear();
        WebView.Dispose();
        _localFiles?.Dispose();
        _localFiles = null;
    }

    private async Task ShutdownResourcesAsync()
    {
        if (_resourcesClosed) return;
        _resourcesClosed = true;
        StopStartupSun();
        _loadingVisible.TrySetResult(false);
        _libraryReady.TrySetResult(false);
        foreach (var request in _webRequests.Values) request.Cancel();
        if (_preparedUpdate is not null) { try { PortableUpdateClient.Discard(_preparedUpdate); } catch (IOException) { } _preparedUpdate = null; }
        WebView.Dispose();
        _localFiles?.Dispose();
        _localFiles = null;
        if (_webViewEnvironment is not null)
        {
            try { await _browserExited.Task.WaitAsync(TimeSpan.FromSeconds(8)); }
            catch (TimeoutException) { TraceVisualAudit("cache-retained", "WebView process has not exited; no deletion"); }
        }
        if (_engine is not null) await _engine.DisposeAsync();
        try
        {
            if (_webViewCache is not null)
            {
                var size = _webViewCache.Footprint();
                TraceVisualAudit("cache-profile-footprint", $"files={size.Files};bytes={size.Bytes}");
                if (_webViewCache.RemoveAfterExit()) TraceVisualAudit("cache-profile-removed");
            }
        }
        catch (IOException error) { TraceVisualAudit("cache-retained", error.Message); }
        catch (UnauthorizedAccessException error) { TraceVisualAudit("cache-retained", error.Message); }
    }

    private void StopStartupSun()
    {
        _startupSun?.Dispose();
        _startupSun = null;
        StartupLoading.Visibility = Visibility.Collapsed;
    }
}
