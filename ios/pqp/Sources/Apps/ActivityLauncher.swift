import SwiftUI

/// The picker: what can be done together in this channel, and one tap to begin.
/// A sheet that opens at half height (the list is short) and grows.
///
/// A tile that cannot start here stays on screen, dimmed, with its reason
/// written: the person learns the app exists and where it works (mock 01). A tile
/// that can start has its "Começar" on the row itself, so starting is one tap (and
/// the consent sheet, the first time only).
struct ActivityLauncherSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    let model: ActivitiesChannelModel
    let config: AppsConfig
    @State private var appeared = false
    @State private var hintSeen = ActivityHint.seen

    private var live: AppSessionSummary? { session.apps.live(in: model.channelId) }
    private var tiles: [LauncherTile] { model.tiles(config: config, live: live) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if !hintSeen { hintCard.transition(.opacity.combined(with: .move(edge: .top))) }
                if let notice = model.notice { noticeLine(notice) }
                if tiles.isEmpty {
                    EmptyState(
                        icon: "square.grid.2x2",
                        title: "No activities here yet",
                        message: "Activities have not been turned on for this server yet. Whoever runs it can ask for access."
                    )
                } else {
                    ForEach(Array(tiles.enumerated()), id: \.element.id) { index, tile in
                        row(tile)
                            .opacity(appeared ? 1 : 0)
                            .offset(y: appeared || reduceMotion ? 0 : 10)
                            .animation(
                                reduceMotion ? .easeOut(duration: 0.15) : Motion.standard.delay(Motion.stagger(index)),
                                value: appeared
                            )
                    }
                    Text("Whoever starts it is the host and can end it any time.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .background(Palette.ink)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.ink)
        .onAppear { appeared = true }
        .accessibilityIdentifier("activity.launcher")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Activities")
                .font(Typography.title(24))
                .foregroundStyle(Palette.paper)
            Text("Do something together in #\(model.channelName)")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
        }
    }

    private var hintCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text("New: activities in the channel")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                Text("Start one and the crew joins from this channel, on the phone or the computer.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperSubtle)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button {
                withAnimation(Motion.standard) { hintSeen = true }
                ActivityHint.markSeen()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 30, height: 30)
            }
            .accessibilityLabel("Close")
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.signal.opacity(0.10)))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.signal.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity.hint")
    }

    private func noticeLine(_ notice: ActivitiesChannelModel.StartNotice) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.warning)
            noticeText(notice)
                .font(Typography.callout)
                .foregroundStyle(Palette.paper)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous).fill(Palette.warning.opacity(0.12)))
        .accessibilityIdentifier("activity.launcher.notice")
    }

    @ViewBuilder
    private func noticeText(_ notice: ActivitiesChannelModel.StartNotice) -> some View {
        switch notice {
        case .noPermission: Text("You cannot start activities in this channel. Ask whoever runs it.")
        case .unavailable: Text("This app is not available right now.")
        case .runningHere(let name): Text("An activity is already running in this channel, started by \(name).")
        case .rateLimited: Text("Easy, try again in a few seconds.")
        case .failed: Text("Could not start. Try again in a moment.")
        }
    }

    // MARK: Rows

    private func row(_ tile: LauncherTile) -> some View {
        let name = tile.app.name()
        return HStack(spacing: 12) {
            ActivityGlyph(icon: tile.app.icon, live: tile.running, size: 46)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                Text(verbatim: tile.app.summary())
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                facts(tile)
            }
            Spacer(minLength: 6)
            trailing(tile)
        }
        .padding(12)
        .pqpSurface()
        .opacity(tile.reason != nil && !tile.running ? 0.62 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity.tile.\(tile.app.id)")
    }

    @ViewBuilder
    private func facts(_ tile: LauncherTile) -> some View {
        Group {
            if tile.running {
                Text("Running here")
                    .foregroundStyle(Palette.signal)
            } else if let reason = tile.reason {
                reasonText(reason)
                    .foregroundStyle(Palette.warning)
            } else {
                people(tile.app)
                    .foregroundStyle(Palette.paperMuted)
            }
        }
        .font(Typography.caption)
        .padding(.top, 1)
    }

    @ViewBuilder
    private func people(_ app: AppEntry) -> some View {
        let min = app.players.min, max = app.players.max
        if max >= StripCount.unbounded {
            Text("Any size")
        } else if min == max {
            Text("\(max) people")
        } else {
            Text("\(min) to \(max) people")
        }
    }

    @ViewBuilder
    private func reasonText(_ reason: LauncherReason) -> some View {
        switch reason {
        case .voiceOnly: Text("Voice channels only")
        case .textOnly: Text("Text channels only")
        case .off: Text("Off on this server")
        case .community: Text("Not available in communities")
        case .unavailable: Text("Not available right now")
        case .needsManage: Text("Only people who manage channels can start it")
        case .onComputer: Text("Only on the computer for now")
        case .watchOnly: Text("On the phone you watch it in the call")
        case .otherRunning: Text("One activity per channel. End the one that is running first.")
        }
    }

    @ViewBuilder
    private func trailing(_ tile: LauncherTile) -> some View {
        if tile.running, let live {
            let seated = live.isSeated(session.apps.viewerId)
            pill(seated ? "Back to it" : "Join", enabled: tile.support == .participate, busy: false) {
                Task { await model.enter(app: tile.app, summary: live, session: session) }
            }
        } else if tile.reason == nil {
            let blocked = model.mayStart == false
            pill("Start", enabled: !blocked && model.startingAppId == nil, busy: model.startingAppId == tile.app.id) {
                Task { await model.start(app: tile.app, session: session) }
            }
            .accessibilityIdentifier("activity.start.\(tile.app.id)")
        }
    }

    private func pill(_ title: LocalizedStringKey, enabled: Bool, busy: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Text(title).opacity(busy ? 0 : 1)
                if busy { ProgressView().tint(Palette.inkDeep) }
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 16)
            .frame(minWidth: 76, minHeight: 36)
            .background(Capsule().fill(enabled ? Palette.signal : Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// The first-run hint's memory: once per device. Same shape as the other
/// one-time surfaces of the app (`UserDefaults`, a versioned key).
enum ActivityHint {
    static let key = "pqp.apps.hint.seen.v1"

    static var seen: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    static func markSeen() { seen = true }
}
