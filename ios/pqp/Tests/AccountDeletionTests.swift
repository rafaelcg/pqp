import XCTest
@testable import pqp

/// The rules the delete button hangs off, and the two wire shapes behind it.
///
/// WHY THIS IS WORTH TESTING AT ALL: the confirmation is a mirror. The server
/// decides whether a typed string counts (`deleteConfirmationMatches` in
/// `packages/shared/src/api.ts`) and this client decides whether the button
/// lights up. If the two disagree, the failure is a user who typed exactly what
/// the screen asked for and got a 400 telling them to type exactly what they
/// typed. Every case below is one way they could come apart.
final class AccountDeletionTests: XCTestCase {

    // MARK: - What has to be typed

    func testTheTagIsWhatMustBeTyped() {
        XCTAssertEqual(AccountDeletion.expectedConfirmation(tag: "rafa#0042"), "rafa#0042")
    }

    /// Most accounts have a tag; the ones that do not are still allowed to
    /// leave. `expectedDeleteConfirmation` in shared makes the same
    /// substitution, and the server compares against the same phrase.
    func testAnAccountWithNoTagTypesThePhraseInstead() {
        XCTAssertEqual(
            AccountDeletion.expectedConfirmation(tag: nil),
            AccountDeletion.fallbackPhrase
        )
        XCTAssertEqual(
            AccountDeletion.expectedConfirmation(tag: ""),
            AccountDeletion.fallbackPhrase
        )
    }

    /// The phrase is English in a Portuguese app on purpose: the server
    /// compares the typed value against this exact string, so a translated one
    /// would be refused with a 400 the user could do nothing about.
    func testTheFallbackPhraseIsTheOneTheServerCompares() {
        XCTAssertEqual(AccountDeletion.fallbackPhrase, "delete my account")
    }

    // MARK: - Whether what was typed counts

    func testTheExactTagConfirms() {
        XCTAssertTrue(AccountDeletion.confirmationMatches("rafa#0042", tag: "rafa#0042"))
    }

    /// Case and surrounding space are forgiven, because the requirement is
    /// deliberate intent rather than typing accuracy — and iOS will capitalise
    /// the first letter of a field for you if you let it.
    func testCaseAndSpaceAreForgiven() {
        XCTAssertTrue(AccountDeletion.confirmationMatches("  RAFA#0042 ", tag: "rafa#0042"))
        XCTAssertTrue(
            AccountDeletion.confirmationMatches("Delete My Account", tag: nil)
        )
    }

    func testSomethingElseDoesNotConfirm() {
        XCTAssertFalse(AccountDeletion.confirmationMatches("rafa", tag: "rafa#0042"))
        XCTAssertFalse(AccountDeletion.confirmationMatches("rafa#0043", tag: "rafa#0042"))
        XCTAssertFalse(AccountDeletion.confirmationMatches("", tag: "rafa#0042"))
        // The tag of an account that has one is not interchangeable with the
        // phrase: typing the phrase must not delete an account that was asked
        // for its tag.
        XCTAssertFalse(
            AccountDeletion.confirmationMatches("delete my account", tag: "rafa#0042")
        )
    }

    // MARK: - The refusal that is a list, not a sentence

    /// `DELETE /api/me` answers 409 with the communities standing in the way.
    /// The screen names them, so a field name that drifts is a screen that says
    /// "do something first" and cannot say what.
    func testTheOwnedServersRefusalDecodes() throws {
        let json = """
        {"error":"Transfer or delete the communities you own first.",
         "code":"owned_servers",
         "servers":[{"id":"11111111-1111-1111-1111-111111111111",
                     "name":"QG","otherMemberCount":4}]}
        """
        struct Refusal: Decodable {
            let error: String?
            let code: String?
            let servers: [BlockingOwnedServer]?
        }
        let refusal = try Coding.decoder.decode(Refusal.self, from: Data(json.utf8))
        XCTAssertEqual(refusal.code, "owned_servers")
        XCTAssertEqual(refusal.servers?.count, 1)
        XCTAssertEqual(refusal.servers?.first?.name, "QG")
        XCTAssertEqual(refusal.servers?.first?.otherMemberCount, 4)
    }
}
