namespace Cloudig.Bookmarks;

public interface IBookmarkMutator
{
    BookmarkMutation Mutate(string originalJson, BookmarkOperation operation, DateTime utcNow);
}
