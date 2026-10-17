import Foundation

/// Which posts are pinned in the WHOLE forum while a filter hides some of them.
///
/// A filtered list cannot say how many pinned posts there are (a Bug filter
/// hides the rules post), so a post's menu and the pin cap need the forum-wide
/// set. It is read from the server and then kept current from the same
/// frames the list already handles: a forum-post upsert carries the post's pin
/// state, so a remote pin or unpin (of a post the filter hides too) moves the
/// set by itself, and an upsert that changes nothing costs nothing.
///
/// THE GENERATION makes a count a thing that can be out of date. Every read
/// and every change to the set bumps it; a read that comes back for an older
/// number is dropped, and a count handed out as authority for a pin carries
/// the number it was read under, so the write can check it still holds.
struct ForumPinnedTracker: Equatable {
    /// Nil: not known (never read, or being read).
    private(set) var ids: Set<String>?
    private(set) var generation = 0

    var count: Int? { ids?.count }

    /// A count together with the generation it was read under.
    struct Reading: Equatable {
        let count: Int
        let generation: Int
    }

    /// A read starts. `quiet` keeps the known set on screen while it is in
    /// flight; otherwise the count is unknown until the answer lands.
    mutating func beginRead(quiet: Bool) -> Int {
        generation += 1
        if !quiet { ids = nil }
        return generation
    }

    /// A read answers (`pinned` nil: it failed). Nil comes back when the answer
    /// is superseded or failed, which is never an authority for anything.
    mutating func finishRead(_ pinned: [String]?, generation read: Int) -> Reading? {
        guard read == generation, let pinned else { return nil }
        ids = Set(pinned)
        return Reading(count: ids?.count ?? 0, generation: read)
    }

    /// A frame about one post says whether it is pinned. True when that moved
    /// the set (and so superseded any read in flight).
    @discardableResult
    mutating func observe(postId: String, isPinned: Bool) -> Bool {
        guard var known = ids, known.contains(postId) != isPinned else { return false }
        if isPinned { known.insert(postId) } else { known.remove(postId) }
        ids = known
        generation += 1
        return true
    }

    /// A post is gone.
    @discardableResult
    mutating func forget(postId: String) -> Bool {
        observe(postId: postId, isPinned: false)
    }

    /// Whether a count read earlier still describes the forum.
    func isCurrent(_ reading: Reading) -> Bool { reading.generation == generation }
}
