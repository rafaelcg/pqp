import XCTest

@testable import pqp

/// First run V2's rules, without a simulator.
///
/// The mirror of `client/src/lib/onboarding.test.ts`: both clients read and
/// write the same `preferences.onboardedAt`, so a disagreement about who sees
/// the wizard, or how many dots it has, is visible to a person as a wizard
/// they finished on one device waiting for them on the other.
final class OnboardingV2Tests: XCTestCase {
    private func unanswered() -> UserPreferences { UserPreferences() }

    private func answered() -> UserPreferences {
        var preferences = UserPreferences()
        preferences.onboardedAt = "2026-09-24T12:00:00.000Z"
        return preferences
    }

    // MARK: - Who sees it

    func testANewAccountFreshFromTheGateIsWalkedThrough() {
        XCTAssertTrue(Onboarding.shouldRun(
            preferences: unanswered(), answeredAgeGateThisLaunch: true, serverCount: nil
        ))
    }

    func testAnAnsweredAccountIsNeverAskedAgainOnAnyDevice() {
        XCTAssertFalse(Onboarding.shouldRun(
            preferences: answered(), answeredAgeGateThisLaunch: true, serverCount: 0
        ))
    }

    func testAServerWithoutAPreferenceStoreNeverRunsIt() {
        // Running it there would mean running it on every launch, forever.
        XCTAssertFalse(Onboarding.shouldRun(
            preferences: nil, answeredAgeGateThisLaunch: true, serverCount: 0
        ))
    }

    func testAnEmptyStampReadsAsUnanswered() {
        var preferences = UserPreferences()
        preferences.onboardedAt = ""
        XCTAssertTrue(Onboarding.shouldRun(
            preferences: preferences, answeredAgeGateThisLaunch: true, serverCount: nil
        ))
    }

    func testASettledMemberIsNotAskedToNameThemselvesByAnUpdate() {
        // iOS V1 never wrote the stamp, so an account with rooms of its own and
        // no stamp is an old account, not a new one.
        XCTAssertFalse(Onboarding.shouldRun(
            preferences: unanswered(), answeredAgeGateThisLaunch: false, serverCount: 3
        ))
    }

    func testAnUnstampedAccountWithNothingYetStillGetsTheWizard() {
        XCTAssertTrue(Onboarding.shouldRun(
            preferences: unanswered(), answeredAgeGateThisLaunch: false, serverCount: 0
        ))
    }

    func testAnUnknownServerCountDoesNotRunItForAnOldAccount() {
        XCTAssertFalse(Onboarding.shouldRun(
            preferences: unanswered(), answeredAgeGateThisLaunch: false, serverCount: nil
        ))
    }

    // MARK: - How many dots

    func testAColdStartIsFourScreensAndAnInviteIsTwo() {
        XCTAssertEqual(Onboarding.screens(for: .cold), [.age, .you, .room, .ready])
        XCTAssertEqual(Onboarding.screens(for: .invite), [.age, .you])
    }

    func testPositionCountsTheGateAsTheFirstDot() {
        XCTAssertEqual(Onboarding.position(of: .age, in: .cold).index, 0)
        XCTAssertEqual(Onboarding.position(of: .you, in: .invite).index, 1)
        XCTAssertEqual(Onboarding.position(of: .you, in: .invite).total, 2)
        XCTAssertEqual(Onboarding.position(of: .ready, in: .cold).index, 3)
    }

    func testAScreenThePathDoesNotListClampsToTheLastDot() {
        let position = Onboarding.position(of: .ready, in: .invite)
        XCTAssertEqual(position.index, 1)
        XCTAssertEqual(position.total, 2)
    }

    // MARK: - Handle

    func testUsernamesAreQuietlyFixedAsTyped() {
        XCTAssertEqual(Onboarding.normalizeUsername("João Silva"), "joosilva")
        XCTAssertEqual(Onboarding.normalizeUsername("Rafa_99!"), "rafa_99")
        XCTAssertEqual(Onboarding.normalizeUsername(String(repeating: "a", count: 40)).count, 32)
    }

    func testUsernameValidityMatchesTheSharedSchema() {
        XCTAssertTrue(Onboarding.isValidUsername("rafa"))
        XCTAssertTrue(Onboarding.isValidUsername("a_1"))
        XCTAssertFalse(Onboarding.isValidUsername("r"))
        XCTAssertFalse(Onboarding.isValidUsername("Rafa"))
        XCTAssertFalse(Onboarding.isValidUsername("everyone"))
        XCTAssertFalse(Onboarding.isValidUsername("here"))
    }

    func testOnlyANewNumberOnTheRequestedNameCountsAsReassigned() {
        XCTAssertTrue(Onboarding.tagWasReassigned(
            requestedUsername: "rafa", previousTag: "user_3f9a#0417", nextTag: "rafa#2231"
        ))
        XCTAssertFalse(Onboarding.tagWasReassigned(
            requestedUsername: "rafa", previousTag: "rafa#2231", nextTag: "rafa#2231"
        ))
        XCTAssertFalse(Onboarding.tagWasReassigned(
            requestedUsername: "rafa", previousTag: "x#1", nextTag: nil
        ))
    }

