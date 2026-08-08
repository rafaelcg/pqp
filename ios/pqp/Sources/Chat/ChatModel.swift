import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class ChatModel {
    private(set) var messages: [Message] = []
    private(set) var isLoading = false
    private(set) var isSending = false
    private(set) var hasMore = false
    private(set) var typingNames: [String: Date] = [:]
    var draft = ""
    var error: String?

    /// The message being replied to, shown above the composer until cleared.
    var replyingTo: Message?
    /// A timeout notice addressed to us, shown above the composer for this
    /// channel. The server's `message` field is the whole sentence — rendering
    /// it verbatim is the contract.
    var sanction: SanctionNotice?
    /// The message being edited. Mutually exclusive with `replyingTo` — the
    /// composer can only be doing one job at a time.
    var editing: Message?

    /// Files staged in the composer, not yet sent.
    private(set) var pendingAttachments: [PendingAttachment] = []
    private(set) var attachmentsEnabled = false
    private(set) var gifsEnabled = false
    private var uploader: AttachmentUploader?

    /// Quick reactions offered on long-press. Kept short: a picker with
    /// everything is a different feature, and six covers the common cases.
    static let quickReactions = ["👍", "😂", "🔥", "❤️", "🎉", "👀"]

    /// The scroll view reports this; the model only uses it to decide whether
    /// a new message should pull the view down.
    var isNearBottom = true

    private var session: SessionStore?
    private var channelId: String?
    private var handlerKey = UUID().uuidString
    private var lastTypingSentAt: Date?
    private var typingSweeper: Task<Void, Never>?

    var typingDescription: String {
        let names = typingNames.keys.sorted()
        switch names.count {
        case 0: return ""
        case 1: return String(localized: "\(names[0]) is typing")
        case 2: return String(localized: "\(names[0]) and \(names[1]) are typing")
        default: return String(localized: "Several people are typing")
        }
    }

    func isGrouped(at index: Int) -> Bool {
        guard index > 0, index < messages.count else { return false }
        let current = messages[index]
        let previous = messages[index - 1]
        guard current.authorId == previous.authorId, !current.isWebhook, !previous.isWebhook else {
            return false
        }
        // Same person, but a long pause restarts the block — otherwise a reply
        // hours later reads as part of the earlier burst.
        return current.createdAt.timeIntervalSince(previous.createdAt) < 300
    }

    /// Cache first, then network.
    ///
    /// The old shape of this method is what the owner was complaining about:
    /// it joined the socket, then asked for the attachment config, then the GIF
    /// config, and only then — three round trips deep — asked for the messages,
    /// showing a spinner for the whole of it. Every visit to every channel,
    /// including one you left ten seconds ago.
    ///
    /// Now the last page is read off disk and drawn before anything network-
    /// bound starts, and there is no spinner at all when there is something to
    /// draw. The join, the two configs (memoised in `APIClient`, so usually
    /// free) and the refetch then run concurrently instead of in single file.
    func open(channelId: String, session: SessionStore) async {
        self.session = session
        self.channelId = channelId

        // Registered before the fetch, so a message that lands mid-flight is
        // applied rather than lost; `reconcile` carries it across the swap.
        session.eventHandlers[handlerKey] = { [weak self] event in
            self?.apply(event)
        }
        uploader = AttachmentUploader(api: session.api)

        if let cached = await session.api.cachedMessages(channelId: channelId) {
            messages = cached.messages
            hasMore = cached.hasMore
        }
        // The spinner is the disruption being complained about. It stays only
        // for a channel this device has genuinely never opened.
        isLoading = messages.isEmpty
        startTypingSweeper()

        async let joined: Void = session.realtime.join(channelId: channelId)
        // Attachments are off entirely unless the deployment configured
        // storage, so the button is hidden rather than failing on tap.
        async let attachments = (try? await session.api.attachmentConfig())?.enabled ?? false
        async let gifs = (try? await session.api.gifConfig())?.enabled ?? false
        async let fetched: MessagesResponse = session.api.messages(channelId: channelId)

        await joined
        do {
            reconcile(try await fetched)
            // Clearing on open is what makes the badge disappear when you
            // actually read something, rather than on some timer.
            try? await session.api.markRead(channelId: channelId)
        } catch {
            // With a cached page already on screen this is a note, not a blank
            // screen — but it is still said out loud rather than swallowed.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        attachmentsEnabled = await attachments
        gifsEnabled = await gifs
        isLoading = false
    }

    /// Swaps a freshly fetched page in over whatever is on screen.
    ///
    /// Two things it has to get right. Identity: message ids are stable and the
    /// list is keyed on them, so an unchanged page must produce an *equal*
    /// array — assigning a re-decoded but identical page is a no-op for
    /// SwiftUI's diff, and skipping the assignment entirely when nothing moved
    /// keeps the scroll position untouched. And anything the socket delivered
    /// while the page was in flight (or an optimistic row we drew ourselves)
    /// has to survive the swap, or a message sent during the open would vanish.
    private func reconcile(_ page: MessagesResponse) {
        // Narrowed to this channel first: `open` is the one entry point a
        // reused model can be handed a *different* channel through, and
        // carrying rows across that would put one channel's messages under
        // another's name.
        let local = messages.filter { $0.channelId == channelId }
        let known = Set(page.messages.map(\.id))
        let carried: [Message]
        if let newest = page.messages.last?.createdAt {
            carried = local.filter {
                !known.contains($0.id) && ($0.isPending || $0.createdAt > newest)
            }
        } else {
            // An empty page still cannot swallow what arrived while it was in
            // flight. A thread is opened *in order to say something*, so the
            // first send routinely races the very first history fetch — and by
            // the time the (empty) page lands, the broadcast may already have
            // confirmed the message, which makes `isPending` alone too narrow:
            // the server HAD the message and assigning the page erased it.
            carried = local.filter { !known.contains($0.id) }
        }
        let merged = page.messages + carried
        if merged != messages {
            messages = merged
        }
        hasMore = page.hasMore
    }

    /// A fetched page plus whatever the page does not already account for.
    ///
    /// Anything still local when a page lands arrived *after* that page was
    /// requested, so it belongs at the end. Deduplicating by id is what stops
    /// the two sources contributing the same message twice — `ForEach(id: \.id)`
    /// cannot render two rows sharing an identity — and an optimistic row can
    /// never collide, because its id is local (`pending-…`) until the nonce echo
    /// swaps it for the server's copy.
    static func merge(page: [Message], with local: [Message]) -> [Message] {
        guard !local.isEmpty else { return page }
        let stored = Set(page.map(\.id))
        return page + local.filter { !stored.contains($0.id) }
    }

    func close() {
        session?.eventHandlers.removeValue(forKey: handlerKey)
        typingSweeper?.cancel()
        typingSweeper = nil
    }

    func loadEarlier() async {
        guard let session, let channelId, let oldest = messages.first else { return }
        do {
            // The cursor is the oldest message's *id*, not its timestamp.
            let page = try await session.api.messages(channelId: channelId, before: oldest.id)
            messages.insert(contentsOf: page.messages, at: 0)
            hasMore = page.hasMore
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func attach(_ image: UIImage) {
        guard let pending = PendingAttachment.fromImage(image) else { return }
        pendingAttachments.append(pending)
    }

    /// GIFs skip the upload dance entirely — the server fetches the bytes from
    /// the provider itself, so this posts immediately rather than staging.
    func sendGif(_ gif: Gif) async {
        guard let session, let channelId, let user = session.currentUser else { return }
        isSending = true
        do {
            let attachmentId = try await session.api.attachGif(channelId: channelId, gif: gif)
            var pending = Message(pendingBody: "", channelId: channelId, author: user)
            let nonce = await session.realtime.sendMessage(
                channelId: channelId, body: "", attachmentIds: [attachmentId]
            )
            pending.pendingNonce = nonce
            messages.append(pending)
            isNearBottom = true
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isSending = false
    }

    func removeAttachment(_ id: UUID) {
        pendingAttachments.removeAll { $0.id == id }
    }

    func send() async {
        guard let session, let channelId, let user = session.currentUser else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // The server accepts an empty body when there are attachments, so a
        // photo with no caption is a valid message.
        guard !body.isEmpty || !pendingAttachments.isEmpty else { return }

        // An in-flight edit takes precedence: the composer is showing that
        // message's text, so sending must save it rather than post a duplicate.
        if let editing {
            await commitEdit(editing, newBody: body)
            return
        }

        let replyId = replyingTo?.id
        let staged = pendingAttachments
        draft = ""
        replyingTo = nil
        pendingAttachments = []
        isSending = true

        // Uploaded before the message is sent, because the ids have to ride on
        // `message-create` — there is no way to attach to a message after the
        // fact.
        var attachmentIds: [String] = []
        for item in staged {
            do {
                if let uploader {
                    attachmentIds.append(try await uploader.upload(item, channelId: channelId))
                }
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
                // Put the text back so the message is not silently lost.
                draft = body
                isSending = false
                return
            }
        }

        // Optimistic echo. The protocol has no ack, so the nonce coming back on
        // `message-broadcast` is what retires this row.
        var pending = Message(pendingBody: body, channelId: channelId, author: user)
        let nonce = await session.realtime.sendMessage(
            channelId: channelId, body: body, replyToId: replyId, attachmentIds: attachmentIds
        )
        pending.pendingNonce = nonce
        messages.append(pending)
        isNearBottom = true
        isSending = false
    }

    // MARK: - Message actions

    func beginReply(to message: Message) {
        editing = nil
        draft = ""
        replyingTo = message
    }

    func beginEdit(_ message: Message) {
        replyingTo = nil
        editing = message
        draft = message.body
    }

    func cancelComposerContext() {
        replyingTo = nil
        editing = nil
        draft = ""
    }

    private func commitEdit(_ message: Message, newBody: String) async {
        guard let session else { return }
        editing = nil
        draft = ""
        isSending = true
        do {
            let updated = try await session.api.editMessage(id: message.id, body: newBody)
            // The broadcast will also arrive; applying it here means the change
            // is visible immediately rather than after a round trip.
            if let index = messages.firstIndex(where: { $0.id == updated.id }) {
                messages[index] = updated
            }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isSending = false
    }

    func delete(_ message: Message) async {
        guard let session else { return }
        // Removed locally first; the broadcast confirms it for everyone else.
        let previous = messages
        messages.removeAll { $0.id == message.id }
        do {
            try await session.api.deleteMessage(id: message.id)
        } catch {
            // Put it back rather than leaving a gap that looks like it worked.
            messages = previous
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func toggleReaction(_ emoji: String, on message: Message) async {
        guard let session, let channelId else { return }
        // Applied locally straight away; `reaction-broadcast` is a delta and
        // will echo this back, so the local edit is skipped for our own id.
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            var reactions = messages[index].reactions
            if let existing = reactions.firstIndex(where: { $0.emoji == emoji }) {
                if reactions[existing].me {
                    reactions[existing].count -= 1
                    reactions[existing].me = false
                    if reactions[existing].count <= 0 { reactions.remove(at: existing) }
                } else {
                    reactions[existing].count += 1
                    reactions[existing].me = true
                }
            } else {
                reactions.append(MessageReaction(emoji: emoji, count: 1, me: true))
            }
            messages[index].reactions = reactions
        }
        await session.realtime.toggleReaction(
            channelId: channelId, messageId: message.id, emoji: emoji
        )
    }

    func togglePin(_ message: Message) async {
        guard let session else { return }
        do {
            let updated = try await session.api.setPinned(
                messageId: message.id, pinned: message.pinnedAt == nil
            )
            if let index = messages.firstIndex(where: { $0.id == updated.id }) {
                messages[index] = updated
            }
        } catch {
            // Includes the per-channel pin limit, which the server answers with
            // a 409 and its own wording.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Start a thread on a message, or get back the one it already has — the
    /// server is idempotent here, so tapping twice cannot make two threads.
    ///
    /// The chip is written onto the local row immediately: the `thread-update`
    /// broadcast goes to the parent channel's viewers, and we are one, but the
    /// person who tapped should not watch a round trip to learn it worked.
    /// Returns the thread so the caller can push straight into it.
    func startThread(on message: Message) async -> ThreadSummary? {
        guard let session else { return nil }
        do {
            let thread = try await session.api.createThread(messageId: message.id)
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index].thread = thread
            }
            return thread
        } catch {
            // 400 here is the server refusing the *target*: a DM (already the
            // scoped side-conversation threads exist to create) or a message
            // inside a thread (they do not nest). Its wording says which.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    func isMine(_ message: Message) -> Bool {
        message.authorId == session?.currentUser?.id
    }

    func noteTyping() {
        guard let session, let channelId, !draft.isEmpty else { return }
        // The server rate-limits typing to ~1/s and silently drops the rest, so
        // there is no point sending one per keystroke.
        let now = Date()
        if let last = lastTypingSentAt, now.timeIntervalSince(last) < 2 { return }
        lastTypingSentAt = now
        Task { await session.realtime.sendTyping(channelId: channelId) }
    }

    // MARK: - Realtime

    private func apply(_ event: RealtimeEvent) {
        switch event {
        case .messageCreated(let message, let nonce):
            guard message.channelId == channelId else { return }
            // Replace our optimistic row if this is the echo of it; the server
            // copy has the real id, timestamp and any resolved embeds. If a
            // history page already delivered that copy, the optimistic row is
            // dropped instead of overwritten — otherwise the swap would put two
            // rows with the same id in the list.
            if let nonce, let index = messages.firstIndex(where: { $0.pendingNonce == nonce }) {
                if messages.contains(where: { $0.id == message.id }) {
                    messages.remove(at: index)
                } else {
                    messages[index] = message
                }
            } else if !messages.contains(where: { $0.id == message.id }) {
                messages.append(message)
            }

        case .messageUpdated(let message):
            guard message.channelId == channelId else { return }
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index] = message
            }

        case .messageDeleted(let deletedChannelId, let messageId):
            guard deletedChannelId == channelId else { return }
            messages.removeAll { $0.id == messageId }

        case .reaction(let reactionChannelId, let messageId, let emoji, let userId, let added):
            guard reactionChannelId == channelId,
                  let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
            // Our own toggle was already applied optimistically; applying the
            // echo too would double-count it.
            if userId == session?.currentUser?.id { return }
            // A delta, not a count — apply it rather than replacing.
            var reactions = messages[index].reactions
            if let existing = reactions.firstIndex(where: { $0.emoji == emoji }) {
                reactions[existing].count += added ? 1 : -1
                if reactions[existing].count <= 0 {
                    reactions.remove(at: existing)
                }
            } else if added {
                reactions.append(MessageReaction(emoji: emoji, count: 1, me: false))
            }
            messages[index].reactions = reactions

        case .typing(let typingChannelId, _, let displayName):
            guard typingChannelId == channelId else { return }
            typingNames[displayName] = Date()

        case .threadUpdate(let parentChannelId, let messageId, let thread):
            // The chip on the origin message, live. `channelId` on this frame
            // is the PARENT — a thread's own messages never travel here, so
            // this is only ever a count and a timestamp moving.
            guard parentChannelId == channelId,
                  let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
            messages[index].thread = thread

        case .sanctionNotice(let notice):
            // Attached to the composer the person is actually looking at; a
            // notice for some other channel would read as a non sequitur.
            guard notice.channelId == channelId else { return }
            sanction = notice
            // The optimistic rows this notice answers will never be confirmed.
            messages.removeAll { $0.isPending }

        case .ready:
            // The socket came back after a gap. Whatever was said while it was
            // down was never delivered here, so the visible page is refetched
            // rather than trusted.
            Task { await reloadAfterReconnect() }

        // Voice frames arrive on the same socket and are none of this
        // model's business.
        case .presence, .activity, .other,
             .voiceWelcome, .voicePeerJoined, .voicePeerLeft, .voiceRoster,
             .voiceRoomFull, .voiceTransportUnsupported, .voiceScreenShareDenied,
             .voiceOffer, .voiceAnswer, .voiceCandidate,
             // Ringing is `CallModel`'s, and deliberately not this model's: a
             // call outlives the thread it was placed from.
             .callIncoming, .callRingCancelled, .callDeclined:
            break
        }
    }

    private func reloadAfterReconnect() async {
        guard let session, let channelId else { return }
        guard let page = try? await session.api.messages(channelId: channelId) else { return }
        // There is no offline send queue: a frame sent into a dead socket was
        // dropped. A very recent optimistic row may still get its echo (the
        // send may have raced the drop), but anything older is gone and keeping
        // it dimmed forever would claim otherwise.
        let cutoff = Date().addingTimeInterval(-10)
        let pending = messages.filter { $0.isPending && $0.createdAt > cutoff }
        let lost = messages.contains { $0.isPending && $0.createdAt <= cutoff }
        messages = ChatModel.merge(page: page.messages, with: pending)
        hasMore = page.hasMore
        if lost {
            error = String(localized: "The connection dropped and some messages were not sent.")
        }
    }

    /// There is no "stopped typing" frame, so indicators have to expire locally.
    private func startTypingSweeper() {
        typingSweeper?.cancel()
        typingSweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                let cutoff = Date().addingTimeInterval(-4)
                self.typingNames = self.typingNames.filter { $0.value > cutoff }
            }
        }
    }
}
