import SwiftUI
import UIKit

// The pieces the welcome, the wizard and the hub share: dots, the copy button,
// confetti, the invite panel, the room's "what you can do" row.
//
// DYNAMIC TYPE. The rest of the app sets fixed point sizes (`Typography`), which
// is a choice made for dense chat screens. First run is a handful of sentences
// somebody reads once, often with large text on, so everything here is built
// on text styles and scales with the reader's setting instead.

enum FirstRunType {
    static let display = Font.system(.largeTitle, design: .rounded, weight: .heavy)
    static let title = Font.system(.title, design: .rounded, weight: .heavy)
    static let headline = Font.system(.headline, design: .rounded, weight: .bold)
    static let body = Font.body
    static let callout = Font.callout
    static let footnote = Font.footnote
    static let eyebrow = Font.system(.caption, design: .rounded, weight: .bold)
    static let mono = Font.system(.callout, design: .monospaced, weight: .medium)
}

/// The motion a first-run moment uses, or none when the reader asked for none.
///
/// Reduce Motion keeps fades (they carry no motion) and drops every slide,
/// scale and spring overshoot, which is what the setting is for.
enum FirstRunMotion {
    static func step(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.86)
    }

    static func pop(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.68)
    }

    static func stepTransition(_ reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .offset(x: 36).combined(with: .opacity),
            removal: .offset(x: -24).combined(with: .opacity)
        )
    }
}

// MARK: - Eyebrow, title, description

/// The three lines every step opens with. The eyebrow says where you are, the
/// title asks the question, and the description is the only prose.
struct StepHeading: View {
    let eyebrow: Text
    let title: Text
    let description: Text?
    var eyebrowIcon: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                if let eyebrowIcon {
                    Image(systemName: eyebrowIcon)
                        .imageScale(.small)
                        .accessibilityHidden(true)
                }
                eyebrow
                    .textCase(.uppercase)
                    .tracking(1.1)
            }
            .font(FirstRunType.eyebrow)
            .foregroundStyle(Palette.signal)

            title
                .font(FirstRunType.title)
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if let description {
                description
                    .font(FirstRunType.body)
                    .foregroundStyle(Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Dots

/// Where you are in the walk. The active dot is a pill that slides between
/// positions (one shape, matched across them) rather than a new dot lighting
/// up, so progress reads as movement. Done dots stay half-lit.
struct StepDots: View {
    let index: Int
    let total: Int
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<total, id: \.self) { position in
                ZStack {
                    Capsule()
                        .fill(position < index ? Palette.signal.opacity(0.5) : Palette.border)
                        .frame(width: 7, height: 7)
                    if position == index {
                        Capsule()
                            .fill(Palette.signal)
                            .frame(width: 22, height: 7)
                            .matchedGeometryEffect(id: "active", in: pill)
                    }
                }
                .frame(width: position == index ? 22 : 7, height: 7)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Step \(index + 1) of \(total)"))
        .accessibilityIdentifier("onboarding.dots")
    }
}

// MARK: - Copy

/// Copy to the pasteboard, then say so: the icon turns into a check with a
/// small pop, the label reads "Copied" for 1.6 s, and the phone taps once.
///
/// The pasteboard write cannot fail on iOS the way a browser clipboard can, so
/// "Copied" is always true here; the web's rule (never claim a copy that did
/// not happen) holds by construction.
struct CopyButton: View {
    let text: String
    var label: LocalizedStringKey = "Copy"
    var copiedLabel: LocalizedStringKey = "Copied"
    var prominent = false
    var identifier: String?
    var onCopied: (() -> Void)?

    @State private var copied = false
    @State private var copies = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copies += 1
            onCopied?()
            withAnimation(FirstRunMotion.pop(reduceMotion)) { copied = true }
            let mine = copies
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                guard mine == copies else { return }
                withAnimation(.easeOut(duration: 0.2)) { copied = false }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
                Text(copied ? copiedLabel : label)
                    .contentTransition(.opacity)
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(prominent ? Palette.inkDeep : Palette.paper)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .frame(maxWidth: prominent ? .infinity : nil)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(prominent ? (copied ? Palette.success : Palette.signal) : Palette.surfaceRaised)
            )
            .scaleEffect(copied && !reduceMotion ? 1.02 : 1)
        }
        .buttonStyle(PressableStyle())
        .sensoryFeedback(.success, trigger: copies)
        .accessibilityIdentifier(identifier ?? "copy")
        .accessibilityValue(copied ? Text("Copied") : Text(""))
    }
}

