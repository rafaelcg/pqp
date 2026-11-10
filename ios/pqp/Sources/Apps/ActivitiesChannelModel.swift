import Foundation
import Observation
import UIKit

/// Everything one screen needs to offer activities for ONE channel: whether the
/// platform is on for the server, who may start, the launcher, the consent sheet
/// and the hand-off into the pane. The screen (a chat, or a voice room) owns one;
/// the shared state (which session is live, which pane is open) is `AppsStore`.
///
/// INVISIBLE UNTIL THE SERVER SAYS SO. `load()` asks `GET /api/apps/config` once
/// per server per minute; with `enabled: false` (or no answer) it asks for
/// nothing else, and `offersEntry` stays false, so a channel on a server without
/// the platform looks and behaves exactly as it did before activities existed.
@MainActor
@Observable
final class ActivitiesChannelModel {
    /// What a start that did not happen says, in the launcher.
    enum StartNotice: Equatable {
        case noPermission
        case unavailable
        case runningHere(by: String)
        case rateLimited
        case failed
    }

    /// The consent sheet's subject: an app the person is about to enter for the first time.
    struct JoinOffer: Identifiable, Equatable {
        let id = UUID()
        let app: AppEntry
        let session: AppSessionSummary
        /// The person started it (the sheet says "tu começou" rather than a name).
        let startedByViewer: Bool

        static func == (a: JoinOffer, b: JoinOffer) -> Bool { a.id == b.id }
    }

    private(set) var channelId: String
    private(set) var channelName: String
    private(set) var serverId: String
    private(set) var isVoice: Bool
    let origin: ActivityRunner.Origin

    var launcherOpen = false
    var joinOffer: JoinOffer?
    private(set) var startingAppId: String?
    private(set) var notice: StartNotice?
    private(set) var entering = false
    private(set) var enterFailed = false
    private(set) var permissions: PermissionsSnapshot?
    private(set) var consents: [AppConsentRecord]?

    @ObservationIgnored private var consentsAt: Date?

    init(channelId: String, channelName: String, serverId: String, isVoice: Bool, origin: ActivityRunner.Origin) {
        self.channelId = channelId
        self.channelName = channelName
        self.serverId = serverId
        self.isVoice = isVoice
        self.origin = origin
    }

    /// The screen was reused for another channel: everything channel-specific
    /// (permissions, consent offers, notices) is dropped, nothing is carried over.
    func rebind(channelId: String, channelName: String, serverId: String, isVoice: Bool) {
        guard channelId != self.channelId || serverId != self.serverId else { return }
        self.channelId = channelId
        self.channelName = channelName
        self.serverId = serverId
        self.isVoice = isVoice
        permissions = nil
        notice = nil
        joinOffer = nil
        launcherOpen = false
    }

    var channelType: LauncherChannelType { isVoice ? .voice : .text }

    // MARK: - Reading the world

    /// Asks for the server's config, then (only if it is on) the live sessions,
    /// the members and this person's permissions. Called when the screen appears
    /// and after every reconnect.
    func load(session: SessionStore, force: Bool = false) async {
        session.apps.noteChannel(channelId, serverId: serverId)
        let config = await session.apps.ensureConfig(serverId: serverId, api: session.api, force: force)
        guard config.enabled else { return }
        async let sessions: Void = session.apps.catchUp(serverId: serverId, api: session.api)
        async let people: Void = session.apps.loadPeople(serverId: serverId, api: session.api, me: session.currentUser)
        async let perms = try? await session.api.fetchMemberPermissions(serverId: serverId)
        _ = await (sessions, people)
        if let snapshot = await perms { permissions = snapshot }
    }

    /// Whether this person holds USE_APPS here: nil while the permissions have not
    /// landed, which the launcher reads as "ask the server" and not as a no.
    var mayStart: Bool? {
        permissions.map { $0.can(PermissionBit.useApps, channelId: channelId) }
    }

    /// MANAGE_CHANNELS here: moderates a session of somebody else's.
    var canModerate: Bool {
        permissions?.can(PermissionBit.manageChannels, channelId: channelId) ?? false
    }

    func tiles(config: AppsConfig, live: AppSessionSummary?) -> [LauncherTile] {
        LauncherRules.tiles(
            config: config, channelType: channelType,
            canManageChannels: canModerate || permissions == nil, live: live
        )
    }

    // MARK: - Starting

