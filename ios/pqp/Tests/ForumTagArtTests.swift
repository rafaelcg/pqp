import XCTest
import UIKit
@testable import pqp

/// A forum tag's icon and its starter name on the phone. The wire shape is
/// `forumTagSchema` in `packages/shared/src/forums.ts`: `icon` and `preset` are
/// optional and nullable, a key the phone has never heard of must not break the
/// list, and the emoji stays the fallback.
final class ForumTagArtTests: XCTestCase {

    private func decode(_ json: String) throws -> ForumTag {
        try Coding.decoder.decode(ForumTag.self, from: Data(json.utf8))
    }

    private let base = #""id":"t1","name":"Question","emoji":"❓","moderated":false,"position":0,"postCount":3"#

    // MARK: - Wire

    func testATagFromAnOlderServerHasNoIconAndNoPreset() throws {
        let tag = try decode("{\(base)}")
        XCTAssertNil(tag.icon)
        XCTAssertNil(tag.preset)
        XCTAssertEqual(tag.displayName, "Question", "no preset keeps the stored name")
        XCTAssertEqual(tag.emoji, "❓")
    }

    func testNullAndForeignValuesDoNotBreakTheTag() throws {
        let nulls = try decode(#"{\#(base),"icon":null,"preset":null}"#)
        XCTAssertNil(nulls.icon)
        XCTAssertNil(nulls.preset)
        // A wrong type is "no icon", never a failed list.
        let wrong = try decode(#"{\#(base),"icon":7,"preset":{"a":1}}"#)
        XCTAssertNil(wrong.icon)
        XCTAssertNil(wrong.preset)
        // An unknown field is ignored.
        let extra = try decode(#"{\#(base),"icon":"bug","preset":"bug","tint":"red"}"#)
        XCTAssertEqual(extra.icon, "bug")
    }

    func testAKeyFromANewerServerFallsBackToTheEmoji() throws {
        let tag = try decode(#"{\#(base),"icon":"hologram","preset":"brand-new"}"#)
        XCTAssertEqual(tag.icon, "hologram")
        XCTAssertNil(ForumTagIcons.symbol(for: tag.icon), "no symbol: the glyph view draws the emoji")
        XCTAssertEqual(tag.displayName, "Question", "an unknown preset keeps the stored name")
    }

    // MARK: - Icons

    /// The shared list is the contract: a key added there and not mapped here
    /// would draw as a bare emoji on the phone, silently.
    func testEverySharedIconKeyHasASymbolThatExists() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)   // …/ios/pqp/Tests/…
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("packages/shared/src/forums.ts"),
            encoding: .utf8
        )
        let block = try XCTUnwrap(source.range(of: "export const FORUM_TAG_ICONS = ["))
        let end = try XCTUnwrap(source.range(of: "] as const;", range: block.upperBound..<source.endIndex))
        let list = source[block.upperBound..<end.lowerBound]
        let keys = list.split(separator: "\n").compactMap { line -> String? in
            guard let start = line.range(of: #"key: ""#), let stop = line.range(of: #"", emoji"#) else { return nil }
            return String(line[start.upperBound..<stop.lowerBound])
        }
        XCTAssertGreaterThanOrEqual(keys.count, 24)
        for key in keys {
            let symbol = try XCTUnwrap(ForumTagIcons.symbol(for: key), "no SF Symbol for the shared icon \"\(key)\"")
            XCTAssertNotNil(UIImage(systemName: symbol), "\"\(symbol)\" is not an SF Symbol on this OS (\(key))")
        }
        XCTAssertEqual(Set(keys), Set(ForumTagIcons.symbols.keys), "the phone maps a key the shared list no longer has")
        XCTAssertEqual(Set(ForumTagIcons.symbols.values).count, ForumTagIcons.symbols.count, "two icons share one symbol")
    }

    // MARK: - Presets

    func testAStarterReadsInThePhonesLanguageAndARenamedTagKeepsItsName() throws {
        let starter = try decode(#"{\#(base),"icon":"question","preset":"question"}"#)
        // Whatever the test device's language, it is the catalogue's word.
        XCTAssertEqual(starter.displayName, String(localized: "forum.tags.preset.question"))
        XCTAssertNotEqual(starter.displayName, "forum.tags.preset.question", "the key must be in the catalogue")
        let renamed = ForumTag(id: "t2", name: "Pergunte", preset: nil)
        XCTAssertEqual(renamed.displayName, "Pergunte")
    }

    func testEveryPresetHasAWordInPortugueseAndEnglish() throws {
        for preset in ["question", "bug", "suggestion", "tutorial", "release", "wip", "discussion"] {
            let name = try XCTUnwrap(ForumTagPresets.localizedName(preset), preset)
            XCTAssertFalse(name.isEmpty)
            XCTAssertFalse(name.hasPrefix("forum.tags.preset."), "\(preset) is missing from the catalogue")
        }
        XCTAssertNil(ForumTagPresets.localizedName(nil))
        XCTAssertNil(ForumTagPresets.localizedName("nope"))
    }
}
