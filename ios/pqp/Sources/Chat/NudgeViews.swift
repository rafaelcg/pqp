import SwiftUI
import UIKit

/// A nudge in the transcript: not a bubble, a line in the middle. "Lu chamou
/// tua atenção!" for one received, "Tu chamou a atenção de Lu." for one sent,
/// with its time. A fresh one slides in and its icon rattles once; one read
/// out of history just sits there, the same rule that keeps the screen from
/// shaking on a reload. Delete (mine) and report (theirs) stay on the long
/// press, like any message.
struct NudgeLine: View {
    let message: Message
    let mine: Bool
    /// The sender for theirs, the other person for mine.
    let name: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var wiggle = false
    @State private var appeared = false

    private var isFresh: Bool {
        abs(Date().timeIntervalSince(message.createdAt)) < NudgeRules.freshWindow
    }

    var body: some View {
        let text = NudgeRules.lineText(mine: mine, name: name)
        HStack(spacing: 7) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.warning)
                .rotationEffect(.degrees(wiggle ? 14 : 0))
            Text(verbatim: text)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperSubtle)
                .lineLimit(1)
            Text(message.createdAt, format: .dateTime.hour().minute())
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Palette.surface))
        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 6)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: text))
        .accessibilityIdentifier("chat.nudgeLine")
        .onAppear {
            guard isFresh, !reduceMotion else {
                appeared = true
                return
            }
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { appeared = true }
            withAnimation(.interpolatingSpring(stiffness: 600, damping: 6).delay(0.1)) { wiggle = true }
            Task {
                try? await Task.sleep(for: .milliseconds(260))
                withAnimation(.interpolatingSpring(stiffness: 300, damping: 10)) { wiggle = false }
            }
        }
    }
}

/// The physical half of a nudge received.
@MainActor
enum NudgeFeedback {
    /// The screen shakes side to side and settles on a UIKit spring, the way
    /// MSN shook the conversation window. Applied to the key window's root
    /// view, so the navigation bar shakes with the transcript.
    static func shake() {
        guard let view = keyRootView() else { return }
        view.layer.removeAllAnimations()
        view.transform = CGAffineTransform(translationX: 18, y: 0)
        UIView.animate(
            withDuration: 0.7,
            delay: 0,
            usingSpringWithDamping: 0.16,
            initialSpringVelocity: 14,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            view.transform = .identity
        }
    }

    /// A buzz, for the phone in the hand. Not motion, so Reduce Motion keeps it.
    static func buzz() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.warning)
    }

    private static func keyRootView() -> UIView? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        return window?.rootViewController?.view
    }
}

/// Reduce Motion's nudge: the screen's edge pulses amber twice instead of the
/// screen moving. Driven by a counter so each nudge pulses once.
struct NudgeBorderPulse: View {
    let trigger: Int
    @State private var lit = false

    var body: some View {
        RoundedRectangle(cornerRadius: 44, style: .continuous)
            .strokeBorder(Palette.warning, lineWidth: 5)
            .opacity(lit ? 0.9 : 0)
            .onChange(of: trigger) { _, _ in
                Task {
                    for _ in 0..<2 {
                        withAnimation(.easeOut(duration: 0.18)) { lit = true }
                        try? await Task.sleep(for: .milliseconds(260))
                        withAnimation(.easeIn(duration: 0.3)) { lit = false }
                        try? await Task.sleep(for: .milliseconds(320))
                    }
                }
            }
            .accessibilityHidden(true)
    }
}
