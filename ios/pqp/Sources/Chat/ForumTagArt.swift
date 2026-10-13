import SwiftUI

/// What a forum tag looks like and what it is called on this phone.
///
/// The wire carries an icon KEY from a curated set (`FORUM_TAG_ICONS` in
/// `packages/shared/src/forums.ts`); this maps each key to an SF Symbol. A key
/// this build has never heard of draws as the tag's legacy emoji, and a tag
/// with neither draws nothing, so a newer server never breaks an older phone.
///
/// A starter tag also carries a `preset` key. While it is set the tag shows the
/// phone's own language ("Dúvida", "Question") whatever language staff typed
/// the stored name in; the server clears it when staff rename the tag.
enum ForumTagIcons {
    /// Every key the shared set names. The test reads the shared file and fails
    /// when a key is added there and not here.
    static let symbols: [String: String] = [
        "question": "questionmark.circle",
        "help": "lifepreserver",
        "bug": "ladybug",
        "idea": "lightbulb",
        "feedback": "text.bubble",
        "discussion": "bubble.left.and.bubble.right",
        "poll": "chart.bar.xaxis",
        "announcement": "megaphone",
        "news": "newspaper",
        "release": "shippingbox",
        "update": "arrow.triangle.2.circlepath",
        "wip": "wrench.and.screwdriver",
        "code": "chevron.left.forwardslash.chevron.right",
        "guide": "book",
        "rules": "doc.text",
        "solved": "checkmark.circle",
        "warning": "exclamationmark.triangle",
        "security": "lock",
        "pinned": "pin",
        "event": "calendar",
        "showcase": "sparkles",
        "art": "paintpalette",
        "photo": "camera",
        "video": "video",
        "clip": "film",
        "stream": "tv",
        "music": "music.note",
        "game": "gamecontroller",
        "meme": "face.smiling",
        "offtopic": "cup.and.saucer",
        "community": "person.2",
        "gift": "gift",
        "trophy": "trophy",
        "hot": "flame",
        "star": "star",
        "heart": "heart",
        "link": "link",
    ]

    static func symbol(for key: String?) -> String? {
        key.flatMap { symbols[$0] }
    }
}

enum ForumTagPresets {
    /// The starter tag's name in the phone's language, or nil for a tag with no
    /// preset (or one this build does not know), which keeps its stored name.
    static func localizedName(_ preset: String?) -> String? {
        switch preset {
        case "question": return String(localized: "forum.tags.preset.question")
        case "bug": return String(localized: "forum.tags.preset.bug")
        case "suggestion": return String(localized: "forum.tags.preset.suggestion")
        case "tutorial": return String(localized: "forum.tags.preset.tutorial")
        case "release": return String(localized: "forum.tags.preset.release")
        case "wip": return String(localized: "forum.tags.preset.wip")
        case "discussion": return String(localized: "forum.tags.preset.discussion")
        default: return nil
        }
    }
}

extension ForumTag {
    /// What the tag is called on this screen. Accessibility identifiers keep
    /// using the stored `name`, which does not change with the language.
    var displayName: String {
        ForumTagPresets.localizedName(preset) ?? name
    }
}

/// The picture at the start of a tag chip: the icon when there is one, the
/// emoji an older row still carries when there is not, nothing otherwise.
/// Decorative: the name beside it says everything.
struct ForumTagGlyph: View {
    let tag: ForumTag
    var size: CGFloat = 12

    var body: some View {
        if let symbol = ForumTagIcons.symbol(for: tag.icon) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .accessibilityHidden(true)
        } else if let emoji = tag.emoji, !emoji.isEmpty {
            Text(verbatim: emoji)
                .font(.system(size: size))
                .accessibilityHidden(true)
        }
    }
}
