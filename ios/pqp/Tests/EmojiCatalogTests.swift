import XCTest
@testable import pqp

/// The emoji sheet's search.
///
/// Pure and cheap to test, and the failure modes are all silent: a search that
/// returns nothing looks like an empty catalog, and one that returns everything
/// looks like search is not wired up at all.
/// `@MainActor` for one reason: `ChatModel.quickReactions` is a static on a
/// main-actor class, and Swift 6 will not let a nonisolated test read it.
@MainActor
final class EmojiCatalogTests: XCTestCase {
    func testBlankSearchIsNoFilterRatherThanNoResults() {
        XCTAssertEqual(EmojiCatalog.search("").count, EmojiCatalog.all.count)
        XCTAssertEqual(EmojiCatalog.search("   ").count, EmojiCatalog.all.count)
    }

    func testSearchMatchesByName() {
        XCTAssertEqual(EmojiCatalog.search("fire").map(\.emoji), ["🔥"])
        XCTAssertTrue(EmojiCatalog.search("laugh").map(\.emoji).contains("😂"))
    }

    /// Prefixes, not substrings: on a list this short a substring match returns
    /// half the catalog for two letters, which is the same as no search.
    func testSearchMatchesWordPrefixesOnly() {
        XCTAssertTrue(EmojiCatalog.search("he").map(\.emoji).contains("❤️"),
                      "'he' should reach 'heart'")
        XCTAssertFalse(EmojiCatalog.search("eart").map(\.emoji).contains("❤️"),
                       "A mid-word match would make short queries useless")
    }

    /// Every term has to match, so a second word narrows.
    func testMultipleTermsNarrow() {
        let wide = EmojiCatalog.search("smile")
        let narrow = EmojiCatalog.search("smile tear")
        XCTAssertGreaterThan(wide.count, narrow.count)
        XCTAssertEqual(narrow.map(\.emoji), ["🥲"])
    }

    func testSearchIsCaseInsensitive() {
        XCTAssertEqual(EmojiCatalog.search("FIRE").map(\.emoji), ["🔥"])
    }

    func testUnknownTermFindsNothing() {
        XCTAssertTrue(EmojiCatalog.search("zzzz").isEmpty)
    }

    /// Pasting the emoji itself should find it — the sheet is also how people
    /// check "do we have this one".
    func testTheEmojiItselfIsSearchable() {
        XCTAssertEqual(EmojiCatalog.search("🚀").map(\.emoji), ["🚀"])
    }

    /// Every quick reaction offered on the long-press row must also exist in
    /// the full picker, or the "+" tail leads somewhere that cannot repeat what
    /// the row just offered.
    func testQuickReactionsAreAllInTheCatalog() {
        let catalog = Set(EmojiCatalog.all.map(\.emoji))
        for emoji in ChatModel.quickReactions {
            XCTAssertTrue(catalog.contains(emoji), "\(emoji) is offered but not in the picker")
        }
    }

    /// Six is what fits one row on the narrowest phone alongside the "+" tail.
    /// This is a layout invariant, not a preference: seven wraps, and wrapping
    /// is the bug the custom overlay was built to fix.
    func testQuickReactionsFitOneRow() {
        XCTAssertLessThanOrEqual(ChatModel.quickReactions.count, 6)
        XCTAssertEqual(Set(ChatModel.quickReactions).count, ChatModel.quickReactions.count,
                       "A duplicated quick reaction would break the ForEach identity")
    }
}
