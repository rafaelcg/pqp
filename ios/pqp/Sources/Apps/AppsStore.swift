import Foundation
import Observation

/// THE ONE SOURCE OF TRUTH FOR "AN ACTIVITY IS RUNNING IN THIS CHANNEL" on the
/// phone (the web's `app-sessions-store.ts`): the strip, the launcher and the
/// open pane all read it.
///
/// OWNED BY THE SESSION, NOT BY THE SCREEN. `channel-app` goes to everyone who
/// can view the channel, not only to sockets looking at it, so a store that only
/// existed while a chat was on screen would miss a start that happened a screen
/// away. Registered once in `SessionStore.startRealtime`.
///
/// FED BY two things: `GET /api/servers/:id/app-sessions` when a server opens
/// and after every reconnect (`catchUp`), and the `channel-app` / `app-ended`
/// frames. A frame that lands while a read is in flight wins over that read, so a
/// slow answer cannot bring back a session that ended meanwhile.
///
/// INVISIBLE WITHOUT THE FLAG. Nothing here asks for anything until a server's
/// `GET /api/apps/config` says `enabled`, and a server that says no leaves no
/// trace: no strip, no entry, no further request.
@MainActor
@Observable
final class AppsStore {
    /// Per server, as the config answered it. Absent until it has been asked.
    private(set) var configs: [String: AppsConfig] = [:]
    /// The live session of each channel, by channel id.
    private(set) var sessions: [String: AppSessionSummary] = [:]
    /// The quiet record of an ending this phone saw, by channel id.
    private(set) var ended: [String: EndedActivity] = [:]
    /// Who a user id is, from the members of the servers that have an activity.
    private(set) var people: [String: ActivityPerson] = [:]
    /// Bumped on every socket that is not the first: screens re-read their server.
    private(set) var reconnectRevision = 0
    /// When the socket went away, for the 90 s "lost" rule.
    private(set) var offlineSince: Date?
    /// The activity this phone is seated in, if any. One at a time.
    private(set) var pane: ActivityRunner?
    /// Channels this phone pressed Sair in, until the summary catches up.
    private(set) var leftLocally: Set<String> = []

    @ObservationIgnored private var configAt: [String: Date] = [:]
    @ObservationIgnored private var configInFlight: [String: Task<AppsConfig, Never>] = [:]
    @ObservationIgnored private var channelServer: [String: String] = [:]
    @ObservationIgnored private var frameStamp: [String: Int] = [:]
    @ObservationIgnored private var frameCounter = 0
    @ObservationIgnored private var peopleLoaded: [String: Date] = [:]
    @ObservationIgnored private var hasBeenReady = false
    /// Bumped on sign-out: an answer that was in flight belongs to the old account.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var viewerIdProvider: () -> String? = { nil }
    @ObservationIgnored private var endedTimers: [String: Task<Void, Never>] = [:]

    /// How long a config is trusted: the operator flips the flag per server with no
    /// deploy, so it is re-read, but not on every screen change.
    static let configTTL: TimeInterval = 60

    func attach(viewerId: @escaping () -> String?) {
        viewerIdProvider = viewerId
    }

    var viewerId: String? { viewerIdProvider() }

    // MARK: - Reading

    func config(for serverId: String?) -> AppsConfig? {
        serverId.flatMap { configs[$0] }
    }

    func live(in channelId: String) -> AppSessionSummary? { sessions[channelId] }

    func person(_ userId: String) -> ActivityPerson? { people[userId] }

    func name(of userId: String?) -> String {
        guard let userId, let person = people[userId] else { return "?" }
        return person.displayName
    }

    func app(_ appId: String, in serverId: String?) -> AppEntry? {
        config(for: serverId)?.apps.first { $0.id == appId }
    }

    var isOffline: Bool { offlineSince != nil }

    // MARK: - Config