    func openLauncher(session: SessionStore) {
        notice = nil
        launcherOpen = true
        Haptics.selection()
        // The operator flips the flag with no deploy: what the launcher lists is
        // read again as it opens, not trusted from a minute ago. The config only:
        // sessions, people and permissions are not asked again for a sheet.
        Task { await session.apps.ensureConfig(serverId: serverId, api: session.api, force: true) }
    }

    /// Starts `app` here and, if it started, takes the starter's seat. The fewest
    /// taps: one on "Começar" (and the consent sheet, the first time only).
    func start(app: AppEntry, session: SessionStore) async {
        guard startingAppId == nil else { return }
        startingAppId = app.id
        notice = nil
        defer { startingAppId = nil }
        switch await session.api.startAppSession(channelId: channelId, appId: app.id) {
        case .started(let summary):
            session.apps.noteStarted(summary, channelId: channelId)
            await enter(app: app, summary: summary, startedByViewer: true, session: session)
        case .refused(let refusal):
            Haptics.failure()
            switch refusal {
            case .cannotStart: notice = .noPermission
            case .unavailable: notice = .unavailable
            case .sessionLive(let live):
                if let live { session.apps.noteStarted(live, channelId: channelId) }
                notice = .runningHere(by: session.apps.name(of: live?.startedBy))
            case .rateLimited: notice = .rateLimited
            case .notFound, .failed: notice = .failed
            }
        }
    }

    // MARK: - Entering

    /// Joins `summary`: straight in when the person already accepted this app, the
    /// consent sheet first when not.
    func enter(app: AppEntry, summary: AppSessionSummary, startedByViewer: Bool = false, session: SessionStore) async {
        enterFailed = false
        let accepted = await hasAccepted(app: app, session: session)
        if accepted {
            launcherOpen = false
            open(app: app, summary: summary, session: session)
        } else {
            // One sheet at a time: the launcher goes down before the consent
            // sheet comes up, or the second presentation is dropped.
            if launcherOpen {
                launcherOpen = false
                try? await Task.sleep(for: .milliseconds(350))
            }
            joinOffer = JoinOffer(app: app, session: summary, startedByViewer: startedByViewer)
        }
    }

    /// The consent sheet's "Entrar".
    func accept(_ offer: JoinOffer, identityGranted: Bool, session: SessionStore) async {
        guard !entering else { return }
        entering = true
        enterFailed = false
        defer { entering = false }
        do {
            try await session.api.acceptAppConsent(appId: offer.app.id, identityGranted: identityGranted)
            consents = nil
            consentsAt = nil
            joinOffer = nil
            launcherOpen = false
            // Let the sheet go down before the pane comes up: two presentations
            // changing in one frame drops one of them.
            try? await Task.sleep(for: .milliseconds(350))
            open(app: offer.app, summary: offer.session, session: session)
        } catch {
            enterFailed = true
            Haptics.failure()
        }
    }

    func dismissOffer() {
        joinOffer = nil
        enterFailed = false
    }

    private func open(app: AppEntry, summary: AppSessionSummary, session: SessionStore) {
        // A session that ended while the person read the sheet: nothing to open.
        guard session.apps.live(in: channelId)?.id == summary.id else { return }
        Haptics.success()
        session.apps.open(
            session: summary, app: app, channel: (channelId, channelName), serverId: serverId,
            origin: origin, asSpectator: false, store: session
        )
    }

    private func hasAccepted(app: AppEntry, session: SessionStore) async -> Bool {
        if consents == nil || consentsAt.map({ Date().timeIntervalSince($0) > 30 }) ?? true {
            consents = await session.api.appConsents()
            consentsAt = Date()
        }
        return consents?.contains { $0.appId == app.id && !$0.stale } == true
    }

    /// A voice room's call, for a spectate-only app: the picture is the host's
    /// share there, which the call screen already draws.
    func watchInCall(voice: VoiceModel, session: SessionStore, ratings: CallRatingModel, channel: Channel, serverName: String?) {
        Haptics.selection()
        voice.isCollapsed = false
        Task { await voice.join(channel: channel, session: session, ratings: ratings, serverName: serverName) }
    }
}

extension PermissionBit {
    /// `Permission.USE_APPS` = `1n << 29n`: start an activity here. On for
    /// @everyone of every server created since the platform shipped, and on the
    /// staff roles; a community only has it when its owner grants it.
    static let useApps: UInt64 = 1 << 29
}

extension Haptics {
    /// The seat is taken: the one moment of this feature that earns a firm tap.
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func failure() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
}
