namespace Cloudig.Desktop.Core;

public enum PortableMoveChoice { Continue, Cancel, Defer }
public sealed record PortableMovePrompt(PortableMoveRequest Request, PortableMoveResult? PreviousResult, bool CanCancel);
public sealed record PortableMoveStartupOutcome(bool OpenLibrary, PortableMoveResult? Result = null);

public static class PortableMoveStartup
{
    public static async Task<PortableMoveStartupOutcome> ResolveAsync(string root,
        Func<PortableMovePrompt, Task<PortableMoveChoice>> choose,
        Action<PreparedPortableMove> launch,
        string? completeOperation = null, string? completeHash = null,
        CancellationToken cancellationToken = default)
    {
        if (!PortableLibraryMove.IsPending(root))
        {
            if (completeOperation is not null && (await PortableLibraryMove.ReadResultAsync(root, cancellationToken))?.Operation != completeOperation) throw new IOException("The requested move is not present at this location.");
            return new PortableMoveStartupOutcome(true);
        }
        var request = await PortableLibraryMove.ReadAsync(PortableLibraryMove.RequestPath(root), cancellationToken);
        if (completeOperation is not null)
            return new PortableMoveStartupOutcome(true, await PortableLibraryMove.CompleteAsync(root, completeOperation, completeHash ?? string.Empty, cancellationToken));
        if (!PortableLibraryMove.OwnerExited(request)) throw new IOException("Another Cloudig process is still handling this move. Close this duplicate launch and wait for it to finish.");
        var isSource = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).Equals(request.SourceRoot, StringComparison.OrdinalIgnoreCase);
        var isTarget = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).Equals(request.TargetRoot, StringComparison.OrdinalIgnoreCase);
        if (!isSource && !isTarget) throw new IOException("This pending move belongs to different device paths. Its records were preserved; no folder was changed.");
        var choice = await choose(new PortableMovePrompt(request, await PortableLibraryMove.ReadResultAsync(root, cancellationToken), isSource));
        if (choice == PortableMoveChoice.Defer) return new PortableMoveStartupOutcome(false);
        if (choice == PortableMoveChoice.Cancel)
        {
            if (!isSource) throw new IOException("A transferred destination cannot be cancelled as though it were the original folder.");
            return new PortableMoveStartupOutcome(true, await PortableLibraryMove.CancelFromSourceAsync(root, request.Operation, cancellationToken));
        }
        if (isTarget)
            return new PortableMoveStartupOutcome(true, await PortableLibraryMove.CompleteAsync(root, request.Operation, await PortableLibraryMove.RequestHashAsync(root, cancellationToken), cancellationToken));
        launch(await PortableLibraryMove.ResumeFromSourceAsync(root, request.Operation, cancellationToken));
        return new PortableMoveStartupOutcome(false);
    }
}
