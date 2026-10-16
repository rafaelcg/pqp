import XCTest
@testable import pqp

/// The public switches of server settings: what the state says, who may move
/// which switch, and what a refusal means. The permission model is the web's
/// (`CommunitySettingsSection`) and the server's (the PATCH handler under
/// `/api/servers/:id/community`); these pin the iOS copy of it.
final class CommunitySettingsTests: XCTestCase {
    private func decode(_ json: String) throws -> CommunitySettings {
        try JSONDecoder().decode(CommunitySettings.self, from: Data(json.utf8))
    }

    private func snapshot(server bits: UInt64) throws -> PermissionsSnapshot {
        try JSONDecoder().decode(
            PermissionsSnapshot.self,
            from: Data(#"{"version":1,"server":"\#(bits)","channels":{}}"#.utf8)
        )
    }

    // MARK: - Wire

    func testAnOlderServerThatNeverSentIsListedReadsAsListedWhenAddressed() throws {
        // The shared schema defaults `isListed` to the address: before the
        // split an addressed community WAS a listed one.
        let settings = try decode(#"{"isCommunity":true,"slug":"valorant","suspended":false}"#)
        XCTAssertTrue(settings.isListed)
        XCTAssertEqual(CommunityVisibility(settings), .listed(slug: "valorant"))
    }

    func testAnUnaddressedServerIsNotListedWhateverTheDefault() throws {
        let settings = try decode(#"{"isCommunity":false,"slug":null,"suspended":false}"#)
        XCTAssertFalse(settings.isListed)
        XCTAssertEqual(CommunityVisibility(settings), .private)
    }

    func testVisibilityNamesTheThreeStates() {
        XCTAssertEqual(
            CommunityVisibility(.init(isCommunity: false, isListed: false, slug: nil)),
            .private
        )
        XCTAssertEqual(
            CommunityVisibility(.init(isCommunity: true, isListed: false, slug: "pqp")),
            .publicLink(slug: "pqp")
        )
        XCTAssertEqual(
            CommunityVisibility(.init(isCommunity: true, isListed: true, slug: "pqp")),
            .listed(slug: "pqp")
        )
    }

    func testAListingWithoutAnAddressIsStillPrivate() {
        // Cannot happen on the server (the directory needs an address), and if
        // a payload ever said so, the header must not claim a public room.
        XCTAssertEqual(
            CommunityVisibility(.init(isCommunity: false, isListed: true, slug: nil)),
            .private
        )
    }

    func testOnlyPrivateIsNotPublic() {
        XCTAssertFalse(CommunityVisibility.private.isPublic)
        XCTAssertTrue(CommunityVisibility.publicLink(slug: nil).isPublic)
        XCTAssertTrue(CommunityVisibility.listed(slug: "x").isPublic)
    }

    func testAPatchNamesOnlyWhatChanged() throws {
        let data = try JSONEncoder().encode(CommunitySettingsPatch(isListed: true))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json.keys.sorted(), ["isListed"])
        let both = try JSONEncoder().encode(CommunitySettingsPatch(isCommunity: true, slug: "pqp"))
        let bothJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: both) as? [String: Any])
        XCTAssertEqual(bothJSON.keys.sorted(), ["isCommunity", "slug"])
    }

    // MARK: - Who may

    func testTheOwnerMaySeeAndMoveEverything() {
        let rules = CommunityEditRules(role: "owner", permissions: nil)
        XCTAssertTrue(rules.canSee)
        let off = CommunitySettings(isCommunity: false, isListed: false, slug: nil)
        XCTAssertNil(rules.addressLock(off))
        // The directory still waits for the address.
        XCTAssertEqual(rules.listingLock(off), .needsAddress)
        let on = CommunitySettings(isCommunity: true, isListed: true, slug: "pqp")
        XCTAssertNil(rules.addressLock(on))
        XCTAssertNil(rules.listingLock(on))
    }

