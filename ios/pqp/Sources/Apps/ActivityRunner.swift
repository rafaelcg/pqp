import Foundation
import Observation
import UIKit

/// One activity this phone is seated in: the seat on the server, the sandboxed
/// frame, and the bridge between them. The phone's counterpart of the web's
/// `mountAppFrame` + `BridgeHost` + `session-wire.ts`.
///
/// ORDER OF EVENTS, and why (the web's, with the phone's differences):
///
/// 1. The runner is registered with the store BEFORE `app-join` goes out, so the
///    `app-session` snapshot that answers it cannot be missed.
/// 2. The seat is taken first; only then does the frame load. The frame's
///    `app-hello` is answered when the seat exists, never before: the `hello` push
///    carries the seat id and role.
/// 3. A state patch is answered by the next `app-state` (the server broadcasts
///    the whole value to every seat, the writer included) or an `app-error`. At
///    most eight seconds, then `unavailable`.
/// 4. When the socket comes back the seat is resumed with a second `app-join`.
///    The same seat id and role return, and the snapshot is applied by the bridge
///    (a revision never goes backwards).
/// 5. Leaving releases the seat (`app-leave`) and removes the frame. Nothing is
///    queued while the socket is down: a state write with no socket is refused
///    `unavailable` by the bridge.
@MainActor
@Observable
final class ActivityRunner: Identifiable, AppBridgeTransport {
    enum Phase: Equatable {
        case joining
        case loading
        case ready
        case failed(Failure)
        case ended(AppEndReason)
        case left
    }

    enum Failure: Equatable {
        case join(AppErrorCode)
        case connection
        case frame(AppFrameController.Violation)
    }

    /// Where the pane is presented from: a screen can only show one cover at a time.
    enum Origin: Equatable { case channel, call }

    let id = UUID()
    let sessionId: String
    let channelId: String
    let channelName: String
    let serverId: String
    let app: AppEntry
    let origin: Origin
    let asSpectator: Bool

    private(set) var phase: Phase = .joining
    private(set) var snapshot: AppSeatSnapshot?
    private(set) var online = true
    /// The frame, once the seat exists.
    private(set) var frame: AppFrameController?
    /// Whether the app said something has started (`ui.activity`: playing, paused, browsing).
    private(set) var activity: String?
    /// How many people are in it, from the last snapshot.
    private(set) var roster: [BridgeParticipant] = []

    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private var bridge: AppBridge?
    @ObservationIgnored private var joinWaiter: CheckedContinuation<AppSeatSnapshot, Error>?
    @ObservationIgnored private var patchWaiters: [(id: UUID, continuation: CheckedContinuation<Int, Error>)] = []
    @ObservationIgnored private var rosterGeneration = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var appsOrigin: String?

    init(
        sessionId: String, channelId: String, channelName: String, serverId: String,
        app: AppEntry, appsOrigin: String?, origin: Origin, asSpectator: Bool, session: SessionStore
    ) {
        self.sessionId = sessionId
        self.channelId = channelId
        self.channelName = channelName
        self.serverId = serverId
        self.app = app
        self.appsOrigin = appsOrigin
        self.origin = origin
        self.asSpectator = asSpectator
        self.session = session
    }

    var isHost: Bool { snapshot?.isHost ?? false }
    var isSpectator: Bool { snapshot?.role == .spectator }

    // MARK: - Lifecycle

    /// Takes the seat, then loads the frame. Never throws: the outcome is `phase`.
    func start() async {
        guard let session, phase == .joining else { return }
        do {
            let seat = try await join(session: session)
            guard !stopped else { return }
            snapshot = seat
            try beginFrame(seat)
        } catch let error as AppTransportError {
            guard !stopped else { return }
            if case .ended = phase { return }
            phase = .failed(.join(error.code))
        } catch {
            guard !stopped else { return }
            phase = .failed(.connection)
        }
    }

    /// Try again after a failure: a fresh seat and a fresh frame in the same pane.
    func retry() async {
        guard case .failed = phase else { return }
        bridge?.detach()
        bridge = nil
        frame?.remove()
        frame = nil
        failWaiters(AppTransportError(code: .ended))
        snapshot = nil
        seatReleased = false
        stopped = false
        phase = .joining
        await start()
    }

