import AVKit
import SwiftUI
import UIKit

/**
 WHEN THE CONTROLS ARE ON THE PICTURE, AND WHEN THEY ARE NOT.

 A live watch party has no timeline worth scrubbing, so the chrome is a
 cinema overlay: tap the film to see it, tap again to put it away. While
 the picture is moving the bars hide themselves after a few seconds; while
 it is paused they stay, because that is the moment somebody is looking
 for the play button.

 Pure so the hide rule can be tested without a player. The view owns the
 animation; this only answers visible or not.
 */
struct WatchChromeClock: Equatable {
    static let hideAfter: TimeInterval = 3

    private(set) var visible = true
    private var shownAt = Date.distantPast

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.visible == rhs.visible
    }

    mutating func reveal(at now: Date) {
        visible = true
        shownAt = now
    }

    mutating func tap(at now: Date) {
        if visible {
            visible = false
        } else {
            reveal(at: now)
        }
    }

    /// Playing is what starts the clock. Paused, buffering or connecting
    /// leaves the bars up: hiding them on a still frame is how you lose the
    /// only way back.
    mutating func tick(playing: Bool, at now: Date) {
        guard visible, playing else { return }
        if now.timeIntervalSince(shownAt) >= Self.hideAfter {
            visible = false
        }
    }
}

/// AirPlay from the overlay, not from the system transport bar we no longer
/// draw. Video devices first: a watch party on the TV is the point of this
/// control, a Bluetooth speaker is the fallback.
struct WatchAirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = true
        view.tintColor = UIColor(Palette.paper)
        view.activeTintColor = UIColor(Palette.signal)
        return view
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

/// The cinema overlay: LIVE (or jump back to it), delay, audience, play,
/// quality, AirPlay, PiP, fullscreen. No scrubber. A live window that
/// offers to seek is a control that lies.
struct WatchOverlay<Quality: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let chromeVisible: Bool
    let isPlaying: Bool
    let isTheater: Bool
    let behindLive: Bool
    let delaySeconds: Int?
    let audienceCount: Int
    let audienceLabel: String
    let pipAvailable: Bool
    /// Device safe area, so theater chrome clears the island and the home
    /// indicator. Zero in the inline strip, which is already below the notch.
    var chromeInsets: EdgeInsets = .init()
    let onTogglePlay: () -> Void
    let onJumpToLive: () -> Void
    let onToggleFullscreen: () -> Void
    let onStartPip: () -> Void
    let onCollapse: (() -> Void)?
    @ViewBuilder var qualityMenu: () -> Quality

    private var showTransport: Bool { chromeVisible || !isPlaying }

    var body: some View {
        ZStack {
            cinemaWash
            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0).allowsHitTesting(false)
                if showTransport {
                    playButton
                }
                Spacer(minLength: 0).allowsHitTesting(false)
                bottomBar
            }
            .padding(.leading, isTheater ? max(20, chromeInsets.leading + 8) : 10)
            .padding(.trailing, isTheater ? max(20, chromeInsets.trailing + 8) : 10)
            .padding(.top, isTheater ? max(12, chromeInsets.top + 6) : 8)
            .padding(.bottom, isTheater ? max(16, chromeInsets.bottom + 8) : 8)
        }
        .animation(Motion.standard, value: chromeVisible)
        .animation(Motion.standard, value: isPlaying)
        .animation(Motion.standard, value: behindLive)
    }

    /// Ink fades, not blur. Blur on a film reads as a cheap glass sheet;
    /// a fade is what a cinema does to make the titles readable.
    @ViewBuilder
    private var cinemaWash: some View {
        if showTransport {
            VStack(spacing: 0) {
                LinearGradient(
                    colors: [Color.black.opacity(0.72), Color.black.opacity(0)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: isTheater ? 120 : 72)
                Spacer(minLength: 0)
                LinearGradient(
                    colors: [Color.black.opacity(0), Color.black.opacity(0.78)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: isTheater ? 160 : 88)
            }
            .allowsHitTesting(false)
        }
    }

    private var topBar: some View {
        HStack(alignment: .center, spacing: 8) {
            liveBadge
            if showTransport, let delay = delaySeconds, delay > 0 {
                Text("~\(delay)s delay")
                    .font(Typography.caption)
                    .foregroundStyle(behindLive ? Palette.warning : Palette.paperSubtle)
                    .monospacedDigit()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Color.black.opacity(0.55)))
            }
            Spacer(minLength: 4).allowsHitTesting(false)
            if showTransport {
                audienceChip
            }
            if isTheater {
                WatchGlyphButton(
                    systemName: "xmark",
                    label: "Leave fullscreen",
                    action: onToggleFullscreen
                )
            }
        }
    }

    /// Always on the picture. Claiming AO VIVO a minute behind is the lie
    /// the chat spoils; the lime stamp is the way back.
    @ViewBuilder
    private var liveBadge: some View {
        if behindLive {
            Button(action: onJumpToLive) {
                HStack(spacing: 5) {
                    Image(systemName: "forward.end.alt.fill")
                        .font(.system(size: 9, weight: .bold))
                    Text("Jump to live")
                        .font(Typography.label)
                }
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(Palette.signal))
            }
            .buttonStyle(WatchControlStyle())
        } else {
            HStack(spacing: 6) {
                liveDot
                Text("LIVE")
                    .font(Typography.label)
                    .tracking(1.1)
                    .foregroundStyle(Palette.paper)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Capsule().fill(Color.black.opacity(0.55)))
            .overlay(
                Capsule().strokeBorder(Palette.danger.opacity(0.35), lineWidth: 1)
            )
        }
    }

    @ViewBuilder
    private var liveDot: some View {
        if reduceMotion || !isPlaying {
            Circle()
                .fill(Palette.danger)
                .frame(width: 7, height: 7)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: false)) { context in
                let pulse = 0.55 + 0.45 * sin(context.date.timeIntervalSinceReferenceDate * 3)
                Circle()
                    .fill(Palette.danger)
                    .frame(width: 7, height: 7)
                    .shadow(color: Palette.danger.opacity(0.9), radius: 4)
                    .opacity(pulse)
            }
        }
    }

    private var audienceChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "eye")
                .font(.system(size: 10, weight: .semibold))
            Text(verbatim: "\(audienceCount)")
                .font(Typography.caption)
                .monospacedDigit()
        }
        .foregroundStyle(Palette.paperSubtle)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color.black.opacity(0.55)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(audienceLabel)
    }

    private var playButton: some View {
        Button(action: onTogglePlay) {
            ZStack {
                Circle()
                    .fill(Palette.signal)
                    .frame(width: isTheater ? 76 : 64, height: isTheater ? 76 : 64)
                    .shadow(color: Palette.signal.opacity(0.35), radius: 16, y: 4)
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: isTheater ? 28 : 24, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    // Play triangles look late when geometrically centred.
                    .offset(x: isPlaying ? 0 : 2)
            }
        }
        .buttonStyle(WatchControlStyle())
        .accessibilityLabel(isPlaying ? "Pause the stream" : "Play the stream")
        .opacity(showTransport ? 1 : 0)
        .scaleEffect(showTransport ? 1 : 0.25)
        .blur(radius: showTransport ? 0 : 4)
        .allowsHitTesting(showTransport)
    }

    @ViewBuilder
    private var bottomBar: some View {
        if showTransport {
            HStack(spacing: 6) {
                qualityMenu()
                Spacer(minLength: 8)
                airPlayWell
                if pipAvailable {
                    WatchGlyphButton(
                        systemName: "pip.enter",
                        label: "Picture in Picture",
                        action: onStartPip
                    )
                }
                if !isTheater {
                    WatchGlyphButton(
                        systemName: "arrow.up.left.and.arrow.down.right",
                        label: "Fullscreen",
                        action: onToggleFullscreen
                    )
                    if let onCollapse {
                        WatchGlyphButton(
                            systemName: "chevron.up",
                            label: "Hide the stream",
                            action: onCollapse
                        )
                    }
                }
            }
        }
    }

    private var airPlayWell: some View {
        WatchGlyphWell {
            WatchAirPlayButton()
                .frame(width: 22, height: 22)
        }
        .accessibilityLabel("AirPlay")
    }
}

