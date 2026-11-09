import SwiftUI
import UIKit

// The look of jam, in the app's own tokens. Nothing here invents a visual
// system: the grounds, borders, type and the lime are `Palette` and
// `Typography`; the only new colours are one per instrument, taken from the
// approved design (`JamNoApp`: lime guitar, blue bass, orange drums, pink
// voice) with a teal for keys and a warm grey for "other".
//
// The app is dark everywhere (`PqpApp` pins `.preferredColorScheme(.dark)`),
// so these are dark-ground colours: tiles are the instrument's colour with
// ink text on them, and everything else sits on `Palette.ink` / `surface`.

/// Type that follows the reader's Dynamic Type size. The app's own rows use
/// fixed point sizes; jam is new and reads long titles on small tiles, so it
/// scales (`UIFontMetrics`), capped at 1.6x so a tile never outgrows its cell
/// beyond what `minimumScaleFactor` and the layout's wrapping can absorb.
enum JamFont {
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular, rounded: Bool = false) -> Font {
        scaled(size, weight: weight, rounded: rounded)
    }

    static func title(_ size: CGFloat) -> Font {
        scaled(size, weight: .bold, rounded: true)
    }

    private static func scaled(_ size: CGFloat, weight: Font.Weight, rounded: Bool) -> Font {
        let uiWeight = UIFont.Weight(rawValue: weightValue(weight))
        var base = UIFont.systemFont(ofSize: size, weight: uiWeight)
        if rounded, let descriptor = base.fontDescriptor.withDesign(.rounded) {
            base = UIFont(descriptor: descriptor, size: size)
        }
        let metrics = UIFontMetrics(forTextStyle: size >= 20 ? .title3 : .body)
        return Font(metrics.scaledFont(for: base, maximumPointSize: size * 1.6))
    }

    private static func weightValue(_ weight: Font.Weight) -> CGFloat {
        switch weight {
        case .ultraLight: UIFont.Weight.ultraLight.rawValue
        case .thin: UIFont.Weight.thin.rawValue
        case .light: UIFont.Weight.light.rawValue
        case .medium: UIFont.Weight.medium.rawValue
        case .semibold: UIFont.Weight.semibold.rawValue
        case .bold: UIFont.Weight.bold.rawValue
        case .heavy: UIFont.Weight.heavy.rawValue
        case .black: UIFont.Weight.black.rawValue
        default: UIFont.Weight.regular.rawValue
        }
    }
}

extension JamInstrument {
    var color: Color {
        switch self {
        case .guitar: Palette.signal
        case .bass: Color(red: 0.49, green: 0.72, blue: 0.95)
        case .drums: Color(red: 0.95, green: 0.64, blue: 0.29)
        case .vocals: Color(red: 0.91, green: 0.64, blue: 0.84)
        case .keys: Color(red: 0.44, green: 0.82, blue: 0.80)
        case .other: Color(red: 0.80, green: 0.78, blue: 0.70)
        }
    }

    /// "guitar", for the middle of a sentence ("needs guitar").
    var name: String {
        switch self {
        case .guitar: String(localized: "guitar")
        case .bass: String(localized: "bass")
        case .drums: String(localized: "drums")
        case .vocals: String(localized: "vocals")
        case .keys: String(localized: "keys")
        case .other: String(localized: "other")
        }
    }

    /// "Guitar", for a label that starts a line.
    var title: String { name.localizedCapitalized }
}

extension JamNeed {
    /// The words on a tile: "falta voz", "qualquer um entra", "pronta".
    var text: String {
        switch self {
        case .missing(let instruments):
            let list = ListFormatter.localizedString(byJoining: instruments.map(\.name))
            return String(localized: "needs \(list)")
        case .open:
            return String(localized: "anyone can join")
        case .ready:
            return String(localized: "ready")
        case .empty:
            return String(localized: "no takes yet")
        }
    }

    /// Lime when somebody is wanted, so the eye finds the songs that need
    /// you; quiet otherwise.
    var isCallout: Bool {
        if case .missing = self { return true }
        return false
    }
}

enum JamTime {
    /// 2:14, the way the design writes it. Tabular, so a running clock does
    /// not shimmer.
    static func clock(_ ms: Double) -> String {
        let total = max(0, Int((ms / 1000).rounded(.down)))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// The wall's and the song's one spring, and nil under Reduce Motion.
extension Animation {
    static func jam(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.82)
    }

    static func jamQuick(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.78)
    }
}

// MARK: - Waveform

/// Bars across a width, from 0...1 values (the server's `peaks`, resampled).
/// `draw` is how much of the row has been drawn in (0 to 1) for the entrance,
/// `played` colours the bars up to a fraction in `playedColor`, and `dim`
/// fades a span (a trimmed head or tail) without removing it, so a trim reads
/// as a trim and not as missing audio.
struct JamWaveform: View {
    let values: [Double]
    var color: Color
    var playedColor: Color?
    var played: Double = 0
    var draw: Double = 1
    var dimBefore: Double = 0
    var dimAfter: Double = 1
    var barWidth: CGFloat = 3
    var gap: CGFloat = 2
    var minHeight: CGFloat = 3

    var body: some View {
        Canvas { context, size in
            let step = barWidth + gap
            let count = max(1, Int((size.width + gap) / step))
            let source = values.isEmpty ? Array(repeating: 0.0, count: count) : values
            for i in 0..<count {
                let x = CGFloat(i) * step
                let fraction = (Double(i) + 0.5) / Double(count)
                // Resample by taking the loudest value in this bar's span, so
                // a short transient is not averaged away.
                let lo = Int(Double(i) / Double(count) * Double(source.count))
                let hi = max(lo + 1, Int(Double(i + 1) / Double(count) * Double(source.count)))
                let peak = source[min(lo, source.count - 1)..<min(hi, source.count)].max() ?? 0
                let eased = pow(min(1, max(0, peak)), 0.7)
                let height = max(minHeight, CGFloat(eased) * size.height) * CGFloat(min(1, max(0, draw * 1.4 - fraction * 0.4)))
                let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
                var tint = (playedColor != nil && fraction <= played) ? playedColor! : color
                if fraction < dimBefore || fraction > dimAfter { tint = tint.opacity(0.28) }
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(tint))
            }
        }
        .accessibilityHidden(true)
    }
}
