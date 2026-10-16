import XCTest
@testable import pqp

/// @mention autocomplete: the web's `mention-autocomplete.ts`, rule for rule
/// (and Android's port of it).
final class MentionAutocompleteTests: XCTestCase {
    private func person(_ id: String, _ name: String, _ username: String?) -> MentionCandidate {
        MentionCandidate(id: id, displayName: name, username: username, avatarUrl: nil)
    }

    // MARK: - Finding the token

    func testTheTokenIsTheWordAfterTheAtUnderTheCaret() {
        XCTAssertEqual(MentionAutocomplete.find(in: "oi @ra", caret: 6), MentionQuery(start: 3, end: 6, query: "ra"))
        XCTAssertEqual(MentionAutocomplete.find(in: "@", caret: 1), MentionQuery(start: 0, end: 1, query: ""))
        XCTAssertEqual(MentionAutocomplete.find(in: "oi\n@bi", caret: 6)?.query, "bi")
    }

    func testAnAddressIsNotAMention() {
        XCTAssertNil(MentionAutocomplete.find(in: "you@example", caret: 11))
        XCTAssertNil(MentionAutocomplete.find(in: "a@b", caret: 3))
    }

    func testTheCaretMustBeInsideTheToken() {
        XCTAssertNil(MentionAutocomplete.find(in: "@rafa oi", caret: 8), "a space ended it")
        XCTAssertNil(MentionAutocomplete.find(in: "@rafa!", caret: 6), "punctuation ended it")
        XCTAssertNil(MentionAutocomplete.find(in: "oi", caret: 2))
        XCTAssertNil(MentionAutocomplete.find(in: "@ra\u{00E7}a", caret: 5), "not a username character")
    }

    func testPastTheUsernameLengthItCannotBeAHandle() {
        let long = "@" + String(repeating: "a", count: 33)
        XCTAssertNil(MentionAutocomplete.find(in: long, caret: long.count))
        let fits = "@" + String(repeating: "a", count: 32)
        XCTAssertNotNil(MentionAutocomplete.find(in: fits, caret: fits.count))
    }

    func testThePhonesCaretIsTheEndOfTheDraft() {
        XCTAssertEqual(MentionAutocomplete.findAtEnd(of: "bora @bi")?.query, "bi")
        XCTAssertNil(MentionAutocomplete.findAtEnd(of: "bora @bia e"))
        XCTAssertNil(MentionAutocomplete.findAtEnd(of: ""))
    }

    // MARK: - Filtering

    func testBestMatchFirstAndNoUsernameMeansNothingToInsert() {
        let people = [
            person("1", "Bia Souza", "bia"),
            person("2", "Gabriel", "gab_bia"),
            person("3", "Abiah", "zed"),
            person("4", "Sem Handle", nil),
        ]
        let found = MentionAutocomplete.filter(people, query: "bi")
        XCTAssertEqual(found.map(\.id), ["1", "3", "2"], "username prefix first, then the rest that merely contain it, alphabetically")
        XCTAssertFalse(found.contains { $0.id == "4" })
    }

    func testAnEmptyTokenOffersEveryoneAlphabeticallyUpToTheCap() {
        let people = (0..<12).map { person("\($0)", "Pessoa \(String(format: "%02d", $0))", "p\($0)") }
        let found = MentionAutocomplete.filter(people, query: "")
        XCTAssertEqual(found.count, MentionAutocomplete.maxSuggestions)
        XCTAssertEqual(found.first?.displayName, "Pessoa 00")
    }

    func testMatchingIgnoresCase() {
        XCTAssertEqual(MentionAutocomplete.filter([person("1", "Rafa", "RafaCG")], query: "RAFA").count, 1)
    }

    // MARK: - Inserting

    func testTheTokenIsReplacedWithTheUsernameAndASpace() {
        let draft = "oi @bi"
        let active = MentionAutocomplete.findAtEnd(of: draft)!
        let result = MentionAutocomplete.apply(to: draft, active: active, username: "bia")
        XCTAssertEqual(result.value, "oi @bia ")
        XCTAssertEqual(result.caret, 8)
    }

    func testAMemberOrAParticipantBecomesACandidate() {
        let member = ServerMember(
            id: "u1", displayName: "Bia", username: "bia", discriminator: nil, tag: nil,
            avatarUrl: nil, role: "member", status: nil
        )
        XCTAssertEqual(member.mentionCandidate.username, "bia")
        let user = PublicUser(id: "u2", displayName: "Gab", username: nil, tag: nil, avatarUrl: nil)
        XCTAssertNil(user.mentionCandidate.username)
    }
}