    private func beginFrame(_ seat: AppSeatSnapshot) throws {
        guard let entry = app.entryURL, let origin = appsOrigin,
              let controller = AppFrameController(entry: entry, appsOrigin: origin, title: app.name())
        else {
            phase = .failed(.frame(.badEntry))
            throw AppTransportError(code: .unavailable)
        }
        let bridge = AppBridge(
            options: AppBridge.Options(
                app: app, locale: AppLocale.current, theme: AppTheme.tokens(),
                reducedMotion: UIAccessibility.isReduceMotionEnabled
            ),
            transport: self,
            post: { [weak controller] json in controller?.post(json.compactText) }
        )
        bridge.onActivity = { [weak self] state in self?.activity = state }
        bridge.onViolation = { [weak self] in self?.frameFailed(.frameNavigated) }
        self.bridge = bridge
        self.frame = controller
        bridge.applySnapshot(seat)
        controller.onMessage = { [weak bridge] text in bridge?.receive(text) }
        controller.onHello = { [weak self] in
            guard let self, let bridge = self.bridge, !self.stopped else { return }
            // The seat exists: hand the frame its port, then say hello.
            self.frame?.attachPort()
            bridge.attach()
            self.rebuildRoster()
            if self.phase == .loading { self.phase = .ready }
        }
        controller.onViolation = { [weak self] violation in self?.frameFailed(violation) }
        phase = .loading
        controller.load()
        rebuildRoster()
    }

    private func frameFailed(_ violation: AppFrameController.Violation) {
        guard !stopped else { return }
        switch phase {
        case .ended, .left, .failed: return
        default: break
        }
        phase = .failed(.frame(violation))
        releaseSeat()
    }

    /// Releases the seat and takes the frame out. Safe to call twice.
    func stop() {
        guard !stopped else { return }
        stopped = true
        var release = snapshot != nil
        switch phase {
        case .ended: release = false
        case .failed, .left: break
        default: phase = .left
        }
        bridge?.detach()
        frame?.remove()
        failWaiters(AppTransportError(code: .ended))
        if release { releaseSeat() }
    }

    @ObservationIgnored private var seatReleased = false

    private func releaseSeat() {
        guard let session, !seatReleased else { return }
        seatReleased = true
        let id = sessionId
        Task { await session.realtime.appLeave(sessionId: id) }
    }

    // MARK: - Join