    func testAnAdminWithManageServerMovesTheAddressButNotTheDirectory() throws {
        let rules = CommunityEditRules(
            role: "admin", permissions: try snapshot(server: PermissionBit.manageServer)
        )
        XCTAssertTrue(rules.canSee)
        let addressed = CommunitySettings(isCommunity: true, isListed: false, slug: "pqp")
        XCTAssertNil(rules.addressLock(addressed))
        XCTAssertEqual(rules.listingLock(addressed), .ownerOnlyListing)
    }

    func testAnAdminCannotTurnTheAddressOffWhileTheRoomIsListed() throws {
        // That write would take the listing down sideways; the server refuses.
        let rules = CommunityEditRules(
            role: "admin", permissions: try snapshot(server: PermissionBit.manageServer)
        )
        let listed = CommunitySettings(isCommunity: true, isListed: true, slug: "pqp")
        XCTAssertEqual(rules.addressLock(listed), .addressHeldByListing)
    }

    func testACargoThatGrantsManageServerCountsWithoutTheAdminRank() throws {
        let rules = CommunityEditRules(
            role: "member", permissions: try snapshot(server: PermissionBit.manageServer)
        )
        XCTAssertTrue(rules.canSee)
        XCTAssertFalse(rules.isOwner)
    }

    func testAMemberWithoutTheBitDoesNotSeeTheBlock() throws {
        XCTAssertFalse(CommunityEditRules(role: "member", permissions: nil).canSee)
        XCTAssertFalse(CommunityEditRules(
            role: "member", permissions: try snapshot(server: PermissionBit.sendMessages)
        ).canSee)
        // An admin rank alone is not the bit: the permission is what the
        // server asks for.
        XCTAssertFalse(CommunityEditRules(role: "admin", permissions: nil).canSee)
    }

    func testTheOwnerNeedsNoSnapshotToSeeTheBlock() {
        // The bits load a moment after the screen opens; the role covers it.
        XCTAssertTrue(CommunityEditRules(role: "owner", permissions: nil).canSee)
    }

    // MARK: - Refusals

    private func refusal(_ status: Int, _ message: String) -> CommunitySaveFailure {
        CommunitySaveFailure.classify(APIError.server(status: status, message: message))
    }

    func testASlugCollisionIsTheAddressesProblem() {
        let failure = refusal(409, "That address is already taken. Pick another.")
        XCTAssertEqual(failure, .slugTaken)
        XCTAssertTrue(failure.concernsAddress)
    }

    func testAnUnderivableNameIsTheAddressesProblem() {
        XCTAssertEqual(refusal(422, "That name cannot become a web address. Pick one."), .slugUnusable)
        XCTAssertEqual(refusal(400, "That address cannot be used"), .slugUnusable)
    }

    func testListingBeforeTheAddressIsNotACollision() {
        let failure = refusal(
            409, "Turn the public address on before listing this community in the directory"
        )
        XCTAssertEqual(failure, .needsAddress)
        XCTAssertFalse(failure.concernsAddress)
    }

    func testAForbiddenSaveKeepsTheServersOwnSentence() {
        let sentence = "Only the owner can list this community in the directory"
        XCTAssertEqual(refusal(403, sentence), .forbidden(sentence))
    }

    func testAnythingElseIsShownAsTheServerSaidIt() {
        XCTAssertEqual(refusal(500, "boom"), .other("boom"))
        XCTAssertEqual(
            CommunitySaveFailure.classify(APIError.transport("offline")), .other("offline")
        )
    }

    // MARK: - Address

    func testTheAddressIsShownBareAndCopiedAsALink() {
        XCTAssertEqual(CommunityAddress.display("valorant-brasil"), "pqp.gg/c/valorant-brasil")
        XCTAssertEqual(CommunityAddress.url("valorant-brasil"), "https://pqp.gg/c/valorant-brasil")
    }
}
