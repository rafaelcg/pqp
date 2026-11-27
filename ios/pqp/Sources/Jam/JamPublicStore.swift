import Foundation
import Observation

/// What is waiting for this account on public jams, held once for the whole
/// app: the starter's inbox of outside takes, and the durable take notices.
/// The twin of `client/src/lib/jam-public-store.ts`, and like it the DURABLE
/// state is in two server reads (`/inbox`, `/notices`), so a live frame is only a
/// nudge to read again and a lost one costs nothing the next read does not fix.
///
/// OFF MEANS INVISIBLE. `GET /api/jam-public/config` says whether public jam is
/// on; off (or an API that predates it) every list here is empty and nothing
/// else is asked. `jam_take_notices` is the server's to state: with it off
/// `/notices` answers an empty list and no `jam-take-decision` is sent, so the
/// cards simply never exist, and the inbox (the state) still marks the wall and
/// the song.
@MainActor
@Observable
final class JamPublicStore {
    private(set) var enabled = false
    private(set) var loaded = false
    private(set) var inbox: [JamPublicInboxItem] = []
    /// What the server holds, newest first.
    private(set) var notices: [JamTakeNotice] = []
    /// A live `take` frame the server wrote no item for (the notices switch is
    /// off): the old toast's place, shown as a card that is never sent back.
    private(set) var liveTake: JamTakeNotice?

    /// The jam screens on screen right now (a song, a wall). A card is never drawn
    /// over them (`jamNoticePlacement`: never over a transport, and a wall's
    /// back button is under it): the wall's row and tile markers and the song's
    /// own block at the top say the same thing, and the card waits for the
    /// person to come out.
    private(set) var heldBy: Set<String> = []

    /// A card is drawn only when no jam screen is open.
    var cardsAreHeld: Bool { !heldBy.isEmpty }

    @ObservationIgnored private var api: APIClient?
    /// Bumped when another account takes over: an answer that was out for the
    /// last one is not this one's to apply.
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var reading: Task<Void, Never>?
    /// Which read `reading` is: a read that ends after `clear` must not clear
    /// the next account's.
    @ObservationIgnored private var readToken = 0
    /// Something asked to read again while a read was out.
    @ObservationIgnored private var readAgain = false

    /// The cards a person is shown, newest first: the server's items, with the
    /// local one (if any) in front, since it is the moment that just happened.
    var cards: [JamTakeNotice] {
        guard let liveTake else { return notices }
        return [liveTake] + notices
    }

    func attach(api: APIClient) { self.api = api }

    // MARK: - Reading

    /// At boot, and whenever a frame, a reconnect or a screen says the lists may
    /// be out of date. Never throws: a failed read keeps what is held.
    func refresh() async {
        guard api != nil else { return }
        if let reading {
            // A read that started before the thing that asked produced its
            // answer from before it: read once more when it ends.
            readAgain = true
            await reading.value
            return
        }
        readToken += 1
        let token = readToken
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.readAgain = false
                await self.readOnce()
            } while self.readAgain && token == self.readToken
            if token == self.readToken { self.reading = nil }
        }
        reading = task
        await task.value
    }

    private func readOnce() async {
        guard let api else { return }
        let mine = epoch
        if !enabled || !loaded {
            guard let config = await api.jamPublicConfig() else { return }
            guard mine == epoch else { return }
            loaded = true
            enabled = config.enabled
            if !config.enabled {
                inbox = []
                notices = []
                liveTake = nil
                return
            }
        }
        async let inboxRead = try? await api.jamPublicInbox()
        async let noticeRead = try? await api.jamTakeNotices()
        let (inboxAnswer, noticeAnswer) = await (inboxRead, noticeRead)
        guard mine == epoch else { return }
        // A list that failed to arrive is the one it was: never emptied by a
        // lost connection.
        if let inboxAnswer { inbox = inboxAnswer.takes }
        if let noticeAnswer { notices = noticeAnswer.notices }
        settleLiveTake()
    }

    /// The local card goes when nothing waits on its song any more (it was
    /// answered), or when the server has an item of its own for it.
    private func settleLiveTake() {
        guard let live = liveTake else { return }
        let answered = !inbox.contains { $0.songId == live.songId }
        let carded = notices.contains { $0.kind == .take && $0.songId == live.songId }
        if answered || carded { liveTake = nil }
    }

    // MARK: - Frames

    /// `jam-public-notice` and `jam-take-decision`. Both are nudges: the lists
    /// are read again, and the one thing a frame adds is the old toast for a
    /// starter the server wrote no item for.
    func apply(_ frame: JamPublicFrame) {
        switch frame {
        case .decision:
            Task { await refresh() }
        case .notice(let notice):
            Task { [weak self] in
                await self?.refresh()
                guard let self, self.enabled else { return }
                self.noteLiveTake(notice)
            }
        }
    }

    /// A `take` frame, after the lists were read: when the server wrote no
    /// item for that song (the switch is off) the person is still told, once.
    private func noteLiveTake(_ notice: JamPublicNoticeFrame) {
        guard notice.kind == .take, !notice.admitted else { return }
        guard inbox.contains(where: { $0.songId == notice.songId }) else { return }
        guard !notices.contains(where: { $0.kind == .take && $0.songId == notice.songId }) else { return }
        liveTake = JamTakeNotice(
            id: "live:\(notice.songId)", kind: .take, songId: notice.songId, title: notice.title,
            instruments: notice.instrument.map { [$0] } ?? [],
            count: JamWaiting.count(in: inbox, songId: notice.songId)
        )
    }

    /// The socket came back: frames sent while it was down are gone.
    func reconnected() {
        guard api != nil else { return }
        Task { await refresh() }
    }

    // MARK: - What a person does

    /// A card was tapped or closed: it leaves at once and the server keeps it
    /// spent. The local card has no item to spend.
    func ack(_ id: String) {
        if liveTake?.id == id {
            liveTake = nil
            return
        }
        notices.removeAll { $0.id == id }
        guard let api else { return }
        Task { try? await api.ackJamTakeNotice(id: id) }
    }

    /// A take left the inbox (put in the mix, or declined): it goes without
    /// waiting for the read, and the starter's card for that song follows when it
    /// was the last one waiting on it (the server empties it the same way).
    func dropInboxTake(trackId: String) {
        guard let dropped = inbox.first(where: { $0.track.id == trackId }) else { return }
        inbox.removeAll { $0.track.id == trackId }
        if !inbox.contains(where: { $0.songId == dropped.songId }) {
            notices.removeAll { $0.kind == .take && $0.songId == dropped.songId }
        }
        settleLiveTake()
    }

    /// A take is waiting again (an undo of an accept): read, because the inbox is
    /// what lists it and the starter's own card comes back from the server.
    func waitingMayHaveChanged() {
        Task { await refresh() }
    }

    func songOpened(_ id: String) { heldBy.insert(id) }
    func songClosed(_ id: String) { heldBy.remove(id) }

    /// Another account is looking now, or nobody is.
    func clear() {
        epoch += 1
        readToken += 1
        reading?.cancel()
        reading = nil
        readAgain = false
        enabled = false
        loaded = false
        inbox = []
        notices = []
        liveTake = nil
    }
}