/// A press that depresses rather than dims, for buttons that draw their own
/// background.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

// MARK: - Server icon

/// A room's picture, or its initial on a tile when it has none. Root-relative
/// icon paths are completed against the API the same way avatars are.
struct ServerIconTile: View {
    let name: String
    let iconUrl: String?
    var size: CGFloat = 56

    private var initial: String {
        name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                .fill(Color(hue: Avatar.hue(seed: name), saturation: 0.5, brightness: 0.78))
            Text(initial)
                .font(.system(size: size * 0.44, weight: .heavy, design: .rounded))
                .foregroundStyle(Palette.inkDeep)
            if let url = Avatar.resolve(iconUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.clear
                }
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Feature moments

/// One thing the app does, said in a line. Used a few at a time where they
/// answer a question somebody has right then, never as a slideshow.
struct FeatureMoment: Identifiable {
    let id: String
    let symbol: String
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
}

struct FeatureMomentList: View {
    let moments: [FeatureMoment]
    /// Delay before the first row, so the list lands after the heading.
    var delay: Double = 0.25

    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 38

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: moment.symbol)
                        .font(.system(size: iconSize * 0.45, weight: .semibold))
                        .foregroundStyle(Palette.signal)
                        .symbolEffect(.bounce, value: shown)
                        .frame(width: iconSize, height: iconSize)
                        .background(
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .fill(Palette.signal.opacity(0.12))
                        )
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(moment.title)
                            .font(FirstRunType.headline)
                            .foregroundStyle(Palette.paper)
                        Text(moment.detail)
                            .font(FirstRunType.footnote)
                            .foregroundStyle(Palette.paperMuted)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .opacity(shown ? 1 : 0)
                .offset(y: shown || reduceMotion ? 0 : 14)
                .animation(
                    FirstRunMotion.pop(reduceMotion).delay(delay + Motion.stagger(index, step: 0.09)),
                    value: shown
                )
            }
        }
        .onAppear { shown = true }
    }
}

extension FeatureMoment {
    /// The three that make people switch, from the landing page's own words.
    @MainActor static let welcome: [FeatureMoment] = [
        FeatureMoment(
            id: "voice",
            symbol: "waveform",
            title: "Voice that holds the whole room.",
            detail: "Push-to-talk or voice activation, volume per person."
        ),
        FeatureMoment(
            id: "screen",
            symbol: "rectangle.inset.filled.and.person.filled",
            title: "Screen share with sound.",
            detail: "Whoever is on the phone watches the same share."
        ),
        FeatureMoment(
            id: "watch",
            symbol: "play.tv",
            title: "Watch parties of 100+ people",
            detail: "Same film, same second, one room."
        ),
    ]

    /// What a room that was just made can already do. Shown on the ready step,
    /// which is exactly when "so what now" is the question.
    @MainActor static let inYourRoom: [FeatureMoment] = [
        FeatureMoment(
            id: "text",
            symbol: "number",
            title: "Chat that stays",
            detail: "Replies, threads, GIFs and search."
        ),
        FeatureMoment(
            id: "call",
            symbol: "phone.bubble",
            title: "A voice call that is always open",
            detail: "Tap in, start talking. No scheduling."
        ),
        FeatureMoment(
            id: "share",
            symbol: "rectangle.on.rectangle",
            title: "Share your screen",
            detail: "From the call, with sound. Phones watch too."
        ),
    ]
}

// MARK: - Confetti

/// A burst of confetti, drawn on a canvas and gone in 2.6 s.
///
/// Fires when `trigger` changes (and on appear when it is already non-zero).
/// Under Reduce Motion nothing flies: a still scatter fades in and out, which
/// keeps the moment without the movement.
struct ConfettiBurst: View {
    let trigger: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startedAt: Date?
    @State private var pieces: [Piece] = []

    private static let lifetime: Double = 2.6
    private static let colors: [Color] = [
        Palette.signal, Palette.paper, Palette.warning, Palette.success,
        Color(red: 0.98, green: 0.45, blue: 0.62), Color(red: 0.45, green: 0.72, blue: 1),
    ]

    struct Piece {
        var x: Double
        var y: Double
        var vx: Double
        var vy: Double
        var spin: Double
        var width: Double
        var height: Double
        var color: Color
    }