/// A 44-pt well so a 22-pt glyph still has a real hit target.
struct WatchGlyphButton: View {
    let systemName: String
    let label: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            WatchGlyphWell {
                Image(systemName: systemName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.paper)
            }
        }
        .buttonStyle(WatchControlStyle())
        .accessibilityLabel(label)
    }
}

struct WatchGlyphWell<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(width: 40, height: 40)
            .background(Circle().fill(Color.black.opacity(0.55)))
            .overlay(Circle().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }
}

struct WatchControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

/// Live picture is up, not minimised, no seat. ChatView hides the nav bar
/// chrome so the film sits under the island rather than under a bar.
struct WatchHeroPreference: PreferenceKey {
    nonisolated(unsafe) static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/**
 Portrait everywhere, landscape in the watch theater.

 Info.plist lists landscape so iOS will rotate that cover at all. This lock
 is what stops the rest of the app going with it. iPad already rotates
 and is left alone. `PushDelegate` is the object UIKit asks.
 */
@MainActor
enum WatchOrientation {
    private static var theaterOpen = false

    static var allowed: UIInterfaceOrientationMask {
        if theaterOpen { return .allButUpsideDown }
        if UIDevice.current.userInterfaceIdiom == .pad { return .all }
        return .portrait
    }

    static var safeInsets: EdgeInsets {
        let raw = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .safeAreaInsets ?? .zero
        return EdgeInsets(
            top: raw.top,
            leading: raw.left,
            bottom: raw.bottom,
            trailing: raw.right
        )
    }

    /// The screen in DEVICE PIXELS.
    ///
    /// The theater draws into an `AVPlayerViewController`, which reports no
    /// size to us the way `WatchVideoSurface` does. Without this number the
    /// only surface the quality rule has ever seen is the inline strip, so
    /// opening fullscreen re-asked with the STRIP's pixels and wrote a
    /// ceiling a phone-wide rectangle implies onto a full screen. Portrait
    /// pixels whichever way the phone is held: `resolutionCap` compares one
    /// height against the ladder, and both of this rectangle's sides are
    /// taller than the tallest rung we publish.
    static var screenPixels: CGSize {
        guard let screen = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first?.screen
        else { return .zero }
        return screen.nativeBounds.size
    }

    static func enterTheater() {
        theaterOpen = true
        apply()
    }

    static func leaveTheater() {
        theaterOpen = false
        apply()
    }

    private static func apply() {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first
        else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: allowed)) { _ in }
        scene.windows.first { $0.isKeyWindow }?
            .rootViewController?
            .setNeedsUpdateOfSupportedInterfaceOrientations()
    }
}
