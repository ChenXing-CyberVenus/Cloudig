using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Cloudig.Bookmarks;
using Microsoft.VisualBasic.FileIO;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

namespace Cloudig.Desktop;

public partial class MainWindow : Window
{
    private const double DesignContentWidth = 1920;
    private const double DesignContentHeight = 1080;
    private const double CustomTitleBarHeight = 38;
    private const double WorkAreaMargin = 24;
    private const string LocalOrigin = "https://cloudig.local";
    private const string ReaderOrigin = "https://reader.cloudig.local";
    private const string ReaderPagePath = "/Cloudig-Reader.html";
    private static readonly HashSet<string> ServiceCommands = new(StringComparer.Ordinal)
    {
        "library.summary",
        "library.create",
        "library.prepare-empty-v1",
        "library.move.plan",
        "library.move.execute",
        "library.save",
        "library.history.list",
        "library.history.restore",
        "time.range.preview",
        "time.system.get",
        "conversation.metadata.commit",
        "library.preferences.commit",
        "time.node.commit",
        "time.containment.commit",
        "time.counterpart.commit",
        "time.terran-mapping.commit",
        "time.terran-preset.commit",
        "time.display-order.commit",
        "time.node.delete.plan",
        "time.node.delete.commit",
        "time.reference.remove.plan",
        "time.reference.remove.commit",
        "time.timeline.plan",
        "time.timeline.commit",
        "files.import",
        "asset.import",
        "parse.all",
        "parse.file",
        "parse.settings.get",
        "parse.settings.save",
        "parse.batch.plan",
        "parse.batch.execute",
        "parse.dismiss-missing",
        "parse.dismiss-all-missing",
        "claude.index",
        "claude.list",
        "claude.extract",
        "reader.build",
        "archive.list",
        "archive.directory.create",
        "archive.directory.rename",
        "archive.directory.remove",
        "archive.move",
        "archive.archive",
        "archive.recycle.prepare",
        "archive.recycle.finalize",
        "archive.export-markdown"
    };
    private static readonly HashSet<string> LongServiceCommands = new(StringComparer.Ordinal)
    {
        "claude.index",
        "claude.extract",
        "parse.batch.execute",
        "reader.build",
        "reader.open",
        "library.move.plan",
        "library.move.execute"
    };
    private static readonly HashSet<string> IdentityPlatforms = new(StringComparer.Ordinal)
    {
        "chatgpt", "claude", "gemini", "grok", "qwen", "chatglm",
        "yuanbao", "zai", "deepseek", "kimi", "doubao", "mistral"
    };
    private static readonly JsonSerializerOptions BridgeJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly SemaphoreSlim _commandGate = new(1, 1);
    private readonly SemaphoreSlim _longOperationGate = new(1, 1);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _longOperations = new(StringComparer.Ordinal);
    private readonly HashSet<string> _approvedRoots = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _approvedImportFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _approvedAssetFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly AppPaths _paths;
    private readonly LocalSettings _settings;
    private readonly ManagerCommandHost _commandHost;
    private readonly BookmarkManager _bookmarkManager;
    private readonly List<BitmapSource> _transitionFrames = [];
    private DispatcherTimer? _transitionTimer;
    private int _transitionFrameIndex;
    private ulong _transitionNavigationId;
    private bool _hasRevealedInternalDocument;
    private string _readerLibraryRoot = string.Empty;
    private string _windowTheme = "star_night";
    private string _windowSurface = "welcome";
    private string _activeLibraryMoveId = string.Empty;
    private string _startupLibraryMoveStatus = string.Empty;
    private bool _closeConfirmed;

    public MainWindow()
    {
        InitializeComponent();
        ApplyDefaultWindowPlacement();
        _paths = AppPaths.Discover();
        _settings = new LocalSettings(_paths.SettingsFile);
        _commandHost = new ManagerCommandHost(_paths);
        _bookmarkManager = new BookmarkManager(
            _paths.BookmarkManifest,
            _paths.BookmarkArtifactRoot,
            Path.Combine(_paths.LocalDataRoot, "Backups", "ChromeBookmarks"),
            changelogPath: _paths.BookmarkChangelog);
        _approvedRoots.Add(NormalizePathKey(DefaultLibraryRoot()));
        ApplyWindowTheme(_windowTheme, _windowSurface);
        UpdateMaximizeGlyph();
        UpdateWindowFrame();
        StateChanged += (_, _) =>
        {
            UpdateMaximizeGlyph();
            UpdateWindowFrame();
        };
        Activated += (_, _) => ApplyWindowTheme(_windowTheme, _windowSurface);
        Deactivated += (_, _) => ApplyWindowTheme(_windowTheme, _windowSurface);
        Closing += ConfirmWindowClose;
        Loaded += OnLoaded;
        Closed += (_, _) =>
        {
            foreach (var operation in _longOperations.Values)
            {
                try { operation.Cancel(); } catch (ObjectDisposedException) { }
            }
            _commandHost.StopStreamingProcesses();
            _transitionTimer?.Stop();
            WebView.Dispose();
        };
    }