    var body: some View {
        TimelineView(.animation(paused: startedAt == nil)) { timeline in
            Canvas { context, size in
                guard let startedAt else { return }
                let t = timeline.date.timeIntervalSince(startedAt)
                guard t < Self.lifetime else { return }
                let fade = max(0, 1 - max(0, t - 1.8) / 0.8)
                for piece in pieces {
                    var ctx = context
                    let x: Double
                    let y: Double
                    if reduceMotion {
                        x = piece.x * size.width
                        y = piece.y * size.height
                        ctx.opacity = min(1, t / 0.3) * fade
                    } else {
                        x = piece.x * size.width + piece.vx * t
                        y = piece.y * size.height + piece.vy * t + 0.5 * 1400 * t * t
                        ctx.opacity = fade
                    }
                    ctx.translateBy(x: x, y: y)
                    if !reduceMotion {
                        ctx.rotate(by: .radians(piece.spin * t))
                        ctx.scaleBy(x: 1, y: cos(piece.spin * t * 1.7))
                    }
                    let rect = CGRect(
                        x: -piece.width / 2, y: -piece.height / 2,
                        width: piece.width, height: piece.height
                    )
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(piece.color))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { if trigger > 0 { fire() } }
        .onChange(of: trigger) { _, _ in fire() }
    }

    private func fire() {
        pieces = (0..<110).map { index in
            let fromLeft = index.isMultiple(of: 2)
            if reduceMotion {
                return Piece(
                    x: .random(in: 0.05...0.95), y: .random(in: 0.05...0.5),
                    vx: 0, vy: 0, spin: .random(in: 0...6),
                    width: .random(in: 6...10), height: .random(in: 3...6),
                    color: Self.colors.randomElement()!
                )
            }
            return Piece(
                x: fromLeft ? 0.1 : 0.9,
                y: 0.62,
                vx: (fromLeft ? 1 : -1) * .random(in: 60...420),
                vy: .random(in: -1250 ... -620),
                spin: .random(in: -9...9),
                width: .random(in: 8...13),
                height: .random(in: 3...6),
                color: Self.colors.randomElement()!
            )
        }
        let start = Date()
        startedAt = start
        Task {
            try? await Task.sleep(for: .seconds(Self.lifetime + 0.1))
            if startedAt == start { startedAt = nil }
        }
    }
}

// MARK: - The invite panel

/// "Now bring everyone": the link, one tap to copy it, one tap to hand it to
/// the share sheet, and the two ready-made pastes.
///
/// The same panel closes the wizard's create door, its Discord door and the
/// hub's Discord sheet, so an organizer sees one thing however they got here.
struct ServerReadyPanel: View {
    let invite: Invite?
    let inviteFailed: Bool
    let retrying: Bool
    let onRetry: () -> Void
    /// Set after a Discord import: the line that goes back into Discord.
    var discordServerName: String?

    @State private var paste: InvitePaste = .short
    @State private var linkShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Tagged `discord` after an import, like the web's import dialog, so
    /// "joined through an imported server's invite" stays its own count.
    private var url: URL? {
        invite.map { Onboarding.shareURL(code: $0.code, ref: discordServerName == nil ? Onboarding.inviteRef : "discord") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let url {
                linkBox(url)
                pastes(url)
                if let discordServerName {
                    discordBox(url: url, serverName: discordServerName)
                }
                Label {
                    Text("Good for 7 days, unlimited uses. Change it under Invite people.")
                } icon: {
                    Image(systemName: "clock")
                }
                .font(FirstRunType.footnote)
                .foregroundStyle(Palette.paperMuted)
            } else if inviteFailed {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Couldn't make the link. Try again.")
                        .font(FirstRunType.callout)
                        .foregroundStyle(Palette.danger)
                    Button(action: onRetry) {
                        Text(retrying ? "Saving…" : "Try again")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(retrying)
                    .accessibilityIdentifier("ready.retryInvite")
                }
            } else {
                HStack(spacing: 10) {
                    ProgressView().tint(Palette.signal)
                    Text("Saving…")
                        .font(FirstRunType.callout)
                        .foregroundStyle(Palette.paperMuted)
                }
                .frame(maxWidth: .infinity, minHeight: 88)
            }
        }
    }

    private func linkBox(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Invite link")
                .font(FirstRunType.eyebrow)
                .textCase(.uppercase)
                .tracking(1)
                .foregroundStyle(Palette.paperMuted)

            Text(url.absoluteString)
                .font(FirstRunType.mono)
                .foregroundStyle(Palette.paper)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .accessibilityIdentifier("ready.link")

            HStack(spacing: 10) {
                CopyButton(
                    text: url.absoluteString,
                    label: "Copy link",
                    prominent: true,
                    identifier: "ready.copyLink"
                )
                ShareLink(item: url, message: Text(InvitePaste.short.text(url: url))) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.paper)
                        .frame(width: 48, height: 44)
                        .background(
                            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                                .fill(Palette.surfaceRaised)
                        )
                }
                .accessibilityLabel(Text("Share"))
                .accessibilityIdentifier("ready.share")
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.signal.opacity(0.45), lineWidth: 1)
        )
        .scaleEffect(linkShown || reduceMotion ? 1 : 0.96)
        .opacity(linkShown ? 1 : 0)
        .onAppear {
            withAnimation(FirstRunMotion.pop(reduceMotion).delay(0.1)) { linkShown = true }
        }
    }

    private func pastes(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Bring the crew")
                    .font(FirstRunType.headline)
                    .foregroundStyle(Palette.paper)
                Spacer()
                Picker(selection: $paste) {
                    Text("Short").tag(InvitePaste.short)
                    Text("Long").tag(InvitePaste.long)
                } label: {
                    Text("Bring the crew")
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .accessibilityIdentifier("ready.pasteKind")
            }

            Text(paste.text(url: url))
                .font(FirstRunType.callout)
                .foregroundStyle(Palette.paperSubtle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                        .fill(Palette.inkDeep)
                )
                .animation(.easeInOut(duration: 0.18), value: paste)

            HStack(spacing: 10) {
                CopyButton(text: paste.text(url: url), identifier: "ready.copyPaste")
                ShareLink(item: paste.text(url: url)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(
                            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                                .fill(Palette.surfaceRaised)
                        )
                }
                .accessibilityIdentifier("ready.sharePaste")
                Spacer(minLength: 0)
            }

            Text("Opens in the browser. On a phone you can join voice and watch other people's screens.")
                .font(FirstRunType.footnote)
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func discordBox(url: URL, serverName: String) -> some View {
        let text = InvitePaste.discord(serverName: serverName, url: url)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Text you can paste in Discord")
                .font(FirstRunType.headline)
                .foregroundStyle(Palette.paper)
            Text(text)
                .font(FirstRunType.callout)
                .foregroundStyle(Palette.paperSubtle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                        .fill(Palette.inkDeep)
                )
            CopyButton(text: text, label: "Copy text", identifier: "ready.copyDiscord")
        }
    }
}

