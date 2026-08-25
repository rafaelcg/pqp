import XCTest
@testable import pqp

/// `GET /api/me` carries the preferences blob, and this client now reads it off
/// the account rather than asking a second time.
///
/// The bug this pins: `muteOnJoin` was written by Settings and read by nobody,
/// so somebody who ticked "mute microphone when joining voice" joined with a
/// live microphone. Nothing about the *toggle* was broken, which is why it
/// survived so long. What was missing was this field arriving anywhere the
/// voice code could see it.
final class AccountPreferencesTests: XCTestCase {
    private func decodeMe(_ json: String) throws -> CurrentUser {
        try Coding.decoder.decode(CurrentUser.self, from: Data(json.utf8))
    }

    func testPreferencesRideOnTheAccount() throws {
        let user = try decodeMe("""
        {"id":"11111111-1111-1111-1111-111111111111","clerkId":"user_1",
         "displayName":"Rafa","username":"rafa","discriminator":"0042",
         "tag":"rafa#0042","avatarUrl":null,
         "preferences":{"muteOnJoin":true,"showLinkEmbeds":false,
                        "notifications":{"default":"mentions"}}}
        """)
        XCTAssertEqual(user.preferences?.muteOnJoin, true)
        XCTAssertEqual(user.preferences?.showLinkEmbeds, false)
        XCTAssertEqual(user.preferences?.notifications?.default, "mentions")
    }

    /// An account that has never opened Settings has no blob at all, and a
    /// server old enough to predate the field sends nothing either. Both have
    /// to decode rather than cost the whole account, which is why the property
    /// is optional and every reader coalesces to the defaults.
    func testAnAccountWithNoPreferencesStillDecodes() throws {
        let user = try decodeMe("""
        {"id":"11111111-1111-1111-1111-111111111111","clerkId":"user_1",
         "displayName":"Rafa","username":"rafa","discriminator":"0042",
         "tag":"rafa#0042","avatarUrl":null}
        """)
        XCTAssertNil(user.preferences)
        // What `SessionStore.preferences` hands a caller in that case.
        XCTAssertNil((user.preferences ?? UserPreferences()).muteOnJoin)
    }

    /// `null` is not the same as absent on the wire, and the server sends it
    /// for an account whose blob was cleared.
    func testANullPreferencesBlobDecodes() throws {
        let user = try decodeMe("""
        {"id":"11111111-1111-1111-1111-111111111111","clerkId":"user_1",
         "displayName":"Rafa","username":null,"discriminator":null,
         "tag":null,"avatarUrl":null,"preferences":null}
        """)
        XCTAssertNil(user.preferences)
    }
}
