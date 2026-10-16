import XCTest
@testable import pqp

/// Custom server emoji in a message body: the token grammar of
/// `packages/shared/src/server-emoji.ts` and what a phone makes of it.
final class CustomEmojiTests: XCTestCase {
    private let id = "1b2c3d4e-0000-4000-8000-aaaaaaaaaaaa"
    private let other = "99999999-0000-4000-8000-bbbbbbbbbbbb"

    func testABodyWithNoTokenIsUntouched() {
        let prepared = CustomEmoji.prepare("oi **gente**, tudo bem?")
        XCTAssertEqual(prepared.text, "oi **gente**, tudo bem?")
        XCTAssertTrue(prepared.tokens.isEmpty)
    }

    func testEveryTokenBecomesAStandInInOrder() {
        let prepared = CustomEmoji.prepare("a <:party:\(id)> b <:kek_2:\(other)> c")
        XCTAssertEqual(prepared.text, "a \u{E000} b \u{E000} c")
        XCTAssertEqual(prepared.tokens, [
            CustomEmoji.Token(name: "party", id: id),
            CustomEmoji.Token(name: "kek_2", id: other),
        ])
    }

    func testAnEmojiAloneAndTwoInARow() {
        XCTAssertEqual(CustomEmoji.prepare("<:party:\(id)>").text, "\u{E000}")
        XCTAssertEqual(CustomEmoji.prepare("<:party:\(id)><:party:\(id)>").tokens.count, 2)
    }

    func testTheIdIsLowercasedAndAMalformedTokenStaysText() {
        XCTAssertEqual(CustomEmoji.prepare("<:party:\(id.uppercased())>").tokens.first?.id, id)
        for bad in ["<:Party:\(id)>", "<:p:\(id)>", "<:party:not-a-uuid>", "<party:\(id)>", "<:party:\(id)", "<a:party:\(id)>"] {
            let prepared = CustomEmoji.prepare(bad)
            XCTAssertTrue(prepared.tokens.isEmpty, bad)
            XCTAssertEqual(prepared.text, bad)
        }
    }

    func testAHostileStandInInTheBodyCannotShiftWhichPictureGoesWhere() {
        let prepared = CustomEmoji.prepare("\u{E000}x <:party:\(id)>")
        XCTAssertEqual(prepared.text, "x \u{E000}")
        XCTAssertEqual(prepared.tokens.count, 1)
    }

    func testPlainTextSurfacesGetTheTypedName() {
        XCTAssertEqual(CustomEmoji.asText("bora <:party:\(id)>!"), "bora :party:!")
        XCTAssertEqual(CustomEmoji.asText("nada aqui"), "nada aqui")
    }

    func testThePictureIsServedFromOurOrigin() {
        XCTAssertEqual(
            CustomEmoji.imageURL(id: id, backend: .hosted)?.absoluteString,
            "https://api.pqp.gg/api/emoji/\(id)"
        )
    }

    @MainActor
    func testAPictureIsRefusedBeforeDecodingWhenItsHeaderClaimsTooMuch() {
        XCTAssertTrue(EmojiImages.fitsDecodeBudget(width: 128, height: 128))
        XCTAssertTrue(EmojiImages.fitsDecodeBudget(width: 2048, height: 976))
        XCTAssertFalse(EmojiImages.fitsDecodeBudget(width: 30_000, height: 30_000))
        XCTAssertFalse(EmojiImages.fitsDecodeBudget(width: 4096, height: 8))
        XCTAssertFalse(EmojiImages.fitsDecodeBudget(width: 0, height: 10))
    }

    func testTheSpokenLabelHasNoMarkdownAndNamesEachEmoji() {
        let prepared = CustomEmoji.prepare("festa <:party:d768f98d-9eda-4718-92ff-c813b4ab76c2> **negrito** fim")
        let parsed = (try? AttributedString(
            markdown: prepared.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(prepared.text)
        XCTAssertEqual(CustomEmoji.spoken(parsed, tokens: prepared.tokens), "festa :party: negrito fim")
    }
}