    private void ApplyDefaultWindowPlacement()
    {
        var workArea = SystemParameters.WorkArea;
        var availableWidth = Math.Max(1, workArea.Width - (WorkAreaMargin * 2));
        var availableContentHeight = Math.Max(1, workArea.Height - CustomTitleBarHeight - (WorkAreaMargin * 2));
        var fitScale = Math.Min(1, Math.Min(
            availableWidth / DesignContentWidth,
            availableContentHeight / DesignContentHeight));
        var minimumScale = Math.Max(
            MinWidth / DesignContentWidth,
            Math.Max(0, MinHeight - CustomTitleBarHeight) / DesignContentHeight);
        var scale = Math.Clamp(fitScale, minimumScale, 1);
        Width = DesignContentWidth * scale;
        Height = (DesignContentHeight * scale) + CustomTitleBarHeight;
        Left = workArea.Left + Math.Max(0, (workArea.Width - Width) / 2);
        Top = workArea.Top + Math.Max(0, (workArea.Height - Height) / 2);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        try
        {
            InitializeNativeTransition();
            await _settings.LoadAsync();
            await RecoverPendingLibraryMoveAsync();
            if (!string.IsNullOrWhiteSpace(_settings.LibraryRoot))
            {
                _approvedRoots.Add(NormalizePathKey(_settings.LibraryRoot));
            }
            Directory.CreateDirectory(_paths.WebViewDataRoot);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: _paths.WebViewDataRoot);
            WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(2, 0, 2);
            await WebView.EnsureCoreWebView2Async(environment);
            ConfigureWebView();
            await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "globalThis.__CLOUDIG_NATIVE_TRANSITION__ = true;");
            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "cloudig.local",
                _paths.WebRoot,
                CoreWebView2HostResourceAccessKind.DenyCors);
            WebView.Source = new Uri($"{LocalOrigin}/index.html");
        }
        catch (Exception error)
        {
            ShowStartupFailure(error);
        }
    }

    private void ConfigureWebView()
    {
        var core = WebView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = Debugger.IsAttached;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsWebMessageEnabled = true;
        core.NavigationStarting += (_, e) =>
        {
            if (IsManagerPage(e.Uri) || IsReaderPage(e.Uri))
            {
                _transitionNavigationId = e.NavigationId;
                ShowNativeTransition(animateSun: _hasRevealedInternalDocument);
                return;
            }
            e.Cancel = true;
            if ((IsReaderPage(WebView.Source?.AbsoluteUri) || IsManagerPage(WebView.Source?.AbsoluteUri))
                && e.IsUserInitiated && IsExternalHttpUri(e.Uri))
            {
                OpenExternalUri(e.Uri);
            }
        };
        core.DOMContentLoaded += OnInternalDomContentLoaded;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if ((IsReaderPage(WebView.Source?.AbsoluteUri) || IsManagerPage(WebView.Source?.AbsoluteUri))
                && e.IsUserInitiated && IsExternalHttpUri(e.Uri))
            {
                OpenExternalUri(e.Uri);
            }
        };
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.WebMessageReceived += OnWebMessageReceived;
    }

    private void InitializeNativeTransition()
    {
        var gifPath = Path.Combine(_paths.WebRoot, "assets", "brand", "Waiting-Sun.gif");
        using var stream = new FileStream(gifPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        var decoder = new GifBitmapDecoder(
            stream,
            BitmapCreateOptions.PreservePixelFormat,
            BitmapCacheOption.OnLoad);
        if (decoder.Frames.Count == 0)
        {
            throw new InvalidOperationException("Cloudig Waiting-Sun animation has no readable frames.");
        }
        var canvasWidth = decoder.Frames[0].PixelWidth;
        var canvasHeight = decoder.Frames[0].PixelHeight;
        BitmapSource? previousFrame = null;
        _transitionFrames.Clear();
        foreach (var frame in decoder.Frames)
        {
            var left = ReadGifFrameOffset(frame, "/imgdesc/Left");
            var top = ReadGifFrameOffset(frame, "/imgdesc/Top");
            var composedFrame = new RenderTargetBitmap(
                canvasWidth,
                canvasHeight,
                96,
                96,
                PixelFormats.Pbgra32);
            var visual = new DrawingVisual();
            using (var drawing = visual.RenderOpen())
            {
                if (previousFrame is not null)
                {
                    drawing.DrawImage(previousFrame, new Rect(0, 0, canvasWidth, canvasHeight));
                }
                drawing.DrawImage(frame, new Rect(left, top, frame.PixelWidth, frame.PixelHeight));
            }
            composedFrame.Render(visual);
            composedFrame.Freeze();
            _transitionFrames.Add(composedFrame);
            previousFrame = composedFrame;
        }
        _transitionFrameIndex = 0;
        TransitionSun.Source = _transitionFrames[0];
        TransitionOverlay.SizeChanged += (_, _) => UpdateNativeTransitionSize();
        UpdateNativeTransitionSize();
        _transitionTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(30) };
        _transitionTimer.Tick += (_, _) =>
        {
            _transitionFrameIndex = (_transitionFrameIndex + 1) % _transitionFrames.Count;
            TransitionSun.Source = _transitionFrames[_transitionFrameIndex];
        };
        _transitionTimer.Start();
    }

    private static int ReadGifFrameOffset(BitmapFrame frame, string query)
    {
        if (frame.Metadata is not BitmapMetadata metadata || !metadata.ContainsQuery(query)) return 0;
        return Convert.ToInt32(metadata.GetQuery(query));
    }

    private void UpdateNativeTransitionSize()
    {
        var width = Math.Clamp(TransitionOverlay.ActualWidth * 0.15, 232, 348);
        TransitionSun.Width = width;
        TransitionSun.Height = width * 122 / 232;
    }

    private void ShowNativeTransition(bool animateSun)
    {
        TransitionSun.BeginAnimation(OpacityProperty, null);
        TransitionSun.Opacity = animateSun ? 0 : 1;
        TransitionSun.Visibility = Visibility.Visible;
        TransitionOverlay.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Hidden;
        _transitionTimer?.Start();
        if (animateSun && SystemParameters.ClientAreaAnimation)
        {
            TransitionSun.BeginAnimation(OpacityProperty, new DoubleAnimation
            {
                From = 0,
                To = 1,
                Duration = TimeSpan.FromMilliseconds(140),
                FillBehavior = FillBehavior.HoldEnd
            });
        }
        else
        {
            TransitionSun.Opacity = 1;
        }
    }

    private async void OnInternalDomContentLoaded(object? sender, CoreWebView2DOMContentLoadedEventArgs e)
    {
        if (!IsManagerPage(WebView.Source?.AbsoluteUri) && !IsReaderPage(WebView.Source?.AbsoluteUri)) return;
        var navigationId = e.NavigationId;
        if (navigationId != _transitionNavigationId) return;
        var ready = await WaitForCloudigReadyAsync(navigationId);
        if (navigationId != _transitionNavigationId) return;
        var prepared = ready && await PrepareNativeTargetAsync();
        await FadeNativeSunOutAsync();
        if (navigationId != _transitionNavigationId) return;
        await Dispatcher.InvokeAsync(() =>
        {
            WebView.Visibility = Visibility.Visible;
            TransitionOverlay.Visibility = Visibility.Collapsed;
            _transitionTimer?.Stop();
            TransitionSun.BeginAnimation(OpacityProperty, null);
            TransitionSun.Opacity = 1;
            _hasRevealedInternalDocument = true;
        }, DispatcherPriority.Render);
        if (prepared) await RevealNativeTargetAsync();
    }

    private async Task<bool> WaitForCloudigReadyAsync(ulong navigationId)
    {
        for (var attempt = 0; attempt < 160; attempt += 1)
        {
            if (navigationId != _transitionNavigationId) return false;
            try
            {
                var ready = await WebView.CoreWebView2.ExecuteScriptAsync(
                    "document.documentElement.dataset.cloudigReady === 'true'");
                if (ready == "true") return true;
            }
            catch
            {
                return false;
            }
            await Task.Delay(50);
        }
        return false;
    }

    private async Task<bool> PrepareNativeTargetAsync()
    {
        try
        {
            var prepared = await WebView.CoreWebView2.ExecuteScriptAsync(
                """
                (() => {
                  const body = document.body;
                  if (!body) return false;
                  const boot = document.getElementById('cloudig-boot-screen');
                  if (boot) {
                    boot.setAttribute('aria-hidden', 'true');
                    boot.style.setProperty('display', 'none', 'important');
                  }
                  body.style.setProperty('transition', 'none', 'important');
                  body.style.setProperty('opacity', '0', 'important');
                  document.documentElement.dataset.cloudigNativeEntry = 'pending';
                  return true;
                })()
                """);
            return prepared == "true";
        }
        catch
        {
            return false;
        }
    }

    private Task FadeNativeSunOutAsync()
    {
        if (!SystemParameters.ClientAreaAnimation)
        {
            TransitionSun.Opacity = 0;
            return Task.CompletedTask;
        }
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var animation = new DoubleAnimation
        {
            From = TransitionSun.Opacity,
            To = 0,
            Duration = TimeSpan.FromMilliseconds(140),
            FillBehavior = FillBehavior.HoldEnd
        };
        animation.Completed += (_, _) => completion.TrySetResult(true);
        TransitionSun.BeginAnimation(OpacityProperty, animation);
        return completion.Task;
    }

    private async Task RevealNativeTargetAsync()
    {
        try
        {
            await WebView.CoreWebView2.ExecuteScriptAsync(
                """
                (() => {
                  const body = document.body;
                  if (!body) return false;
                  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
                  const duration = reduced ? 0 : 180;
                  body.style.setProperty('transition', duration ? 'opacity 180ms ease-out' : 'none', 'important');
                  const reveal = () => {
                    body.style.setProperty('opacity', '1', 'important');
                    globalThis.setTimeout(() => {
                      body.style.removeProperty('transition');
                      body.style.removeProperty('opacity');
                      delete document.documentElement.dataset.cloudigNativeEntry;
                    }, duration + 40);
                  };
                  globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(reveal));
                  return true;
                })()
                """);
        }
        catch
        {
            // The target is already visible; a failed cosmetic fade must not block navigation.
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var fromManager = IsManagerPage(e.Source);
        var fromReader = IsReaderPage(e.Source);
        if (!fromManager && !fromReader) return;
        string id = string.Empty;
        try
        {
            using var requestDocument = JsonDocument.Parse(e.WebMessageAsJson, new JsonDocumentOptions { MaxDepth = 32 });
            var request = requestDocument.RootElement;
            id = RequiredString(request, "id");
            var command = RequiredString(request, "command");
            var payload = request.TryGetProperty("payload", out var payloadElement)
                ? payloadElement
                : JsonSerializer.SerializeToElement(new { });
            if (fromManager && command is "operation.cancel" or "library.move.cancel")
            {
                PostResponse(id, ok: true, CancelLongOperation(payload), error: null);
                return;
            }
            if (!string.IsNullOrWhiteSpace(_activeLibraryMoveId))
            {
                throw new InvalidOperationException("Cloudig library is read-only while it is moving.");
            }
            if (fromManager && LongServiceCommands.Contains(command))
            {
                var result = await RunLongServiceAsync(id, command, payload);
                PostResponse(id, ok: true, result, error: null);
                return;
            }
            await _commandGate.WaitAsync();
            try
            {
                var result = fromReader
                    ? await DispatchReaderAsync(command, request)
                    : await DispatchAsync(command, request);
                PostResponse(id, ok: true, result, error: null);
            }
            finally
            {
                _commandGate.Release();
            }
        }
        catch (Exception error)
        {
            PostResponse(id, ok: false, result: null, error);
        }
    }

    private async Task<JsonElement> RunLongServiceAsync(string operationId, string command, JsonElement payload)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        if (!_approvedRoots.Contains(NormalizePathKey(root))
            || !NormalizePathKey(root).Equals(NormalizePathKey(_settings.LibraryRoot), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig will run long operations only for the current selected library.");
        }
        var movePlan = command == "library.move.execute"
            ? PendingMoveFromPlan(RequiredObject(payload, "plan"))
            : null;
        if (command is "library.move.plan" or "library.move.execute")
        {
            var target = command == "library.move.plan"
                ? Path.GetFullPath(RequiredString(payload, "target"))
                : movePlan!.TargetRoot;
            if (!_approvedRoots.Contains(NormalizePathKey(target)))
            {
                throw new InvalidOperationException("Cloudig can move only to a directory selected through this app.");
            }
        }
        if (!await _longOperationGate.WaitAsync(0))
        {
            throw new InvalidOperationException("Cloudig is already running another long operation for this library.");
        }
        var cancellation = new CancellationTokenSource();
        var registered = false;
        try
        {
            if (!_longOperations.TryAdd(operationId, cancellation))
            {
                throw new InvalidOperationException("Cloudig received a duplicate long-operation identifier.");
            }
            registered = true;
            if (movePlan is not null)
            {
                if (_settings.PendingLibraryMove is not null)
                {
                    throw new InvalidOperationException("Cloudig must finish recovering the previous library move before starting another one.");
                }
                await _settings.BeginLibraryMoveAsync(movePlan);
                _activeLibraryMoveId = operationId;
            }
            var serviceCommand = command == "reader.open" ? "reader.build" : command;
            var servicePayload = command == "reader.open"
                ? JsonSerializer.SerializeToElement(new { root, mode = "desktop_catalog" })
                : payload.Clone();
            var request = JsonSerializer.SerializeToElement(new
            {
                command = serviceCommand,
                operation_id = operationId,
                payload = servicePayload
            });
            var result = await _commandHost.RunStreamingAsync(
                request,
                async progress =>
                {
                    await Dispatcher.InvokeAsync(() => PostOperationEvent(operationId, progress));
                },
                cancellation.Token,
                movePlan is null ? null : async checkpoint =>
                {
                    if (RequiredString(checkpoint, "plan_id") != movePlan.PlanId
                        || !NormalizePathKey(RequiredString(checkpoint, "target_root"))
                            .Equals(NormalizePathKey(movePlan.TargetRoot), StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Cloudig library move checkpoint does not match the confirmed plan.");
                    }
                    await _settings.CommitLibraryMoveTargetAsync(movePlan.PlanId);
                    _approvedRoots.Add(NormalizePathKey(movePlan.TargetRoot));
                    return true;
                });
            if (command == "reader.open") result = CompletePreparedReader(payload, result);
            if (movePlan is not null)
            {
                var resultRoot = Path.GetFullPath(RequiredString(result, "root"));
                var cleanupPending = result.TryGetProperty("cleanup_pending", out var cleanup)
                    && cleanup.ValueKind is JsonValueKind.True;
                if (!cleanupPending) await _settings.CompleteLibraryMoveAsync(movePlan.PlanId, resultRoot);
                else _startupLibraryMoveStatus = "cleanup_pending";
            }
            return result;
        }
        catch
        {
            if (movePlan is not null) await RecoverPendingLibraryMoveAsync();
            throw;
        }
        finally
        {
            if (movePlan is not null) _activeLibraryMoveId = string.Empty;
            if (registered) _longOperations.TryRemove(operationId, out _);
            cancellation.Dispose();
            _longOperationGate.Release();
        }
    }

    private async Task RecoverPendingLibraryMoveAsync()
    {
        var pending = _settings.PendingLibraryMove;
        if (pending is null) return;
        try
        {
            var request = JsonSerializer.SerializeToElement(new
            {
                command = "library.move.recover",
                operation_id = $"startup-library-move-{Guid.NewGuid():N}",
                payload = new { plan = PendingMovePlanElement(pending) }
            });
            var result = await _commandHost.RunStreamingAsync(
                request,
                _ => Task.CompletedTask,
                CancellationToken.None,
                async checkpoint =>
                {
                    if (RequiredString(checkpoint, "plan_id") != pending.PlanId
                        || !NormalizePathKey(RequiredString(checkpoint, "target_root"))
                            .Equals(NormalizePathKey(pending.TargetRoot), StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Cloudig recovery checkpoint does not match the pending library move.");
                    }
                    await _settings.CommitLibraryMoveTargetAsync(pending.PlanId);
                    _approvedRoots.Add(NormalizePathKey(pending.TargetRoot));
                    return true;
                });
            var root = Path.GetFullPath(RequiredString(result, "root"));
            var cleanupPending = result.TryGetProperty("cleanup_pending", out var cleanup)
                && cleanup.ValueKind is JsonValueKind.True;
            if (!cleanupPending)
            {
                await _settings.CompleteLibraryMoveAsync(pending.PlanId, root);
                var recoveryStatus = OptionalString(result, "status");
                _startupLibraryMoveStatus = recoveryStatus is "rolled_back" or "source_current"
                    ? "rolled_back"
                    : "recovered";
            }
            else
            {
                _startupLibraryMoveStatus = "cleanup_pending";
            }
            _approvedRoots.Add(NormalizePathKey(root));
        }
        catch
        {
            _startupLibraryMoveStatus = "recovery_conflict";
        }
    }

    private static PendingLibraryMove PendingMoveFromPlan(JsonElement plan)
    {
        var strategy = RequiredString(plan, "strategy");
        if (strategy is not ("rename" or "copy_verify"))
        {
            throw new InvalidOperationException("Cloudig library move plan has an invalid strategy.");
        }
        return new PendingLibraryMove(
            RequiredString(plan, "plan_id").ToLowerInvariant(),
            Path.GetFullPath(RequiredString(plan, "source_root")),
            Path.GetFullPath(RequiredString(plan, "target_root")),
            strategy,
            plan.TryGetProperty("target_existed", out var targetExisted) && targetExisted.ValueKind is JsonValueKind.True,
            RequiredString(plan, "manifest_sha256").ToLowerInvariant(),
            RequiredInt64(plan, "total_bytes"),
            RequiredInt32(plan, "total_files"),
            RequiredInt32(plan, "total_directories"),
            "preparing");
    }

    private static JsonElement PendingMovePlanElement(PendingLibraryMove pending) =>
        JsonSerializer.SerializeToElement(new
        {
            format = "cloudig/library-move-plan/0.1.0",
            plan_id = pending.PlanId,
            source_root = pending.SourceRoot,
            target_root = pending.TargetRoot,
            strategy = pending.Strategy,
            target_existed = pending.TargetExisted,
            manifest_sha256 = pending.ManifestSha256,
            total_bytes = pending.TotalBytes,
            total_files = pending.TotalFiles,
            total_directories = pending.TotalDirectories
        });

    private JsonElement CancelLongOperation(JsonElement payload)
    {
        var operationId = RequiredString(payload, "operation_id");
        var accepted = _longOperations.TryGetValue(operationId, out var cancellation);
        if (accepted)
        {
            try { cancellation!.Cancel(); }
            catch (ObjectDisposedException) { accepted = false; }
        }
        return JsonSerializer.SerializeToElement(new { operation_id = operationId, cancel_requested = accepted });
    }

    private async Task<JsonElement> DispatchAsync(string command, JsonElement request)
    {
        var payload = request.TryGetProperty("payload", out var payloadElement)
            ? payloadElement
            : JsonSerializer.SerializeToElement(new { });

        return command switch
        {
            "app.bootstrap" => JsonSerializer.SerializeToElement(new
            {
                version = "V1.0.0-dev",
                milestone = "内容时间",
                default_root = DefaultLibraryRoot(),
                library_root = ExistingLibraryRoot(_settings.LibraryRoot),
                library_move_status = _startupLibraryMoveStatus,
                theme_switch_used_version = _settings.ThemeSwitchUsedVersion
            }),
            "window.set-theme" => await SetWindowThemeAsync(payload),
            "settings.set-library" => await SetLibraryAsync(payload),
            "dialog.choose-library" => ChooseLibrary(payload),
            "dialog.import-files" => ChooseImportFiles(payload),
            "dialog.choose-asset" => ChooseAsset(payload),
            "path.open-directory" => OpenPath(payload, directory: true),
            "path.open-file" => OpenPath(payload, directory: false),
            "reader.open" => await PrepareReaderAsync(payload),
            "archive.recycle" => await RecycleConversationsAsync(payload),
            "bookmarks.summary" => await GetBookmarkSummaryAsync(payload),
            "bookmarks.target" => await GetBookmarkTargetAsync(payload),
            "bookmarks.target.save" => await SaveBookmarkTargetAsync(payload),
            "bookmarks.copy-source" => await CopyBookmarkSourceAsync(payload),
            "bookmarks.install" => await RunBookmarkTransactionAsync(payload, BookmarkOperation.InstallOrRepair),
            "bookmarks.remove" => await RunBookmarkTransactionAsync(payload, BookmarkOperation.Remove),
            _ when ServiceCommands.Contains(command) => await RunServiceAsync(command, request, payload),
            _ => throw new InvalidOperationException($"Unsupported Cloudig bridge command: {command}")
        };
    }

    private async Task<JsonElement> SetWindowThemeAsync(JsonElement payload)
    {
        var theme = RequiredString(payload, "theme");
        if (theme is not ("star_night" or "dawn"))
        {
            throw new InvalidOperationException("Cloudig received an unsupported window theme.");
        }
        var surface = RequiredString(payload, "surface");
        if (surface is not ("welcome" or "reader" or "archiver"))
        {
            throw new InvalidOperationException("Cloudig received an unsupported window surface.");
        }
        _windowTheme = theme;
        _windowSurface = surface;
        if (payload.TryGetProperty("theme_switch_used_version", out var usedVersionElement))
        {
            if (usedVersionElement.ValueKind != JsonValueKind.Number
                || !usedVersionElement.TryGetInt32(out var usedVersion)
                || usedVersion < 1
                || usedVersion > 1000)
            {
                throw new InvalidOperationException("Cloudig received an invalid theme-switch onboarding version.");
            }
            await _settings.SetThemeSwitchUsedVersionAsync(usedVersion);
        }
        ApplyWindowTheme(theme, surface);
        return JsonSerializer.SerializeToElement(new
        {
            theme,
            surface,
            theme_switch_used_version = _settings.ThemeSwitchUsedVersion
        });
    }

    private void ApplyWindowTheme(string theme, string surface)
    {
        var dark = theme == "star_night";
        var captionBrush = new LinearGradientBrush
        {
            StartPoint = new Point(0, 0.5),
            EndPoint = new Point(1, 0.5)
        };
        if (surface == "welcome")
        {
            captionBrush.GradientStops.Add(new GradientStop(dark ? Color.FromRgb(0, 0, 0) : Color.FromRgb(255, 255, 255), 0));
            captionBrush.GradientStops.Add(new GradientStop(dark ? Color.FromRgb(17, 17, 17) : Color.FromRgb(210, 210, 210), 0.5));
            captionBrush.GradientStops.Add(new GradientStop(dark ? Color.FromRgb(0, 0, 0) : Color.FromRgb(255, 255, 255), 1));
        }
        else if (surface == "archiver" && !dark)
        {
            captionBrush.GradientStops.Add(new GradientStop(Color.FromRgb(132, 32, 30), 0));
            captionBrush.GradientStops.Add(new GradientStop(Color.FromRgb(249, 202, 130), 0.34));
            captionBrush.GradientStops.Add(new GradientStop(Color.FromRgb(174, 139, 127), 0.68));
            captionBrush.GradientStops.Add(new GradientStop(Color.FromRgb(75, 127, 130), 1));
        }
        else
        {
            captionBrush.GradientStops.Add(new GradientStop(dark ? Color.FromRgb(59, 56, 60) : Color.FromRgb(224, 201, 173), 0));
            captionBrush.GradientStops.Add(new GradientStop(dark ? Color.FromRgb(73, 73, 78) : Color.FromRgb(234, 216, 195), 1));
        }
        var text = dark
            ? Color.FromRgb(226, 225, 225)
            : surface == "archiver" ? Color.FromRgb(253, 252, 237) : Color.FromRgb(45, 45, 45);
        var border = surface switch
        {
            "welcome" => dark ? Color.FromRgb(30, 30, 30) : Color.FromRgb(210, 210, 210),
            "archiver" => dark ? Color.FromRgb(40, 40, 40) : Color.FromRgb(132, 32, 30),
            _ => dark ? Color.FromRgb(40, 40, 40) : Color.FromRgb(183, 136, 98)
        };
        var textBrush = new SolidColorBrush(text);
        var borderBrush = new SolidColorBrush(border);
        Resources["CaptionForegroundBrush"] = textBrush;
        var lightCaptionControls = !dark && surface != "archiver";
        Resources["CaptionButtonHoverBrush"] = new SolidColorBrush(!lightCaptionControls
            ? Color.FromArgb(34, 255, 255, 255)
            : Color.FromArgb(20, 0, 0, 0));
        Resources["CaptionButtonPressedBrush"] = new SolidColorBrush(!lightCaptionControls
            ? Color.FromArgb(52, 255, 255, 255)
            : Color.FromArgb(34, 0, 0, 0));
        Background = captionBrush;
        WindowFrame.BorderBrush = borderBrush;
        TitleBarChrome.Background = captionBrush;
        TitleBarChrome.BorderBrush = borderBrush;
        TitleBarTitle.Foreground = textBrush;
        StartupFailure.Background = captionBrush;
    }

    private void MinimizeWindow(object sender, RoutedEventArgs e) => WindowState = System.Windows.WindowState.Minimized;

    private void ToggleMaximizeWindow(object sender, RoutedEventArgs e) =>
        WindowState = WindowState == System.Windows.WindowState.Maximized
            ? System.Windows.WindowState.Normal
            : System.Windows.WindowState.Maximized;

    private void CloseWindow(object sender, RoutedEventArgs e) => Close();

    private void ConfirmWindowClose(object? sender, CancelEventArgs e)
    {
        if (_closeConfirmed) return;
        var answer = MessageBox.Show(
            this,
            "确定关闭采云吗？\n\n正在进行的解析或尚未保存的编辑将会停止。",
            "关闭采云 Cloudig",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question,
            MessageBoxResult.No);
        if (answer != MessageBoxResult.Yes)
        {
            e.Cancel = true;
            return;
        }
        _closeConfirmed = true;
    }

    private void UpdateMaximizeGlyph()
    {
        if (MaximizeGlyph is null || RestoreGlyph is null || MaximizeButton is null) return;
        var maximized = WindowState == System.Windows.WindowState.Maximized;
        MaximizeGlyph.Visibility = maximized ? Visibility.Collapsed : Visibility.Visible;
        RestoreGlyph.Visibility = maximized ? Visibility.Visible : Visibility.Collapsed;
        MaximizeButton.ToolTip = maximized ? "还原" : "最大化";
        System.Windows.Automation.AutomationProperties.SetName(MaximizeButton, maximized ? "还原" : "最大化");
    }

    private void UpdateWindowFrame()
    {
        if (WindowFrame is null) return;
        var maximized = WindowState == System.Windows.WindowState.Maximized;
        WindowFrame.BorderThickness = maximized ? new Thickness(0) : new Thickness(1);
        WindowFrame.Margin = maximized
            ? SystemParameters.WindowResizeBorderThickness
            : new Thickness(0);
    }

    private async Task<JsonElement> DispatchReaderAsync(string command, JsonElement request)
    {
        var payload = request.TryGetProperty("payload", out var payloadElement)
            ? payloadElement
            : JsonSerializer.SerializeToElement(new { });
        if (command == "window.set-theme")
        {
            return await SetWindowThemeAsync(payload);
        }
        if (command != "reader.save-library"
            && command != "reader.save-markdown"
            && command != "reader.open-json"
            && command != "reader.read-conversation"
            && command != "reader.open-library"
            && command != "reader.library-info"
            && command != "reader.choose-asset"
            && command != "reader.import-asset"
            && command != "reader.archive-list"
            && command != "reader.directory-create"
            && command != "reader.directory-rename"
            && command != "reader.directory-remove"
            && command != "reader.archive-move")
        {
            throw new InvalidOperationException($"Unsupported Cloudig Reader bridge command: {command}");
        }
        if (string.IsNullOrWhiteSpace(_readerLibraryRoot)
            || !NormalizePathKey(_readerLibraryRoot).Equals(NormalizePathKey(_settings.LibraryRoot), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("This Reader is no longer attached to the current Cloudig library.");
        }
        if (command is "reader.archive-list"
            or "reader.directory-create"
            or "reader.directory-rename"
            or "reader.directory-remove"
            or "reader.archive-move")
        {
            return await RunReaderArchiveCommandAsync(command, payload);
        }
        if (command == "reader.library-info")
        {
            return JsonSerializer.SerializeToElement(new
            {
                path = _readerLibraryRoot,
                theme_switch_used_version = _settings.ThemeSwitchUsedVersion
            });
        }
        if (command == "reader.choose-asset")
        {
            return ChooseAsset(payload);
        }
        if (command == "reader.import-asset")
        {
            var file = RequiredString(payload, "file");
            var usage = ValidateAssetUsage(OptionalString(payload, "usage"));
            var servicePayload = JsonSerializer.SerializeToElement(new
            {
                root = _readerLibraryRoot,
                file,
                usage
            });
            var assetServiceRequest = JsonSerializer.SerializeToElement(new
            {
                command = "asset.import",
                payload = servicePayload
            });
            return await RunServiceAsync("asset.import", assetServiceRequest, servicePayload);
        }
        if (command == "reader.open-library")
        {
            Process.Start(new ProcessStartInfo(_readerLibraryRoot) { UseShellExecute = true });
            return JsonSerializer.SerializeToElement(new { opened = true, path = _readerLibraryRoot });
        }
        if (command == "reader.open-json")
        {
            var relativePath = RequiredString(payload, "relative_path").Replace('/', Path.DirectorySeparatorChar);
            var conversationsRoot = Path.GetFullPath(Path.Combine(_readerLibraryRoot, "Conversations"));
            var candidate = Path.GetFullPath(Path.Combine(_readerLibraryRoot, relativePath));
            if (!IsWithin(candidate, conversationsRoot)
                || !candidate.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                || !File.Exists(candidate))
            {
                throw new InvalidOperationException("Cloudig Reader can open only an existing JSON file inside Conversations.");
            }
            Process.Start(new ProcessStartInfo(candidate) { UseShellExecute = true });
            return JsonSerializer.SerializeToElement(new { opened = true, path = candidate });
        }
        if (command == "reader.read-conversation")
        {
            var conversationPayload = JsonSerializer.SerializeToElement(new
            {
                root = _readerLibraryRoot,
                relative_path = RequiredString(payload, "relative_path"),
                expected_sha256 = RequiredString(payload, "expected_sha256")
            });
            var conversationRequest = JsonSerializer.SerializeToElement(new
            {
                command = "reader.conversation.read",
                payload = conversationPayload
            });
            return await RunServiceAsync("reader.conversation.read", conversationRequest, conversationPayload);
        }
        if (command == "reader.save-markdown")
        {
            var fileName = RequiredString(payload, "file_name");
            var markdown = RequiredString(payload, "markdown");
            var exportRequest = JsonSerializer.SerializeToElement(new
            {
                command = "export.markdown",
                payload = new
                {
                    root = _readerLibraryRoot,
                    file_name = fileName,
                    markdown
                }
            });
            return await _commandHost.RunAsync(exportRequest);
        }
        if (!payload.TryGetProperty("library", out var library) || library.ValueKind is not JsonValueKind.Object)
        {
            throw new InvalidOperationException("Cloudig Reader save requires a Library object.");
        }
        var expectedSha256 = RequiredString(payload, "expected_sha256");
        var serviceRequest = JsonSerializer.SerializeToElement(new
        {
            command = "library.save",
            payload = new
            {
                root = _readerLibraryRoot,
                library = library.Clone(),
                expected_sha256 = expectedSha256
            }
        });
        return await _commandHost.RunAsync(serviceRequest);
    }

    private async Task<JsonElement> RunReaderArchiveCommandAsync(string command, JsonElement payload)
    {
        var root = _readerLibraryRoot;
        var serviceCommand = command switch
        {
            "reader.archive-list" => "archive.list",
            "reader.directory-create" => "archive.directory.create",
            "reader.directory-rename" => "archive.directory.rename",
            "reader.directory-remove" => "archive.directory.remove",
            "reader.archive-move" => "archive.move",
            _ => throw new InvalidOperationException($"Unsupported Cloudig Reader archive command: {command}")
        };
        var servicePayload = command switch
        {
            "reader.archive-list" => JsonSerializer.SerializeToElement(new { root }),
            "reader.directory-create" => JsonSerializer.SerializeToElement(new
            {
                root,
                name = RequiredString(payload, "name"),
                expected_revision = RequiredString(payload, "expected_revision")
            }),
            "reader.directory-rename" => JsonSerializer.SerializeToElement(new
            {
                root,
                old_name = RequiredString(payload, "old_name"),
                new_name = RequiredString(payload, "new_name"),
                expected_revision = RequiredString(payload, "expected_revision")
            }),
            "reader.directory-remove" => JsonSerializer.SerializeToElement(new
            {
                root,
                name = RequiredString(payload, "name"),
                expected_revision = RequiredString(payload, "expected_revision")
            }),
            "reader.archive-move" => JsonSerializer.SerializeToElement(new
            {
                root,
                relative_paths = RequiredStringArray(payload, "relative_paths"),
                destination = OptionalString(payload, "destination"),
                expected_revision = RequiredString(payload, "expected_revision")
            }),
            _ => throw new InvalidOperationException($"Unsupported Cloudig Reader archive command: {command}")
        };
        var request = JsonSerializer.SerializeToElement(new
        {
            command = serviceCommand,
            payload = servicePayload
        });
        return await RunServiceAsync(serviceCommand, request, servicePayload);
    }

    private async Task<JsonElement> PrepareReaderAsync(JsonElement payload)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        var theme = RequiredString(payload, "theme");
        if (theme is not ("star_night" or "dawn"))
        {
            throw new InvalidOperationException("Cloudig received an unsupported Reader theme.");
        }
        if (!_approvedRoots.Contains(NormalizePathKey(root))
            || !NormalizePathKey(root).Equals(NormalizePathKey(_settings.LibraryRoot), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig will open Reader only for the current selected library.");
        }
        var serviceRequest = JsonSerializer.SerializeToElement(new
        {
            command = "reader.build",
            payload = new { root, mode = "desktop_catalog" }
        });
        var result = await RunServiceAsync("reader.build", serviceRequest, serviceRequest.GetProperty("payload"));
        return CompletePreparedReader(payload, result);
    }

    private JsonElement CompletePreparedReader(JsonElement payload, JsonElement result)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        var theme = RequiredString(payload, "theme");
        if (theme is not ("star_night" or "dawn"))
        {
            throw new InvalidOperationException("Cloudig received an unsupported Reader theme.");
        }
        var output = Path.GetFullPath(RequiredString(result, "output"));
        var build = result.GetProperty("build").Clone();
        var mode = build.TryGetProperty("mode", out var modeElement)
            ? modeElement.GetString() ?? string.Empty
            : string.Empty;
        if (mode != "desktop_catalog")
        {
            throw new InvalidOperationException("Cloudig desktop Reader requires a catalog-first build.");
        }
        var readerRuntime = Path.Combine(root, "Data", "Reader");
        var expectedOutput = Path.Combine(readerRuntime, "Cloudig-Reader.html");
        if (!NormalizePathKey(output).Equals(NormalizePathKey(expectedOutput), StringComparison.OrdinalIgnoreCase)
            || !File.Exists(output))
        {
            throw new InvalidOperationException("Cloudig Reader build did not produce the expected verified export.");
        }

        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "reader.cloudig.local",
            readerRuntime,
            CoreWebView2HostResourceAccessKind.DenyCors);
        _readerLibraryRoot = root;
        var revision = build.TryGetProperty("sha256", out var hash) ? hash.GetString() ?? string.Empty : string.Empty;
        var url = $"{ReaderOrigin}{ReaderPagePath}?v={Uri.EscapeDataString(revision)}&theme={Uri.EscapeDataString(theme)}";
        return JsonSerializer.SerializeToElement(new { url, output, build });
    }

    private async Task<JsonElement> RunBookmarkTransactionAsync(JsonElement payload, BookmarkOperation operation)
    {
        if (ChromeProfileDiscovery.IsChromeRunning())
        {
            throw new InvalidOperationException("请先完整退出 Google Chrome；采云不会强制结束浏览器进程。");
        }
        var stores = RequiredStringArray(payload, "stores");
        if (stores.Length == 0) throw new InvalidOperationException("请至少选择一个 Chrome 书签库。");
        var requestedProfile = RequiredString(payload, "requested_profile");
        var bookmarkIds = RequiredStringArray(payload, "bookmark_ids");
        if (bookmarkIds.Length == 0) throw new InvalidOperationException("请至少选择一个采云书签。");
        if (stores.Length != 1) throw new InvalidOperationException("采云正式书签目录一次只属于一个 Chrome 书签库。");
        var settings = await EnsureBookmarkInstallSettingsAsync(stores[0]);
        var target = ToBookmarkTarget(settings);
        var targetContext = await _bookmarkManager.DescribeTargetAsync(stores[0], target);
        if (operation is BookmarkOperation.Remove)
        {
            if (!targetContext.Exists)
            {
                throw new InvalidOperationException("采云没有找到用户指定的正式书签目录；为避免误删，卸载已经停止。");
            }
            var targetLabel = $"所选 {bookmarkIds.Length} 个采云书签（{requestedProfile}）";
            var prompt = $"采云将从正式目录“{targetContext.DisplayPath}”中移除{targetLabel}。\n\n只删除该目录直属且属于本次正式安装的书签；写入前会完整备份，失败时自动回滚。是否继续？";
            if (MessageBox.Show(this, prompt, "采云 · 移除书签", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) is not MessageBoxResult.Yes)
            {
                throw new InvalidOperationException("用户取消了 Chrome 书签事务。");
            }
        }
        var result = await _bookmarkManager.ExecuteAsync(
            stores,
            operation,
            requestedProfile,
            bookmarkIds,
            target,
            requireChromeClosed: true);
        var managedFolderGuid = result.Stores.Single().Mutation.ManagedFolderGuid;
        await _settings.SetBookmarkInstallAsync(settings with
        {
            ManagedFolderGuid = managedFolderGuid,
            PlacementPending = false
        });
        return JsonSerializer.SerializeToElement(result, BridgeJsonOptions);
    }

    private async Task<JsonElement> GetBookmarkSummaryAsync(JsonElement payload)
    {
        var summary = await _bookmarkManager.SummarizeAsync(
            RequiredString(payload, "requested_profile"),
            ToBookmarkTarget(_settings.BookmarkInstall));
        return JsonSerializer.SerializeToElement(summary, BridgeJsonOptions);
    }

    private async Task<JsonElement> GetBookmarkTargetAsync(JsonElement payload)
    {
        var store = RequiredString(payload, "store");
        var settings = await EnsureBookmarkInstallSettingsAsync(store);
        var context = await _bookmarkManager.DescribeTargetAsync(store, ToBookmarkTarget(settings));
        return JsonSerializer.SerializeToElement(context, BridgeJsonOptions);
    }

    private async Task<JsonElement> SaveBookmarkTargetAsync(JsonElement payload)
    {
        var store = RequiredString(payload, "store");
        var current = await EnsureBookmarkInstallSettingsAsync(store);
        var parentGuid = RequiredString(payload, "parent_guid");
        var folderName = RequiredString(payload, "folder_name").Trim();
        if (folderName.Length > 160 || folderName.Any(char.IsControl))
        {
            throw new InvalidOperationException("采云书签文件夹名称无效。");
        }
        var currentContext = await _bookmarkManager.DescribeTargetAsync(store, ToBookmarkTarget(current));
        if (!currentContext.Folders.Any(option => option.Guid.Equals(parentGuid, StringComparison.OrdinalIgnoreCase) && option.Selectable))
        {
            throw new InvalidOperationException("所选 Chrome 书签路径不存在，或位于正式目录自身内部。");
        }
        var updated = current with
        {
            ParentGuid = parentGuid,
            FolderName = folderName,
            PlaceFirst = RequiredBoolean(payload, "place_first"),
            PlacementPending = true
        };
        await _settings.SetBookmarkInstallAsync(updated);
        var context = await _bookmarkManager.DescribeTargetAsync(store, ToBookmarkTarget(updated));
        return JsonSerializer.SerializeToElement(context, BridgeJsonOptions);
    }

    private async Task<BookmarkInstallSettings> EnsureBookmarkInstallSettingsAsync(string store)
    {
        var normalizedStore = NormalizePathKey(store);
        var current = _settings.BookmarkInstall;
        var sameStore = !string.IsNullOrWhiteSpace(current.StorePath)
                        && NormalizePathKey(current.StorePath).Equals(normalizedStore, StringComparison.OrdinalIgnoreCase);
        var installationId = sameStore && Guid.TryParse(current.InstallationId, out _)
            ? current.InstallationId
            : Guid.NewGuid().ToString("D").ToLowerInvariant();
        var updated = sameStore
            ? current with { StorePath = normalizedStore, InstallationId = installationId }
            : BookmarkInstallSettings.Default with
            {
                StorePath = normalizedStore,
                InstallationId = installationId
            };
        if (updated != current) await _settings.SetBookmarkInstallAsync(updated);
        return updated;
    }

    private static BookmarkInstallTarget ToBookmarkTarget(BookmarkInstallSettings settings) => new(
        settings.StorePath,
        settings.ParentGuid,
        settings.FolderName,
        settings.PlaceFirst,
        settings.InstallationId,
        settings.ManagedFolderGuid,
        settings.PlacementPending);

    private async Task<JsonElement> SetLibraryAsync(JsonElement payload)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        if (!_approvedRoots.Contains(NormalizePathKey(root)))
        {
            throw new InvalidOperationException("Cloudig can remember only a library selected through this app.");
        }
        if (!File.Exists(Path.Combine(root, "cloudig-library.json")))
        {
            throw new InvalidOperationException("Cloudig can remember only an initialized library.");
        }
        await _settings.SetLibraryRootAsync(root);
        _approvedRoots.Add(NormalizePathKey(root));
        return JsonSerializer.SerializeToElement(new { root });
    }

    private JsonElement ChooseLibrary(JsonElement payload)
    {
        var initial = OptionalString(payload, "current");
        var dialog = new OpenFolderDialog
        {
            Title = "选择或建立采云资料库",
            Multiselect = false
        };
        if (!string.IsNullOrWhiteSpace(initial) && Directory.Exists(initial)) dialog.InitialDirectory = initial;
        var accepted = dialog.ShowDialog() is true;
        var root = accepted ? Path.GetFullPath(dialog.FolderName) : string.Empty;
        if (accepted) _approvedRoots.Add(NormalizePathKey(root));
        return JsonSerializer.SerializeToElement(new { root });
    }

    private JsonElement ChooseImportFiles(JsonElement payload)
    {
        var kind = OptionalString(payload, "kind");
        var title = kind == "html" ? "导入采云网页 HTML" : kind == "claude" ? "导入 Claude 官方 conversations.json" : "导入采云支持的档案";
        var filter = kind == "html"
            ? "HTML (*.html;*.htm)|*.html;*.htm"
            : kind == "claude"
                ? "Claude JSON (*.json)|*.json"
                : "采云支持的档案 (*.html;*.htm;*.json)|*.html;*.htm;*.json|HTML (*.html;*.htm)|*.html;*.htm|JSON (*.json)|*.json";
        var dialog = new OpenFileDialog
        {
            Title = title,
            Filter = filter,
            Multiselect = true,
            CheckFileExists = true,
            CheckPathExists = true
        };
        var accepted = dialog.ShowDialog() is true;
        var files = accepted ? dialog.FileNames.Select(Path.GetFullPath).ToArray() : Array.Empty<string>();
        _approvedImportFiles.Clear();
        foreach (var file in files) _approvedImportFiles.Add(NormalizePathKey(file));
        return JsonSerializer.SerializeToElement(new { files });
    }

    private JsonElement ChooseAsset(JsonElement payload)
    {
        var usage = ValidateAssetUsage(OptionalString(payload, "usage"));
        var dialog = new OpenFileDialog
        {
            Title = "选择采云图片",
            Filter = "图片 (*.png;*.jpg;*.jpeg;*.gif;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.webp|PNG (*.png)|*.png|JPEG (*.jpg;*.jpeg)|*.jpg;*.jpeg|WebP (*.webp)|*.webp|GIF (*.gif)|*.gif",
            Multiselect = false,
            CheckFileExists = true,
            CheckPathExists = true
        };
        var accepted = dialog.ShowDialog() is true;
        var file = accepted ? Path.GetFullPath(dialog.FileName) : string.Empty;
        _approvedAssetFiles.Clear();
        if (accepted) _approvedAssetFiles.Add(NormalizePathKey(file));
        return JsonSerializer.SerializeToElement(new { file, usage });
    }

    private static string ValidateAssetUsage(string usage)
    {
        var platformAvatar = usage.StartsWith("platform_assistant_avatar:", StringComparison.Ordinal)
            ? usage["platform_assistant_avatar:".Length..]
            : string.Empty;
        if (usage is not ("cover" or "project_icon" or "user_avatar" or "assistant_avatar")
            && !IdentityPlatforms.Contains(platformAvatar))
        {
            throw new InvalidOperationException("Cloudig asset picker received an unsupported usage.");
        }
        return usage;
    }

    private async Task<JsonElement> RunServiceAsync(string command, JsonElement request, JsonElement payload)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        if (!_approvedRoots.Contains(NormalizePathKey(root)))
        {
            throw new InvalidOperationException("Cloudig will use only a library selected through this app.");
        }
        if (command == "files.import")
        {
            if (!payload.TryGetProperty("files", out var files) || files.ValueKind is not JsonValueKind.Array)
            {
                throw new InvalidOperationException("Cloudig import requires files selected through this app.");
            }
            foreach (var file in files.EnumerateArray())
            {
                var selected = Path.GetFullPath(file.GetString() ?? string.Empty);
                if (!_approvedImportFiles.Contains(NormalizePathKey(selected)))
                {
                    throw new InvalidOperationException("Cloudig will import only files selected through its file picker.");
                }
            }
        }
        if (command == "asset.import")
        {
            var selected = Path.GetFullPath(RequiredString(payload, "file"));
            if (!_approvedAssetFiles.Contains(NormalizePathKey(selected)))
            {
                throw new InvalidOperationException("Cloudig will import only an image selected through its file picker.");
            }
        }
        if (command == "reader.build")
        {
            var output = OptionalString(payload, "output");
            if (!string.IsNullOrWhiteSpace(output) && !IsWithin(Path.GetFullPath(output), Path.Combine(root, "Exports")))
            {
                throw new InvalidOperationException("Cloudig Reader output must stay inside the current Exports folder.");
            }
        }
        try
        {
            return await _commandHost.RunAsync(request);
        }
        finally
        {
            if (command == "files.import") _approvedImportFiles.Clear();
            if (command == "asset.import") _approvedAssetFiles.Clear();
        }
    }

    private async Task<JsonElement> RecycleConversationsAsync(JsonElement payload)
    {
        var root = Path.GetFullPath(RequiredString(payload, "root"));
        if (!_approvedRoots.Contains(NormalizePathKey(root))
            || !NormalizePathKey(root).Equals(NormalizePathKey(_settings.LibraryRoot), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Cloudig will recycle conversations only from the current selected library.");
        }
        if (!payload.TryGetProperty("relative_paths", out var relativePaths)
            || relativePaths.ValueKind is not JsonValueKind.Array)
        {
            throw new InvalidOperationException("Cloudig recycle requires selected conversation paths.");
        }
        var selected = relativePaths.EnumerateArray()
            .Select(item => item.GetString() ?? string.Empty)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var expectedRevision = payload.TryGetProperty("expected_revision", out var revisionElement)
            && revisionElement.ValueKind is JsonValueKind.String
            ? revisionElement.GetString()
            : null;
        var preparePayload = JsonSerializer.SerializeToElement(new { root, relative_paths = selected, expected_revision = expectedRevision });
        var prepareRequest = JsonSerializer.SerializeToElement(new { command = "archive.recycle.prepare", payload = preparePayload });
        var prepared = await RunServiceAsync("archive.recycle.prepare", prepareRequest, preparePayload);
        if (!prepared.TryGetProperty("files", out var files) || files.ValueKind is not JsonValueKind.Array)
        {
            throw new InvalidOperationException("Cloudig recycle preparation returned no validated files.");
        }
        var conversationsRoot = Path.GetFullPath(Path.Combine(root, "Conversations"));
        var recycled = new List<string>();
        Exception? failure = null;
        foreach (var file in files.EnumerateArray())
        {
            var absolute = Path.GetFullPath(RequiredString(file, "absolute_path"));
            var relative = RequiredString(file, "relative_path");
            if (!IsWithin(absolute, conversationsRoot) || !File.Exists(absolute))
            {
                failure = new InvalidOperationException("A prepared recycle target left the current Conversations folder.");
                break;
            }
            try
            {
                FileSystem.DeleteFile(
                    absolute,
                    UIOption.OnlyErrorDialogs,
                    RecycleOption.SendToRecycleBin,
                    UICancelOption.ThrowException);
                recycled.Add(relative);
            }
            catch (Exception error)
            {
                failure = error;
                break;
            }
        }
        if (recycled.Count > 0)
        {
            var finalizePayload = JsonSerializer.SerializeToElement(new { root, relative_paths = recycled });
            var finalizeRequest = JsonSerializer.SerializeToElement(new { command = "archive.recycle.finalize", payload = finalizePayload });
            var result = await RunServiceAsync("archive.recycle.finalize", finalizeRequest, finalizePayload);
            if (failure is null) return result;
        }
        if (failure is not null) throw new InvalidOperationException($"Cloudig recycled {recycled.Count} file(s) before Windows stopped the operation: {failure.Message}", failure);
        throw new InvalidOperationException("Cloudig did not recycle any conversation files.");
    }

    private JsonElement OpenPath(JsonElement payload, bool directory)
    {
        var candidate = Path.GetFullPath(RequiredString(payload, "path"));
        if (directory)
        {
            if (!Directory.Exists(candidate)) throw new DirectoryNotFoundException("The selected Cloudig folder no longer exists.");
            var allowedDirectories = new[]
            {
                _settings.LibraryRoot,
                Path.Combine(_settings.LibraryRoot, "Inbox"),
                Path.Combine(_settings.LibraryRoot, "Conversations")
            };
            if (!allowedDirectories.Any(path => NormalizePathKey(candidate).Equals(NormalizePathKey(path), StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("Cloudig will open only the current library, Inbox, or Conversations folder.");
            }
        }
        else
        {
            if (!File.Exists(candidate)) throw new FileNotFoundException("The generated Cloudig file no longer exists.");
            var exports = Path.Combine(_settings.LibraryRoot, "Exports");
            if (!IsWithin(candidate, exports)) throw new InvalidOperationException("Cloudig will open only files generated inside the current Exports folder.");
        }
        Process.Start(new ProcessStartInfo(candidate) { UseShellExecute = true });
        return JsonSerializer.SerializeToElement(new { opened = true });
    }

    private async Task<JsonElement> CopyBookmarkSourceAsync(JsonElement payload)
    {
        var bookmarkId = RequiredString(payload, "bookmark_id");
        var requestedProfile = RequiredString(payload, "requested_profile");
        var source = await _bookmarkManager.ReadSourceAsync(bookmarkId, requestedProfile);
        Clipboard.SetText(source, TextDataFormat.UnicodeText);
        return JsonSerializer.SerializeToElement(new
        {
            copied = true,
            bookmark_id = bookmarkId,
            requested_profile = requestedProfile
        });
    }

    private void PostOperationEvent(string id, JsonElement value)
    {
        if (WebView.CoreWebView2 is null || string.IsNullOrWhiteSpace(id)) return;
        WebView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, @event = value }));
    }

    private void PostResponse(string id, bool ok, JsonElement? result, Exception? error)
    {
        if (WebView.CoreWebView2 is null || string.IsNullOrWhiteSpace(id)) return;
        var response = ok
            ? JsonSerializer.Serialize(new { id, ok = true, result })
            : JsonSerializer.Serialize(new
            {
                id,
                ok = false,
                error = new
                {
                    code = error is ManagerCommandException commandError ? commandError.Code : "native_command_failed",
                    kind = error is ManagerCommandException typedError ? typedError.Kind : string.Empty,
                    retryable = error is ManagerCommandException retryableError && retryableError.Retryable,
                    message = error is null ? "Cloudig encountered an unknown local error." : SafeMessage(error)
                }
            });
        WebView.CoreWebView2.PostWebMessageAsJson(response);
    }

    private static bool IsManagerPage(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
               && uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
               && uri.Host.Equals("cloudig.local", StringComparison.OrdinalIgnoreCase)
               && uri.Port == 443
               && (uri.AbsolutePath.Equals("/", StringComparison.Ordinal) || uri.AbsolutePath.Equals("/index.html", StringComparison.Ordinal));
    }

    private static bool IsReaderPage(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
        && uri.Host.Equals("reader.cloudig.local", StringComparison.OrdinalIgnoreCase)
        && uri.Port == 443
        && uri.AbsolutePath.Equals(ReaderPagePath, StringComparison.Ordinal);

    private static bool IsExternalHttpUri(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && (uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
            || uri.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase));

    private static void OpenExternalUri(string value)
    {
        try
        {
            Process.Start(new ProcessStartInfo(value) { UseShellExecute = true });
        }
        catch
        {
            // A user-clicked external link is optional; Reader data remains available offline.
        }
    }

    private static string ExistingLibraryRoot(string value) =>
        !string.IsNullOrWhiteSpace(value) && File.Exists(Path.Combine(value, "cloudig-library.json")) ? value : string.Empty;

    private static string DefaultLibraryRoot() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Cloudig");

    private static string NormalizePathKey(string value) =>
        Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool IsWithin(string candidate, string parent)
    {
        var normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return candidate.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase);
    }

    private static string RequiredString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind is not JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidOperationException($"Cloudig command requires {property}.");
        }
        return value.GetString()!;
    }

    private static string OptionalString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind is JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;

    private static JsonElement RequiredObject(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind is not JsonValueKind.Object)
        {
            throw new InvalidOperationException($"Cloudig command requires object {property}.");
        }
        return value;
    }

    private static long RequiredInt64(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || !value.TryGetInt64(out var number) || number < 0)
        {
            throw new InvalidOperationException($"Cloudig command requires non-negative integer {property}.");
        }
        return number;
    }

    private static bool RequiredBoolean(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new InvalidOperationException($"Cloudig command requires boolean {property}.");
        }
        return value.GetBoolean();
    }

    private static int RequiredInt32(JsonElement element, string property)
    {
        var number = RequiredInt64(element, property);
        if (number > int.MaxValue) throw new InvalidOperationException($"Cloudig command {property} is too large.");
        return (int)number;
    }

    private static string[] RequiredStringArray(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var values) || values.ValueKind is not JsonValueKind.Array)
        {
            throw new InvalidOperationException($"Cloudig command requires array {property}.");
        }
        return values.EnumerateArray().Select(value => value.ValueKind is JsonValueKind.String
                ? value.GetString() ?? string.Empty
                : throw new InvalidOperationException($"Cloudig command {property} must contain strings."))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();
    }

    private static string SafeMessage(Exception error) =>
        error.Message.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault()
        ?? "Cloudig encountered an unknown local error.";

    private void ShowStartupFailure(Exception error)
    {
        WebView.Visibility = Visibility.Collapsed;
        StartupFailure.Visibility = Visibility.Visible;
        StartupFailureMessage.Text = $"{SafeMessage(error)}\n\n请确认 WebView2 Runtime 与采云文件完整后重试。";
    }
}