    /// The server's config, fresh enough. Coalesces concurrent callers.
    @discardableResult
    func ensureConfig(serverId: String, api: APIClient, force: Bool = false) async -> AppsConfig {
        if !force, let at = configAt[serverId], let known = configs[serverId],
           Date().timeIntervalSince(at) < Self.configTTL { return known }
        if let running = configInFlight[serverId] { return await running.value }
        let epoch = generation
        let task = Task<AppsConfig, Never> { await api.appsConfig(serverId: serverId) }
        configInFlight[serverId] = task
        let config = await task.value
        guard epoch == generation else { return config }
        configInFlight[serverId] = nil
        configAt[serverId] = Date()
        if configs[serverId] != config { configs[serverId] = config }
        if !config.enabled { dropSessions(of: serverId) }
        return config
    }

    // MARK: - Which server a channel is on

    /// A frame names a channel and no server, so the screens that know both say
    /// so: a catch-up reconciles (and a switched-off server drops) exactly the
    /// channels registered here, which covers every channel the person has had
    /// open, the only place a stale strip could be drawn.
    func noteChannel(_ channelId: String, serverId: String?) {
        guard let serverId, !serverId.isEmpty else { return }
        channelServer[channelId] = serverId
    }

    private func serverId(of channelId: String) -> String? { channelServer[channelId] }

    // MARK: - Catch-up

    /// Reads the server's live sessions. A failure keeps what the frames said.
    func catchUp(serverId: String, api: APIClient) async {
        guard configs[serverId]?.enabled == true else { return }
        let started = frameCounter
        let epoch = generation
        guard let rows = try? await api.serverAppSessions(serverId: serverId), epoch == generation else { return }
        let byChannel = Dictionary(rows.map { ($0.channelId, $0.session) }, uniquingKeysWith: { _, last in last })
        for channelId in byChannel.keys { channelServer[channelId] = serverId }
        for channelId in sessions.keys where channelServer[channelId] == serverId {
            // It ended while this phone was away, unless a frame says otherwise.
            if byChannel[channelId] == nil, (frameStamp[channelId] ?? 0) <= started {
                sessions.removeValue(forKey: channelId)
                leftLocally.remove(channelId)
            }
        }
        for (channelId, session) in byChannel where (frameStamp[channelId] ?? 0) <= started {
            if sessions[channelId] != session { sessions[channelId] = session }
        }
    }

    /// Reads the members once in a while, for names and faces. A failure keeps the old list.
    func loadPeople(serverId: String, api: APIClient, me: CurrentUser?) async {
        if let me, people[me.id] == nil {
            people[me.id] = ActivityPerson(userId: me.id, displayName: me.displayName, avatarUrl: me.avatarUrl)
        }
        if let at = peopleLoaded[serverId], Date().timeIntervalSince(at) < 120 { return }
        let epoch = generation
        guard let members = try? await api.members(serverId: serverId), epoch == generation else { return }
        peopleLoaded[serverId] = Date()
        for member in members {
            people[member.id] = ActivityPerson(userId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl)
        }
    }

    // MARK: - Frames

    func apply(_ event: RealtimeEvent) {
        switch event {
        case .ready:
            offlineSince = nil
            if hasBeenReady {
                reconnectRevision += 1
                pane?.socketReturned()
            }
            hasBeenReady = true
        case .apps(let frame):
            handle(frame)
        default:
            break
        }
    }

    /// The socket's state, for the "lost after 90 s" rule and the pane's banner.
    func noteStatus(_ status: RealtimeStatus) {
        switch status {
        case .online:
            offlineSince = nil
            pane?.setOnline(true)
        case .reconnecting:
            if offlineSince == nil { offlineSince = Date() }
            pane?.setOnline(false)
        default:
            break
        }
    }

