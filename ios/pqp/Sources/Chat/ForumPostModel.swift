import Foundation
import Observation
import UIKit

/// A forum post on screen: the parts a chat does not have (title, tags,
/// status, the accepted answer) and the moderation on them. The transcript
/// itself is the ordinary `ChatModel` keyed by the post id.
///
/// Every edit is optimistic and rolled back with "Não deu pra salvar" on a
/// refusal (UX §3.2); the server is still the gate for each field.
@MainActor
@Observable
final class ForumPostModel {
    let postId: String
    let forumId: String
    let forumName: String
    let serverId: String

    private(set) var post: ForumPostSummary?
    private(set) var viewer: ForumPostViewer?
    private(set) var acceptedAnswer: ForumAcceptedAnswer?
    private(set) var participantCount = 0
    /// The read cursor from BEFORE this visit, captured before the chat marks
    /// the post read. Nil: a first visit, which opens on the question.
    private(set) var previousReadAt: Date?
    /// Deleted while open: the screen says so instead of closing on its own.
    private(set) var isRemoved = false
    private(set) var tags: [ForumTag] = []
    private(set) var permissions: PermissionsSnapshot?
    /// What went wrong with the last edit, said once above the composer.
    var notice: String?

    @ObservationIgnored weak var home: ForumHomeModel?
    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private let handlerKey = "forum-post-\(UUID().uuidString)"

    init(
        postId: String,
        forumId: String,
        forumName: String,
        serverId: String,
        initialPost: ForumPostSummary? = nil,
        initialViewer: ForumPostViewer? = nil,
        home: ForumHomeModel? = nil
    ) {
        self.postId = postId
        self.forumId = forumId
        self.forumName = forumName
        self.serverId = serverId
        self.post = initialPost
        self.viewer = initialViewer
        self.previousReadAt = initialViewer?.lastReadAt
        self.home = home
        if let home {
            tags = home.tags
            permissions = home.permissions
        }
    }

    // MARK: - Who is looking

    var viewerId: String? { session?.currentUser?.id }

    var isAuthor: Bool {
        guard let viewerId, let authorId = post?.authorId else { return false }
        return viewerId == authorId
    }

    var isStaff: Bool {
        if let home { return home.isStaff }
        guard let permissions else { return false }
        return permissions.can(PermissionBit.manageMessages, channelId: forumId)
            || permissions.can(PermissionBit.manageChannels, channelId: forumId)
    }

    /// Title, tags, resolve and the answer are the author's or staff's.
    var canEdit: Bool { isAuthor || isStaff }

    var isLocked: Bool { post?.isLocked ?? false }

    /// A closed post takes replies from staff only.
    var canReply: Bool { !isLocked || isStaff }

    var postTags: [ForumTag] {
        guard let post else { return [] }
        return post.tagIds.compactMap { id in tags.first { $0.id == id } }
    }

    /// Tags this person may put on or take off: staff-only ones are staff's.
    var editableTags: [ForumTag] { isStaff ? tags : tags.filter { !$0.moderated } }

    var pinnedCount: Int { home?.pinnedCount ?? 0 }

    var link: URL? {
        URL(string: "https://pqp.gg/app/server/\(serverId)/channel/\(forumId)/post/\(postId)")
    }

    // MARK: - Lifecycle

    /// Whether the screen can mount the transcript yet. A post opened from the
    /// list already knows its cursor; a deep link has to ask first, or the
    /// chat would mark the post read before the cursor was read.
    var isReadyToOpen: Bool { viewer != nil || isRemoved }

    /// Joins nothing: the forum's frames reach this through the primary slot
    /// the forum list holds (or, for a deep link, the join below), and the
    /// transcript's through `ChatModel`'s thread slot.
    func start(session: SessionStore) async {
        self.session = session
        let key = handlerKey
        session.eventHandlers[key] = { [weak self, weak session] event in
            guard let self else {
                session?.eventHandlers.removeValue(forKey: key)
                return
            }
            self.apply(event)
        }
        if home == nil {
            // Opened from a link with no list underneath: take the forum's
            // slot so a close or a resolve still arrives while reading.
            await session.realtime.join(channelId: forumId)
        }
        let needsTags = tags.isEmpty
        let needsPermissions = home == nil && permissions == nil
        let api = session.api
        let forumId = forumId
        let serverId = serverId
        async let detailAnswer = try? api.forumPost(id: postId)
        async let tagsAnswer: [ForumTag]? = needsTags ? try? api.forumTags(forumId: forumId) : nil
        async let permissionsAnswer: PermissionsSnapshot? = needsPermissions
            ? try? api.fetchMemberPermissions(serverId: serverId) : nil
        if let detail = await detailAnswer {
            if viewer == nil {
                // First answer for a deep link: this IS the cursor before the visit.
                previousReadAt = detail.viewer.lastReadAt
            }
            apply(detail: detail)
        } else if viewer == nil {
            // The post is gone or not ours to see; say so rather than spin.
            isRemoved = true
        }
        if let tags = await tagsAnswer { self.tags = tags }
        if let permissions = await permissionsAnswer { self.permissions = permissions }
    }

    func stop() {
        session?.eventHandlers.removeValue(forKey: handlerKey)
    }

    private func apply(detail: ForumPostDetail) {
        post = detail.post
        viewer = detail.viewer
        acceptedAnswer = detail.acceptedAnswer
        participantCount = detail.participantCount
    }

    private func refreshDetail() async {
        guard let session, let detail = try? await session.api.forumPost(id: postId) else { return }
        // The viewer half of a re-read is after this visit marked the post
        // read; keep the cursor this visit opened with.
        let opened = previousReadAt
        apply(detail: detail)
        previousReadAt = opened
    }

