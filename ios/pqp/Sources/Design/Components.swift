import SwiftUI

/// The primary action. Signal-on-ink, which is the one place the loud colour
/// carries a whole surface.
struct PrimaryButtonStyle: ButtonStyle {
    var isEnabled: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.bodyMedium)
            .foregroundStyle(Palette.inkDeep)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(isEnabled ? Palette.signal : Palette.surfaceRaised)
            )
            .opacity(isEnabled ? 1 : 0.6)
            // Scale rather than opacity for the press: on a dark ground an
            // opacity dip reads as the button breaking rather than depressing.
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.bodyMedium)
            .foregroundStyle(Palette.paper)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(Palette.surfaceRaised)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

/// Motion vocabulary.
///
/// One spring for interface transitions and one, snappier, for touch feedback.
/// Two curves used consistently read as intentional; a different duration per
/// call site reads as noise.
enum Motion {
    static let standard = Animation.spring(response: 0.42, dampingFraction: 0.82)
    static let gentle = Animation.spring(response: 0.6, dampingFraction: 0.9)
    static let press = Animation.spring(response: 0.22, dampingFraction: 0.7)

    /// Staggered entrance delay. Capped so a long list does not turn the
    /// last row's arrival into a wait.
    static func stagger(_ index: Int, step: Double = 0.06, cap: Double = 0.5) -> Double {
        min(Double(index) * step, cap)
    }
}

/// A monogram avatar. Colour is derived from the identifier so the same person
/// is the same colour everywhere without the server sending one.
struct Avatar: View {
    let name: String
    let seed: String
    var size: CGFloat = 40
    var isSpeaking: Bool = false
    /// A real avatar when the account has one; the monogram is the fallback,
    /// not the feature. Passed as the raw string the API sent — a nil or junk
    /// URL just means the monogram shows, never a broken frame.
    var url: String? = nil

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    /// Static so anything else that wants to be "this person's colour" — the
    /// banner on their profile, for one — derives the same hue from the same id
    /// rather than picking its own and drifting.
    static func hue(seed: String) -> Double {
        // Stable, cheap, and evenly spread — a plain sum clusters similar ids.
        var hash: UInt64 = 5381
        for byte in seed.utf8 {
            hash = (hash &* 33) &+ UInt64(byte)
        }
        return Double(hash % 360) / 360
    }

    private var hue: Double { Avatar.hue(seed: seed) }

    private var imageUrl: URL? {
        guard let url, let parsed = URL(string: url),
              parsed.scheme == "https" || parsed.scheme == "http" else { return nil }
        return parsed
    }

    var body: some View {
        ZStack {
            monogram
            if let imageUrl {
                AsyncImage(url: imageUrl) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    // The monogram underneath is the placeholder.
                    Color.clear
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
            }
        }
        .overlay(
            Circle()
                .strokeBorder(Palette.signal, lineWidth: isSpeaking ? 2.5 : 0)
                .padding(-3)
        )
        .animation(Motion.standard, value: isSpeaking)
    }

    private var monogram: some View {
        Text(initials)
            .font(.system(size: size * 0.38, weight: .bold, design: .rounded))
            .foregroundStyle(Palette.inkDeep)
            .frame(width: size, height: size)
            .background(
                Circle().fill(
                    Color(hue: hue, saturation: 0.55, brightness: 0.82)
                )
            )
    }
}

/// Uppercase section heading, matching the web sidebar's rhythm.
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(Typography.label)
            .tracking(1.2)
            .foregroundStyle(Palette.paperMuted)
    }
}

/// Shown wherever a list can legitimately be empty. Empty states are a place
/// products usually say nothing; saying something specific is most of the
/// difference between "broken" and "ready".
struct EmptyState: View {
    let icon: String
    /// Keys, not strings — the literals at call sites are what the string
    /// catalog translates, and a `String` parameter silently opts out of that.
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Palette.paperMuted)

            Text(title)
                .font(Typography.title(20))
                .foregroundStyle(Palette.paper)
                .multilineTextAlignment(.center)

            Text(message)
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(maxWidth: 220)
                    .padding(.top, 4)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }
}

/// Three dots that rise in sequence — the same typing motif as the app icon.
struct TypingDots: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Palette.paperMuted)
                    .frame(width: 5, height: 5)
                    .offset(y: offset(for: index))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func offset(for index: Int) -> CGFloat {
        // The per-dot delay comes from sampling the same phase at three points
        // rather than three animations, which keeps them locked together.
        let shifted = phase - Double(index) * 0.18
        return -3 * CGFloat(max(0, sin(shifted * .pi)))
    }
}
