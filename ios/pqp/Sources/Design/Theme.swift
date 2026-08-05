import SwiftUI

/// The pqp palette, carried over from `client/src/index.css`.
///
/// The web app defines these in oklch; they are converted here to sRGB rather
/// than approximated by eye, so the two clients are the same product rather
/// than two things that look similar.
enum Palette {
    /// oklch(0.16 0.012 250) — the app background.
    static let ink = Color(red: 0.035, green: 0.055, blue: 0.071)
    /// oklch(0.13 0.012 250) — the rail, one step deeper than the ground.
    static let inkDeep = Color(red: 0.020, green: 0.031, blue: 0.047)
    /// oklch(0.20 0.014 250)
    static let surface = Color(red: 0.071, green: 0.094, blue: 0.114)
    /// oklch(0.24 0.016 250)
    static let surfaceRaised = Color(red: 0.110, green: 0.137, blue: 0.161)
    /// oklch(0.30 0.018 250)
    static let border = Color(red: 0.169, green: 0.204, blue: 0.235)

    /// oklch(0.88 0.19 125) — the one loud colour. Used sparingly and never
    /// as a background for long-form text.
    static let signal = Color(red: 0.733, green: 0.925, blue: 0.298)
    static let signalDim = Color(red: 0.573, green: 0.749, blue: 0.208)

    /// oklch(0.93 0.015 95) — warm white, not pure, so it sits on the cool
    /// ground without vibrating.
    static let paper = Color(red: 0.941, green: 0.933, blue: 0.910)
    static let paperMuted = Color(red: 0.714, green: 0.706, blue: 0.686)
    static let paperSubtle = Color(red: 0.827, green: 0.816, blue: 0.796)

    static let danger = Color(red: 0.937, green: 0.325, blue: 0.314)
    static let warning = Color(red: 0.976, green: 0.749, blue: 0.286)
    static let success = Color(red: 0.400, green: 0.831, blue: 0.459)
}

/// Type scale.
///
/// The web app pairs Unbounded (display) with Instrument Sans (body). Neither
/// ships with iOS and bundling two variable fonts for a first build is weight
/// for its own sake, so this maps onto the system faces deliberately: rounded
/// and heavy for display, which is the closest the platform gets to
/// Unbounded's geometric weight, and the default text face for reading.
enum Typography {
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .heavy, design: .rounded)
    }

    static func title(_ size: CGFloat) -> Font {
        .system(size: size, weight: .bold, design: .rounded)
    }

    static let body = Font.system(size: 16, weight: .regular)
    static let bodyMedium = Font.system(size: 16, weight: .medium)
    static let callout = Font.system(size: 14, weight: .regular)
    static let caption = Font.system(size: 12, weight: .medium)

    /// Uppercase section labels. Tracking is applied at the call site with
    /// `.tracking()`, since Font carries no letter spacing.
    static let label = Font.system(size: 11, weight: .semibold)

    static let mono = Font.system(size: 13, design: .monospaced)
}

enum Metrics {
    static let cornerRadius: CGFloat = 12
    static let cornerRadiusSmall: CGFloat = 8
    static let cornerRadiusLarge: CGFloat = 20
    static let hPadding: CGFloat = 16
}

extension View {
    /// The standard raised surface: used for cards, sheets and rows that need
    /// to lift off the ground without a drop shadow doing the work.
    func pqpSurface(cornerRadius: CGFloat = Metrics.cornerRadius) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
    }
}
