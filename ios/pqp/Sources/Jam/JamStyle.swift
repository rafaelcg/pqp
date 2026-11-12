import SwiftUI
import UIKit

// The look of jam, in the app's own tokens. Nothing here invents a visual
// system: the grounds, borders, type and the lime are `Palette` and
// `Typography`; the only new colours are one per instrument, the same hues as
// the web's `--color-inst-*` tokens (yellow guitar, blue bass, orange drums,
// pink vocals, cyan keys, lilac other).
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
    /// The instrument identity colours, sRGB, converted from the web's tokens
    /// (`--color-inst-*` in `client/src/index.css`, which are oklch). They are
    /// told apart by lightness as well as hue, from the darkest blue to the
    /// lightest yellow, so they hold for somebody who cannot tell the hues
    /// apart. The guitar is a warm yellow and not the app's lime on purpose:
    /// lime is the accent, the colour of every "do this" button, and a lime
    /// guitar lane beside a lime "Gravar" read as one more button.
    /// `JamInstrumentColorTests` converts these back to oklch and compares them
    /// with the web file, so a token that moves there fails here.
    ///
    ///     bass   oklch(0.64 0.15 255)     other  oklch(0.71 0.04 295)
    ///     drums  oklch(0.77 0.15 55)      vocals oklch(0.82 0.12 345)
    ///     keys   oklch(0.87 0.11 195)     guitar oklch(0.92 0.15 90)
    var rgb: (red: Double, green: Double, blue: Double) {
        switch self {
        case .guitar: (1.000, 0.877, 0.381)
        case .bass: (0.275, 0.554, 0.897)
        case .drums: (0.989, 0.595, 0.299)
        case .vocals: (0.987, 0.643, 0.839)
        case .keys: (0.440, 0.921, 0.920)
        case .other: (0.638, 0.616, 0.723)
        }
    }

    var color: Color {
        let c = rgb
        return Color(red: c.red, green: c.green, blue: c.blue)
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

/// HOW A TRACK IS NAMED, in one place. Three facts name a track: its
/// instrument, an optional label its author typed ("take 2, com pedal"), and
/// the person. They always read in that order, separated by a middle dot, and a
/// missing label is simply absent (never an empty slot, and never the label
/// glued onto the name):
///
///     Bass                     (the instrument alone, in a row's first line)
///     take 2, com pedal . Bia  (a row's second line: label, then person)
///     Bass . take 2, com pedal . Bia   (the whole name)
///
/// A chip that stands for several tracks of one instrument names the people
/// instead. VoiceOver says the same thing in words ("Bass, take 2, com pedal,
/// by Bia"). Every place that names a track asks this enum.
enum JamTrackNaming {
    static let separator = " \u{00B7} "

    /// A row's second line: the label, then the person.
    static func caption(_ track: JamTrack) -> String {
        [cleaned(track.label), cleaned(track.authorName)].compactMap { $0 }.joined(separator: separator)
    }

    /// Instrument, label, person.
    static func full(_ track: JamTrack) -> String {
        ([track.instrument.title] + [cleaned(track.label), cleaned(track.authorName)].compactMap { $0 })
            .joined(separator: separator)
    }

    /// What VoiceOver reads.
    static func spoken(_ track: JamTrack) -> String {
        var parts = [track.instrument.title]
        if let label = cleaned(track.label) { parts.append(label) }
        if let person = cleaned(track.authorName) { parts.append(String(localized: "by \(person)")) }
        return parts.joined(separator: ", ")
    }

    /// The song header's chip for one instrument: with a single track it is the
    /// whole name; with several it lists the people (two, then "+N").
    static func chip(instrument: JamInstrument, tracks: [JamTrack]) -> String {
        let mine = tracks.filter { $0.instrument == instrument }
        if mine.count == 1, let only = mine.first { return full(only) }
        var people: [String] = []
        for track in mine {
            if let person = cleaned(track.authorName), !people.contains(person) { people.append(person) }
        }
        var parts = [instrument.title]
        if !people.isEmpty {
            let shown = people.prefix(2).joined(separator: ", ")
            parts.append(people.count > 2 ? "\(shown) +\(people.count - 2)" : shown)
        }
        return parts.joined(separator: separator)
    }

    private static func cleaned(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
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