    private func join(session: SessionStore) async throws -> AppSeatSnapshot {
        let spectator = asSpectator
        let id = sessionId
        return try await withCheckedThrowingContinuation { continuation in
            joinWaiter = continuation
            Task { await session.realtime.appJoin(sessionId: id, asSpectator: spectator) }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(AppLimits.joinTimeout))
                self?.resolveJoin(.failure(AppTransportError(code: .unavailable)))
            }
        }
    }

    private func resolveJoin(_ result: Result<AppSeatSnapshot, AppTransportError>) {
        guard let waiter = joinWaiter else { return }
        joinWaiter = nil
        waiter.resume(with: result.mapError { $0 as Error })
    }

    // MARK: - What the session tells us

    func handle(_ frame: AppsFrame) {
        guard frame.sessionId == sessionId, !stopped else { return }
        switch frame {
        case .session(let seat):
            snapshot = seat
            if joinWaiter != nil {
                resolveJoin(.success(seat))
            } else {
                // A resume or a roster change.
                bridge?.applySnapshot(seat)
                rebuildRoster()
            }
        case .state(_, let rev, let value):
            bridge?.applyState(rev: rev, value: value)
            resolvePatches(rev: rev)
        case .event(_, let from, let name, let data):
            bridge?.applyEvent(fromSeatId: from, name: name, data: data)
        case .ended(_, _, let reason, _):
            end(reason)
        case .error(_, let op, let code):
            switch op {
            case .join:
                if joinWaiter != nil {
                    resolveJoin(.failure(AppTransportError(code: code)))
                } else {
                    // The seat could not be resumed (the person lost the right to
                    // be here, or the session is gone).
                    if code == .ended { end(.unknown) } else { phase = .failed(.join(code)); finish() }
                }
            case .state:
                if let first = patchWaiters.first {
                    patchWaiters.removeFirst()
                    first.continuation.resume(throwing: AppTransportError(code: code))
                }
            case .leave, .event:
                break
            }
        case .channelApp:
            break
        }
    }

    private func end(_ reason: AppEndReason) {
        switch phase {
        case .ended, .left: return
        default: break
        }
        phase = .ended(reason)
        bridge?.setEnded(reason)
        failWaiters(AppTransportError(code: .ended))
        resolveJoin(.failure(AppTransportError(code: .ended)))
    }

    /// A seat that cannot go on: the frame is removed, nothing more is sent.
    private func finish() {
        bridge?.detach()
        frame?.remove()
        failWaiters(AppTransportError(code: .unavailable))
    }

    /// The `/ws` link dropped or came back.
    func setOnline(_ next: Bool) {
        guard online != next else { return }
        online = next
        bridge?.setConnection(online: next)
    }

    /// A new socket after a drop: the server forgot who was seated where, so the
    /// seat is asked for again. The same seat id and role come back.
    func socketReturned() {
        guard let session, snapshot != nil, !stopped else { return }
        switch phase {
        case .ended, .left, .failed: return
        default: break
        }
        let id = sessionId
        let spectator = asSpectator
        Task { await session.realtime.appJoin(sessionId: id, asSpectator: spectator) }
    }

    // MARK: - Roster

    /// People for the app: a seat id, a cleaned name and a small avatar as a data
    /// URL. Built from scratch; the pqp user id is read here and goes no further.
    private func rebuildRoster() {
        guard let snapshot, let session else { return }
        rosterGeneration += 1
        let generation = rosterGeneration
        let seats = snapshot.participants
        let people = seats.map { session.apps.person($0.userId) }
        Task { [weak self] in
            var built: [BridgeParticipant?] = Array(repeating: nil, count: seats.count)
            await withTaskGroup(of: (Int, BridgeParticipant).self) { group in
                var next = 0
                func add() {
                    guard next < seats.count else { return }
                    let index = next
                    let seat = seats[index]
                    next += 1
                    let person = people[index]
                    group.addTask {
                        let avatar = await AppAvatarCache.shared.dataURL(for: person?.avatarUrl)
                        return (index, BridgeParticipant(
                            seatId: seat.seatId,
                            displayName: AppBridge.cleanDisplayName(person?.displayName),
                            avatar: avatar, role: seat.role, isHost: seat.isHost,
                            connection: seat.connection, appUserId: seat.appUserId
                        ))
                    }
                }
                for _ in 0..<min(6, seats.count) { add() }
                while let (index, participant) = await group.next() {
                    built[index] = participant
                    add()
                }
            }
            guard let self, generation == self.rosterGeneration, !self.stopped else { return }
            let list = built.compactMap { $0 }
            self.roster = list
            self.bridge?.setParticipants(list)
        }
    }

    // MARK: - AppBridgeTransport

    func patchState(_ patch: JSONValue, baseRev: Int?) async throws -> Int {
        guard let session, !stopped else { throw AppTransportError(code: .ended) }
        let id = sessionId
        let waiterId = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            patchWaiters.append((waiterId, continuation))
            Task { await session.realtime.appStatePatch(sessionId: id, baseRev: baseRev, patch: patch) }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(AppLimits.joinTimeout))
                self?.expirePatch(waiterId)
            }
        }
    }

    private func resolvePatches(rev: Int) {
        let waiting = patchWaiters
        patchWaiters = []
        for waiter in waiting { waiter.continuation.resume(returning: rev) }
    }

    private func expirePatch(_ id: UUID) {
        guard let index = patchWaiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = patchWaiters.remove(at: index)
        waiter.continuation.resume(throwing: AppTransportError(code: .unavailable))
    }

    private func failWaiters(_ error: AppTransportError) {
        let waiting = patchWaiters
        patchWaiters = []
        for waiter in waiting { waiter.continuation.resume(throwing: error) }
    }

    func sendEvent(name: String, data: JSONValue) {
        guard let session, !stopped else { return }
        let id = sessionId
        Task { await session.realtime.appEventSend(sessionId: id, name: name, data: data) }
    }

    func endSession() async throws {
        guard let session else { throw AppTransportError(code: .unavailable) }
        do {
            _ = try await session.api.endAppSession(id: sessionId)
        } catch let error as APIError {
            if case .server(let status, _) = error, status == 403 { throw AppTransportError(code: .notAllowed) }
            throw AppTransportError(code: .unavailable)
        }
    }

    /// The pane's Encerrar: the same call the app's own `session.end` makes, for
    /// the host or somebody who may moderate.
    func endForEveryone() async -> Bool {
        do {
            try await endSession()
            return true
        } catch {
            return false
        }
    }
}
