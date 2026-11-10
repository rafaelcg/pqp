import SwiftUI

extension View {
    /// Activities for one channel: the strip when one is running, the entry in the
    /// toolbar, the launcher, the consent sheet and the pane. With `serverId` nil
    /// (a conversation) or the platform off for the server it adds nothing at all.
    func activities(
        channelId: String, channelName: String, serverId: String?, isVoice: Bool,
        origin: ActivityRunner.Origin, voiceChannel: Channel? = nil, serverName: String? = nil
    ) -> some View {
        modifier(ActivitiesHost(
            channelId: channelId, channelName: channelName, serverId: serverId, isVoice: isVoice,
            origin: origin, voiceChannel: voiceChannel, serverName: serverName
        ))
    }
}

struct ActivitiesHost: ViewModifier {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallRatingModel.self) private var ratings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let channelId: String
    let channelName: String
    let serverId: String?
    let isVoice: Bool
    let origin: ActivityRunner.Origin
    let voiceChannel: Channel?
    let serverName: String?

    @State private var model: ActivitiesChannelModel
    @State private var hintSeen = ActivityHint.seen
    @State private var now = Date()

    init(
        channelId: String, channelName: String, serverId: String?, isVoice: Bool,
        origin: ActivityRunner.Origin, voiceChannel: Channel?, serverName: String?
    ) {
        self.channelId = channelId
        self.channelName = channelName
        self.serverId = serverId
        self.isVoice = isVoice
        self.origin = origin
        self.voiceChannel = voiceChannel
        self.serverName = serverName
        _model = State(initialValue: ActivitiesChannelModel(
            channelId: channelId, channelName: channelName, serverId: serverId ?? "",
            isVoice: isVoice, origin: origin
        ))
    }

    private var apps: AppsStore { session.apps }
    private var config: AppsConfig? { apps.config(for: serverId) }
    private var live: AppSessionSummary? { apps.live(in: channelId) }

    /// The platform is on for this server and there is something to show or start.
    private var offersEntry: Bool {
        guard serverId != nil, let config else { return false }
        guard LauncherRules.offersEntry(config: config, live: live) else { return false }
        if live != nil { return true }
        let type = isVoice ? "voice" : "text"
        return config.apps.contains { AppPhoneSupport.of($0) == .participate && $0.channelTypes.contains(type) }
    }

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) { strips }
            .toolbar {
                if offersEntry {
                    ToolbarItem(placement: .topBarTrailing) { entryButton }
                }
            }
            .sheet(isPresented: $model.launcherOpen) {
                if let config {
                    ActivityLauncherSheet(model: model, config: config)
                        .preferredColorScheme(.dark)
                }
            }
            // The dot on the entry and the hint card inside the launcher are both
            // spent once the launcher has been opened and put away.
            .onChange(of: model.launcherOpen) { _, open in
                if !open, !hintSeen { ActivityHint.markSeen(); hintSeen = true }
            }
            .sheet(item: $model.joinOffer) { offer in
                ActivityJoinSheet(model: model, offer: offer)
                    .preferredColorScheme(.dark)
            }
            .fullScreenCover(item: paneBinding) { runner in
                ActivityPaneView(runner: runner)
                    .preferredColorScheme(.dark)
                    .tint(Palette.signal)
            }
            .task(id: serverId) {
                guard serverId != nil else { return }
                await model.load(session: session)
            }
            .onChange(of: apps.reconnectRevision) { _, _ in
                guard serverId != nil else { return }
                Task {
                    // Jittered, like the web's catch-up: a server's worth of phones
                    // must not all ask in the same millisecond.
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 200...1200)))
                    await model.load(session: session)
                }
            }
            // Re-read the config when the screen comes back: the operator flips
            // the flag with no deploy.
            .onChange(of: apps.pane == nil) { _, closed in
                if closed { Task { await model.load(session: session, force: true) } }
            }
    }

    private var paneBinding: Binding<ActivityRunner?> {
        Binding(
            get: { apps.pane?.origin == origin && apps.pane?.channelId == channelId ? apps.pane : nil },
            set: { if $0 == nil, apps.pane?.channelId == channelId { apps.closePane() } }
        )
    }

    // MARK: Entry

    private var entryButton: some View {
        Button {
            model.openLauncher(session: session)
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "square.grid.2x2")
                if !hintSeen && live == nil {
                    Circle().fill(Palette.signal).frame(width: 8, height: 8).offset(x: 4, y: -3)
                }
            }
        }
        .tint(Palette.signal)
        .accessibilityLabel("Activities")
        .accessibilityIdentifier("chat.activities")
    }

    // MARK: Strips

    @ViewBuilder
    private var strips: some View {
        Group {
            if serverId != nil, let config, config.enabled {
                if let live {
                    liveStrip(live, config: config)
                } else if let record = apps.ended[channelId] {
                    endedStrip(record, config: config)
                }
            }
        }
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.standard, value: live?.id)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.standard, value: apps.ended[channelId]?.sessionId)
    }

    private func liveStrip(_ live: AppSessionSummary, config: AppsConfig) -> some View {
        let app = config.apps.first { $0.id == live.appId }
        let model = StripRules.model(StripInput(
            live: live, app: app, viewerId: apps.viewerId, online: !apps.isOffline,
            offlineSince: apps.offlineSince, now: now, canModerate: self.model.canModerate,
            leftLocally: apps.leftLocally.contains(channelId), channelIsVoice: isVoice,
            inCallHere: voice.isLive && voice.channelId == channelId
        ))
        let pane = apps.pane
        let opening = pane?.sessionId == live.id && pane?.phase == .joining
        return ActivityStripView(
            model: model, app: app, hostName: apps.name(of: live.hostUserId), now: now,
            handoffNextName: live.handoff?.toUserId.map { apps.name(of: $0) },
            handoff: live.handoff, isOpening: opening,
            onEnter: { enter(live, app: app) },
            onReopen: { enter(live, app: app) },
            onWatchInCall: { watchInCall() }
        )
        .task(id: live.handoff?.at) { now = Date() }
    }

    private func endedStrip(_ record: EndedActivity, config: AppsConfig) -> some View {
        let app = record.appId.flatMap { id in config.apps.first { $0.id == id } }
        return ActivityEndedStripView(
            record: record, appName: app?.name() ?? "?",
            endedByName: apps.name(of: record.hostUserId), endedBySelf: record.hostUserId != nil && record.hostUserId == apps.viewerId,
            onClose: { apps.clearEnded(channelId) }
        )
    }

    private func enter(_ live: AppSessionSummary, app: AppEntry?) {
        guard let app else { return }
        Task { await model.enter(app: app, summary: live, session: session) }
    }

    private func watchInCall() {
        guard let voiceChannel else { return }
        model.watchInCall(voice: voice, session: session, ratings: ratings, channel: voiceChannel, serverName: serverName)
    }
}
