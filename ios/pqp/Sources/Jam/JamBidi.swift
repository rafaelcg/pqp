import Foundation

/// Text a person wrote, drawn inside the app's own sentence.
///
/// A song's title, an artist, a take's label and a display name are typed by
/// strangers. The Unicode bidi algorithm lets one character change how the
/// text AFTER it is laid out: an unclosed right-to-left override (U+202E) in an
/// artist turns "Artista . Gabi" into "ibaG . atsitrA". The server strips the
/// override, embedding and isolate controls from new titles, artists and labels
/// (`cleanLine` in `packages/shared/src/jam.ts`), but a row written before that
/// still holds them, and a display name comes from an account, so a screen
/// cannot rely on the server alone.
///
/// This is the same helper the web has (`client/src/lib/bidi.ts`), with the
/// same character set and the same behaviour, so the three clients agree:
///
///  - `isolate` for a string that is joined to other text and DRAWN: first
///    strong isolate characters (U+2068 ... U+2069) around it, after the
///    explicit controls are dropped from inside it (a U+2069 in the text would
///    close the isolate early);
///  - `clean` for a string that stands alone in its own view, or that a screen
///    reader speaks (VoiceOver reads in logical order, so it needs no isolate
///    and never has to meet the isolate characters). `clean(isolate(x))` is
///    `clean(x)`, so a composed line that already holds isolates can be cleaned
///    for VoiceOver in one go.
///
/// Honest right-to-left text, joiners (U+200C, U+200D: emoji family sequences,
/// Persian) and the implicit marks (U+200E, U+200F, U+061C) are not touched.
enum JamBidi {
    static let firstStrongIsolate = "\u{2068}"
    static let popIsolate = "\u{2069}"

    /// Override and embedding controls (U+202A to U+202E) and isolate controls
    /// (U+2066 to U+2069). Compared by scalar so a combining mark after one
    /// cannot hide it inside a grapheme cluster.
    private static func isExplicitControl(_ scalar: Unicode.Scalar) -> Bool {
        (0x202A...0x202E).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value)
    }

    /// The text without bidi override, embedding and isolate controls.
    static func clean(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars where !isExplicitControl(scalar) {
            scalars.append(scalar)
        }
        return String(scalars)
    }

    /// The text as a self-contained unit for a string: nothing in it can
    /// reorder what is around it, and nothing around it reorders it. Empty
    /// stays empty (two invisible characters in an otherwise empty slot would
    /// still be a slot).
    static func isolate(_ text: String) -> String {
        let stripped = clean(text)
        return stripped.isEmpty ? "" : firstStrongIsolate + stripped + popIsolate
    }

    /// `isolate` for a value that may be absent.
    static func isolateOpt(_ text: String?) -> String {
        guard let text else { return "" }
        return isolate(text)
    }
}