    func apply(_ event: RealtimeEvent) {
        switch event {
        case .forumPostUpsert(_, let fresh) where fresh.id == postId:
            let answerMoved = fresh.acceptedAnswerId != post?.acceptedAnswerId
            post = fresh
            if answerMoved {
                if fresh.acceptedAnswerId == nil {
                    acceptedAnswer = nil
                } else {
                    Task { await refreshDetail() }
                }
            }
        case .forumPostRemoved(_, let removedId) where removedId == postId:
            isRemoved = true
        case .messageDeleted(let channelId, let messageId)
            where channelId == postId && messageId == post?.acceptedAnswerId:
            // The answer was deleted: the card says so, the post stays resolved.
            Task { await refreshDetail() }
        default:
            break
        }
    }

    // MARK: - Landing

    /// Pages back until the landing point is loaded, then says where it is.
    func land(chat: ChatModel) async -> ForumLanding.Target {
        var pages = 0
        while pages < ForumLanding.maxPages,
              ForumLanding.needsOlder(
                hasMore: chat.hasMore,
                oldest: chat.messages.first?.createdAt,
                previousReadAt: previousReadAt
              ) {
            let before = chat.messages.count
            await chat.loadEarlier()
            pages += 1
            if chat.messages.count == before { break }
        }
        home?.markOpened(postId: postId)
        return ForumLanding.target(messages: chat.messages, previousReadAt: previousReadAt, viewerId: viewerId)
    }

    // MARK: - Edits

    private func save(
        optimistic: (inout ForumPostSummary) -> Void,
        patch: APIClient.ForumPostPatch,
        failure: String? = nil
    ) async {
        guard let session, var draft = post else { return }
        let before = post
        let answerBefore = acceptedAnswer
        optimistic(&draft)
        post = draft
        if draft.acceptedAnswerId == nil { acceptedAnswer = nil }
        home?.replaced(draft)
        do {
            let saved = try await session.api.updateForumPost(id: postId, patch: patch)
            post = saved
            home?.replaced(saved)
        } catch {
            post = before
            acceptedAnswer = answerBefore
            if let before { home?.replaced(before) }
            notice = failure ?? Self.copy(for: error)
            Haptics.selection()
        }
    }

    static func copy(for error: Error) -> String {
        if case APIError.server(_, let message) = error {
            switch message {
            case ForumErrorCode.pinLimit:
                return String(localized: "\(ForumLimits.maxPinned) posts are already pinned. Unpin one first.")
            case ForumErrorCode.tagModerated:
                return String(localized: "Only staff can add this tag.")
            case ForumErrorCode.tagRequired:
                return String(localized: "Pick at least one tag.")
            default:
                break
            }
        }
        return String(localized: "Couldn't save. Try again.")
    }

    func setResolved(_ resolved: Bool) async {
        await save(
            optimistic: { post in
                post.resolvedAt = resolved ? Date() : nil
                if !resolved { post.acceptedAnswerId = nil }
            },
            patch: .init(resolved: resolved)
        )
    }

    /// "Marcar como solução": the reply becomes the answer, the post resolved.
    func markAnswer(_ message: Message) async {
        acceptedAnswer = ForumAcceptedAnswer(
            messageId: message.id, deleted: false, authorId: message.authorId,
            authorName: message.authorName, excerpt: message.body, createdAt: message.createdAt
        )
        let provisional = acceptedAnswer
        await save(
            optimistic: { post in
                post.acceptedAnswerId = message.id
                if post.resolvedAt == nil { post.resolvedAt = Date() }
            },
            patch: .init(acceptedAnswer: .set(message.id))
        )
        if post?.acceptedAnswerId == message.id {
            acceptedAnswer = provisional
            await refreshDetail()
        }
    }

    /// "Tirar a solução": the answer goes, the post stays resolved.
    func clearAnswer() async {
        await save(
            optimistic: { post in post.acceptedAnswerId = nil },
            patch: .init(acceptedAnswer: .clear)
        )
    }

    func setPinned(_ pinned: Bool) async {
        if pinned, home != nil, pinnedCount >= ForumLimits.maxPinned {
            notice = String(localized: "\(ForumLimits.maxPinned) posts are already pinned. Unpin one first.")
            return
        }
        await save(optimistic: { $0.pinnedAt = pinned ? Date() : nil }, patch: .init(pinned: pinned))
    }

    func setLocked(_ locked: Bool) async {
        await save(optimistic: { $0.lockedAt = locked ? Date() : nil }, patch: .init(locked: locked))
    }

    func retitle(_ title: String) async {
        let clean = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !clean.isEmpty, clean != post?.title else { return }
        let capped = String(clean.prefix(ForumLimits.titleMax))
        await save(optimistic: { $0.title = capped }, patch: .init(title: capped))
    }

    func retag(_ tagIds: [String]) async {
        guard tagIds != post?.tagIds else { return }
        let ordered = tags.map(\.id).filter { tagIds.contains($0) }
        await save(optimistic: { $0.tagIds = ordered }, patch: .init(tagIds: ordered))
    }

    func toggleFollow() async {
        guard let session, var current = viewer else { return }
        let next = !current.following
        current.following = next
        viewer = current
        do {
            viewer = try await session.api.followForumPost(id: postId, following: next)
        } catch {
            current.following = !next
            viewer = current
            notice = String(localized: "Couldn't save. Try again.")
        }
    }

    /// Staff only. True when the post is gone.
    func delete() async -> Bool {
        guard let session else { return false }
        do {
            try await session.api.deleteForumPost(id: postId)
            home?.removed(postId: postId)
            return true
        } catch {
            notice = Self.copy(for: error)
            return false
        }
    }

    func copyLink() {
        guard let link else { return }
        UIPasteboard.general.url = link
    }
}