// MARK: - The invitee's arrival

/// "You're in {server}", over the room they just walked into, with the
/// confetti the organizer got on their ready step. One per account per run.
struct ArrivalToast: View {
    let celebration: ArrivalCelebration
    let onDismiss: () -> Void

    @State private var burst = 0
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .top) {
            ConfettiBurst(trigger: burst)
                .ignoresSafeArea()

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "party.popper.fill")
                    .font(.title3)
                    .foregroundStyle(Palette.signal)
                    .symbolEffect(.bounce, value: burst)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("You're in \(celebration.serverName)")
                        .font(FirstRunType.headline)
                        .foregroundStyle(Palette.paper)
                    Text("Pick a channel and say oi. Nobody knows you're here until you do.")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Text("Got it")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background(Capsule().fill(Palette.signal))
                }
                .buttonStyle(PressableStyle())
                .accessibilityIdentifier("arrival.dismiss")
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                    .fill(Palette.surfaceRaised)
                    .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                    .strokeBorder(Palette.signal.opacity(0.35), lineWidth: 1)
            )
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 8)
            .offset(y: shown || reduceMotion ? 0 : -24)
            .opacity(shown ? 1 : 0)
            .accessibilityElement(children: .contain)
        }
        .sensoryFeedback(.success, trigger: burst)
        .onAppear {
            withAnimation(FirstRunMotion.pop(reduceMotion)) { shown = true }
            burst += 1
            UIAccessibility.post(
                notification: .announcement,
                argument: String(localized: "You're in \(celebration.serverName)")
            )
        }
        .task {
            try? await Task.sleep(for: .seconds(7))
            onDismiss()
        }
    }
}