    func testAFullNameSaysPickAnotherRatherThanTryAgain() {
        XCTAssertEqual(Onboarding.handleError(for: APIError.server(status: 409, message: "")), .taken)
        XCTAssertEqual(Onboarding.handleError(for: APIError.server(status: 400, message: "")), .invalid)
        XCTAssertEqual(Onboarding.handleError(for: APIError.transport("offline")), .generic)
    }

    // MARK: - Invite

    func testTheWizardsInviteIsTheWebLinkTaggedOnboarding() {
        let url = Onboarding.shareURL(code: "AbC123")
        XCTAssertEqual(url.absoluteString, "https://pqp.gg/app/invite/AbC123?ref=onboarding")
    }

    func testTheRefIsATagTheServerKeeps() {
        XCTAssertTrue(Onboarding.isValidRef(Onboarding.inviteRef))
        XCTAssertFalse(Onboarding.isValidRef("On Boarding"))
    }

    func testTheInviteLastsAWeek() {
        XCTAssertEqual(Onboarding.inviteLifetimeHours, 168)
    }

    func testThePastesCarryTheLinkAndTheHashtag() {
        let url = Onboarding.shareURL(code: "XYZ")
        for paste in InvitePaste.allCases {
            let text = paste.text(url: url)
            XCTAssertTrue(text.contains(url.absoluteString), "\(paste) must carry the link")
            XCTAssertTrue(text.hasSuffix("#vemprapqp"))
        }
        XCTAssertTrue(InvitePaste.discord(serverName: "Os Crias", url: url).contains("Os Crias"))
    }

    // MARK: - Public preview

    func testThePreviewParsesTheEnvelope() throws {
        let data = Data(#"{"invite":{"serverName":"Os Crias","iconUrl":null,"memberCount":12}}"#.utf8)
        let preview = try XCTUnwrap(APIClient.parsePublicInvitePreview(data))
        XCTAssertEqual(preview.serverName, "Os Crias")
        XCTAssertEqual(preview.memberCount, 12)
        XCTAssertNil(preview.iconUrl)
    }

    func testABlankOrMalformedPreviewIsNoPreview() {
        XCTAssertNil(APIClient.parsePublicInvitePreview(Data(#"{"invite":{"serverName":"  ","iconUrl":null,"memberCount":1}}"#.utf8)))
        XCTAssertNil(APIClient.parsePublicInvitePreview(Data(#"{"error":"Not found"}"#.utf8)))
        XCTAssertNil(APIClient.parsePublicInvitePreview(Data("not json".utf8)))
    }

    func testAnImportPreviewDecodesFromTheServersFullPlan() throws {
        let json = #"""
        {"serverName":"Friends & Family","templateUpdatedAt":null,"isDirty":false,"iconUrl":null,
         "channels":[{"templateId":1,"parentTemplateId":null,"type":"category","name":"Text","topic":null,"topicTruncated":false,"position":0,"isPrivate":false},
                     {"templateId":2,"parentTemplateId":1,"type":"text","name":"general","topic":null,"topicTruncated":false,"position":0,"isPrivate":false},
                     {"templateId":3,"parentTemplateId":1,"type":"voice","name":"Lounge","topic":null,"topicTruncated":false,"position":1,"isPrivate":true}],
         "roles":[{"templateId":9,"name":"mods","originalName":"mods"}],
         "everyonePermissions":null,"overwrites":[],"privateChannelNames":[],"notInTemplate":[],"mappedAway":[]}
        """#
        let plan = try JSONDecoder().decode(DiscordImportPreview.self, from: Data(json.utf8))
        XCTAssertEqual(plan.textCount, 1)
        XCTAssertEqual(plan.voiceCount, 1)
        XCTAssertEqual(plan.categoryCount, 1)
        XCTAssertEqual(plan.roles.count, 1)
    }

    // MARK: - Joining behind the wizard

    @MainActor
    func testOnlyARefusalCountsAsADeadInvite() {
        XCTAssertTrue(SessionStore.isTransient(.transport("offline")))
        XCTAssertTrue(SessionStore.isTransient(.rateLimited(retryAfter: 5)))
        XCTAssertTrue(SessionStore.isTransient(.server(status: 503, message: "")))
        XCTAssertFalse(SessionStore.isTransient(.server(status: 400, message: "Invite expired")))
        XCTAssertFalse(SessionStore.isTransient(.notFound("gone")))
        XCTAssertFalse(SessionStore.isTransient(.unauthorized))
    }

    // MARK: - Session

    @MainActor
    func testAnInviteWalkStartsWithTheJoinPending() {
        let run = FirstRunSession(path: .invite, inviteCode: "abc", startedAtGate: true)
        XCTAssertEqual(run.arrival, .pending)
        XCTAssertNil(run.joinedServerId)
        run.arrival = .joined(serverId: "s1")
        XCTAssertEqual(run.joinedServerId, "s1")
        XCTAssertEqual(FirstRunSession(path: .cold, inviteCode: nil, startedAtGate: false).arrival, .none)
    }
}
