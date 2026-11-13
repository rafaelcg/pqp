import SwiftUI

/// The strip above a channel that says an activity is running in it: who started
/// it, who is in, and the one thing to tap. Drawn for everyone who can see the
/// channel, seated or not (decision D13), and it stays while the session exists.
///
/// Motion: it slides in from the top on a spring (a fade under Reduce Motion), the
/// live dot breathes (still under Reduce Motion), and the count changes with a
/// numeric transition. Haptics belong to the actions, not to the strip.
struct ActivityStripView: View {
    let model: ActivityStripModel
    let app: AppEntry?
    let hostName: String
    let now: Date
    let handoffNextName: String?
    let handoff: AppHandoff?
    let isOpening: Bool
    let onEnter: () -> Void
    let onReopen: () -> Void
    let onWatchInCall: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    private var appName: String { app?.name() ?? model.appId }

    var body: some View {
        HStack(spacing: 12) {
            ActivityGlyph(icon: app?.icon ?? "sparkles", live: true, breathing: breathing)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: appName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                line
                    .font(Typography.caption)
                    .foregroundStyle(tone)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            action
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.inkDeep)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activity.strip")
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { breathing = true }
        }
    }

    private var tone: Color {
        switch model.phase {
        case .reconnecting, .lost: Palette.warning
        case .handoffYou, .handoffOther: Palette.warning
        default: Palette.paperMuted
        }
    }

    // MARK: Lines

    @ViewBuilder
    private var line: some View {
        switch model.phase {
        case .reconnecting:
            Text("No connection. Trying to get back")
        case .lost:
            Text("Your connection dropped and your spot was released.")
        case .handoffYou, .handoffOther:
            handoffLine
        default:
            if model.support == .none {
                Text("Only on the computer for now")
            } else if model.support == .spectate {
                spectateLine
            } else {
                HStack(spacing: 0) {
                    roleLine
                    Text(verbatim: "  ·  ")
                    countLine
                }
            }
        }
    }

    @ViewBuilder
    private var roleLine: some View {
        switch model.phase {
        case .host: Text("You are the host")
        case .spectator: Text("Watching. Host: \(hostName)")
        default: Text("Host: \(hostName)")
        }
    }

    @ViewBuilder
    private var countLine: some View {
        switch StripCount.of(model: model) {
        case .none:
            Text("Nobody in yet")
        case .of(let players, let max, let watching):
            if watching > 0 {
                Text("\(players) of \(max), \(watching) watching")
            } else {
                Text("\(players) of \(max)")
            }
        case .open(let players, let watching):
            if watching > 0 {
                Text("\(players) in, \(watching) watching")
            } else {
                Text("\(players) in")
            }
        }
    }

    @ViewBuilder
    private var spectateLine: some View {
        if model.players == 0 {
            Text("The picture goes through the call.")
        } else if model.channelIsVoice {
            Text("\(model.players) playing. The picture goes through the call.")
        } else {
            Text("Runs on the player's computer. Open a voice channel to watch.")
        }
    }

    @ViewBuilder
    private var handoffLine: some View {
        if let handoff {
            TimelineView(.periodic(from: now, by: 1)) { context in
                let seconds = StripRules.secondsUntil(handoff.at, now: context.date)
                let time = Self.clock(seconds)
                if model.phase == .handoffYou {
                    Text("\(hostName) left. If they do not come back, you take over in \(time).")
                } else if let next = handoffNextName {
                    Text("\(hostName) left. \(next) takes over in \(time).")
                } else {
                    Text("\(hostName) left. With nobody to take over, the app ends in \(time).")
                }
            }
        }
    }

    static func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: Action

    @ViewBuilder
    private var action: some View {
        if isOpening {
            ProgressView().tint(Palette.signal)
        } else if let enter = model.enter {
            Button(action: { handler(for: enter)() }) {
                Text(label(for: enter))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 34)
                    .background(Capsule().fill(Palette.signal))
            }
            .buttonStyle(StripButtonStyle())
            .accessibilityIdentifier("activity.strip.enter")
        } else if model.seated, model.phase != .lost {
            Button(action: onReopen) {
                Text("Back to it")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.signal)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 34)
                    .background(Capsule().strokeBorder(Palette.signal.opacity(0.6), lineWidth: 1))
            }
            .buttonStyle(StripButtonStyle())
            .accessibilityIdentifier("activity.strip.reopen")
        }
    }

    private func label(for enter: StripEnter) -> LocalizedStringKey {
        switch enter {
        case .join: "Join"
        case .watch: "Watch"
        case .watchInCall: "See it in the call"
        }
    }

    private func handler(for enter: StripEnter) -> () -> Void {
        enter == .watchInCall ? onWatchInCall : onEnter
    }
}

/// The squircle with the app's glyph and a live dot.
struct ActivityGlyph: View {
    let icon: String
    var live = false
    var breathing = false
    var size: CGFloat = 38

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                .fill(Palette.signal.opacity(0.14))
                .frame(width: size, height: size)
                .overlay(
                    Image(systemName: AppIcon.symbol(icon))
                        .font(.system(size: size * 0.46, weight: .semibold))
                        .foregroundStyle(Palette.signal)
                )
            if live {
                Circle()
                    .fill(Palette.signal)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: 2))
                    .opacity(breathing ? 0.45 : 1)
                    .offset(x: 3, y: -3)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct StripButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

/// The quiet record, for somebody who was in it: one line, one close.
struct ActivityEndedStripView: View {
    let record: EndedActivity
    let appName: String
    let endedByName: String?
    let endedBySelf: Bool
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(appName) ended")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                cause
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("Close")
            .accessibilityIdentifier("activity.ended.close")
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.inkDeep)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("activity.ended")
    }

    @ViewBuilder
    private var cause: some View {
        if let text = record.summary.resultText, !text.isEmpty {
            Text(verbatim: String(text.prefix(200)))
        } else {
            switch record.reason {
            case .host: endedBySelf ? Text("You ended it.") : Text("\(endedByName ?? "?") ended it.")
            case .moderator: Text("A moderator ended it.")
            case .idle: Text("It ended after a while with nobody active.")
            case .hostGone: Text("The host did not come back, so it ended.")
            case .empty: Text("The room was empty, so it ended.")
            case .maxDuration: Text("It reached the 12 hour limit.")
            case .channelGone: Text("The channel was deleted.")
            case .appDisabled, .flagOff, .operator: Text("pqp turned this app off. Your conversation stays here.")
            case .unknown: Text("It ended.")
            }
        }
    }
}