    private func handle(_ frame: AppsFrame) {
        frameCounter += 1
        switch frame {
        case .channelApp(let channelId, let session):
            frameStamp[channelId] = frameCounter
            if let session {
                if sessions[channelId] != session { sessions[channelId] = session }
                if ended[channelId]?.sessionId != session.id { clearEnded(channelId) }
            } else {
                sessions.removeValue(forKey: channelId)
                leftLocally.remove(channelId)
            }
        case .ended(let sessionId, let channelId, let reason, let summary):
            frameStamp[channelId] = frameCounter
            let seated = pane?.sessionId == sessionId
                || sessions[channelId].map { $0.id == sessionId && $0.isSeated(viewerId) } == true
            let appId = sessions[channelId].flatMap { $0.id == sessionId ? $0.appId : nil } ?? pane?.app.id
            let hostUserId = sessions[channelId].flatMap { $0.id == sessionId ? $0.hostUserId : nil }
            if sessions[channelId]?.id == sessionId { sessions.removeValue(forKey: channelId) }
            leftLocally.remove(channelId)
            noteEnded(EndedActivity(
                sessionId: sessionId, channelId: channelId, appId: appId, hostUserId: hostUserId, reason: reason,
                summary: summary, endedAt: Date(), wasSeated: seated
            ))
            pane?.handle(frame)
        case .session, .state, .event, .error:
            pane?.handle(frame)
        }
    }

    /// A session this phone just started, or the one that refused it (`session_live`):
    /// in the store at once, so the strip and the join do not wait for the frame.
    func noteStarted(_ session: AppSessionSummary, channelId: String) {
        noteChannel(channelId, serverId: serverId(of: channelId))
        frameCounter += 1
        frameStamp[channelId] = frameCounter
        if sessions[channelId] != session { sessions[channelId] = session }
    }

    // MARK: - The quiet record of an ending

    private func noteEnded(_ record: EndedActivity) {
        // Only somebody who was in it is told; a viewer just sees the strip go.
        guard record.wasSeated else { return }
        ended[record.channelId] = record
        endedTimers[record.channelId]?.cancel()
        endedTimers[record.channelId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(EndedRules.lifetime))
            guard !Task.isCancelled else { return }
            self?.clearEnded(record.channelId, ifSession: record.sessionId)
        }
    }

    func clearEnded(_ channelId: String, ifSession sessionId: String? = nil) {
        if let sessionId, ended[channelId]?.sessionId != sessionId { return }
        ended.removeValue(forKey: channelId)
        endedTimers[channelId]?.cancel()
        endedTimers.removeValue(forKey: channelId)
    }

    // MARK: - The pane

    /// Seats this phone in `session` and presents the pane. One at a time: a
    /// second open while one is running is ignored.
    @discardableResult
    func open(
        session summary: AppSessionSummary, app: AppEntry, channel: (id: String, name: String),
        serverId: String, origin: ActivityRunner.Origin, asSpectator: Bool, store: SessionStore
    ) -> ActivityRunner? {
        guard pane == nil else { return pane?.sessionId == summary.id ? pane : nil }
        let runner = ActivityRunner(
            sessionId: summary.id, channelId: channel.id, channelName: channel.name, serverId: serverId,
            app: app, appsOrigin: configs[serverId]?.origin, origin: origin, asSpectator: asSpectator,
            session: store
        )
        pane = runner
        leftLocally.remove(channel.id)
        clearEnded(channel.id)
        Task { await runner.start() }
        return runner
    }

    /// "Try again" in the pane: same pane, new seat, new frame.
    func retryPane(store: SessionStore) {
        guard let runner = pane else { return }
        Task { await runner.retry() }
    }

    /// Closes the pane and releases the seat.
    func closePane(leaving: Bool = true) {
        guard let runner = pane else { return }
        if leaving { leftLocally.insert(runner.channelId) }
        runner.stop()
        pane = nil
    }

    /// The pane ended on its own (the session is over); the person has read it.
    func dismissEndedPane() {
        guard let runner = pane else { return }
        runner.stop()
        pane = nil
    }

    // MARK: - Housekeeping

    private func dropSessions(of serverId: String) {
        for channelId in sessions.keys where channelServer[channelId] == serverId {
            sessions.removeValue(forKey: channelId)
        }
    }

    /// A signed-out account owns nothing here.
    func clear() {
        generation += 1
        configInFlight = [:]
        configs = [:]
        configAt = [:]
        sessions = [:]
        ended = [:]
        people = [:]
        peopleLoaded = [:]
        channelServer = [:]
        frameStamp = [:]
        leftLocally = []
        offlineSince = nil
        hasBeenReady = false
        for timer in endedTimers.values { timer.cancel() }
        endedTimers = [:]
        pane?.stop()
        pane = nil
    }
}
