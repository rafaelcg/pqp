import XCTest
@testable import pqp

/// Seguir on iOS: the wire shapes from `packages/shared/src/bau-follow.ts`, what
/// a refusal says (the web's `bauFollowErrorKey`, case for case), the picker's
/// rules and the optimistic follower-list edits.
@MainActor
final class BauFollowTests: XCTestCase {
    private let sourceId = "11111111-1111-4111-8111-111111111111"
    private let serverA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let serverB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let chan1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"
    private let chan2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2"
    private let chan3 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
    private let role1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"

    // MARK: - Decoding

    func testAFollowDecodesAndKnowsWhenItIsPaused() throws {
        let json = """
        {"id":"\(chan1)","sourceServerId":"\(sourceId)","sourceServerName":"QG",
         "sourceServerIconUrl":null,"targetServerId":"\(serverA)","targetServerName":"Guilda",
         "targetChannelId":"\(chan2)","targetChannelName":"novidades","rolePingId":"\(role1)",
         "rolePingName":"Avisos","status":"paused","pausedReason":"banned",
         "pausedAt":"2026-10-15T12:00:00.000Z","createdAt":"2026-10-15T11:00:00.000Z","mine":true}
        """
        let follow = try Coding.decoder.decode(BauFollow.self, from: Data(json.utf8))
        XCTAssertEqual(follow.targetChannelName, "novidades")
        XCTAssertEqual(follow.rolePingName, "Avisos")
        XCTAssertTrue(follow.isPaused)
        XCTAssertTrue(follow.isBanned)
        XCTAssertTrue(follow.mine)
    }

    func testAnActiveFollowIsNotPausedAndAnUnknownStatusReadsAsActive() throws {
        func make(_ status: String) throws -> BauFollow {
            let json = """
            {"id":"\(chan1)","sourceServerId":"\(sourceId)","sourceServerName":"QG",
             "sourceServerIconUrl":"/api/servers/x/icon?v=1","targetServerId":"\(serverA)",
             "targetServerName":"G","targetChannelId":"\(chan2)","targetChannelName":"n",
             "rolePingId":null,"rolePingName":null,"status":"\(status)","pausedReason":null,
             "pausedAt":null,"createdAt":"2026-10-15T11:00:00.000Z","mine":false}
            """
            return try Coding.decoder.decode(BauFollow.self, from: Data(json.utf8))
        }
        XCTAssertFalse(try make("active").isPaused)
        XCTAssertFalse(try make("snoozed").isPaused)
    }

    func testTheStateOffReadDecodesWithEmptyFields() throws {
        let state = try Coding.decoder.decode(
            BauFollowState.self, from: Data(#"{"enabled":false,"maxPerServer":20,"mine":[]}"#.utf8)
        )
        XCTAssertFalse(BauFollowRules.buttonVisible(state))
        XCTAssertFalse(BauFollowRules.buttonVisible(nil), "a failed read draws no button")
    }

    func testDestinationsDecode() throws {
        let json = """
        {"maxPerServer":20,"servers":[{"serverId":"\(serverA)","serverName":"Guilda",
          "serverIconUrl":null,"followCount":3,
          "channels":[{"id":"\(chan1)","name":"geral","following":false},
                      {"id":"\(chan2)","name":"novidades","following":true}],
          "roles":[{"id":"\(role1)","name":"Avisos","color":"#ff0000"}]}]}
        """
        let result = try Coding.decoder.decode(BauFollowDestinations.self, from: Data(json.utf8))
        XCTAssertEqual(result.servers.first?.channels.count, 2)
        XCTAssertEqual(result.servers.first?.roles.first?.name, "Avisos")
        XCTAssertEqual(result.servers.first?.followCount, 3)
    }

    func testFollowersDecode() throws {
        let json = """
        {"enabled":true,"flagOn":true,"allowed":true,"publicCommunity":false,"count":2,
         "followers":[{"id":"\(chan1)","targetServerId":"\(serverA)","targetServerName":"Guilda",
           "targetServerIconUrl":null,"targetChannelName":"novidades","status":"paused",
           "createdAt":"2026-10-15T11:00:00.000Z"}],
         "blocked":[{"serverId":"\(serverB)","serverName":"Spam","createdAt":"2026-10-15T11:00:00.000Z"}]}
        """
        let followers = try Coding.decoder.decode(BauFollowers.self, from: Data(json.utf8))
        XCTAssertEqual(followers.count, 2)
        XCTAssertTrue(followers.followers[0].isPaused)
        XCTAssertEqual(followers.blocked.first?.serverName, "Spam")
    }

    // MARK: - What a refusal says

    func testRefusalsFollowTheWebsMapping() {
        func refuse(_ status: Int, _ message: String) -> BauFollowFailure {
            BauFollowFailure.from(APIError.server(status: status, message: message))
        }
        XCTAssertEqual(BauFollowFailure.from(APIError.rateLimited(retryAfter: 3)), .slow)
        XCTAssertEqual(refuse(403, "You need to manage webhooks or channels in that channel"), .forbidden)
        XCTAssertEqual(refuse(403, "This Baú does not accept that server"), .blocked)
        XCTAssertEqual(refuse(409, "That channel already follows this Baú"), .exists)
        XCTAssertEqual(refuse(409, "A server can follow at most 20 Baús"), .limit)
        XCTAssertEqual(refuse(400, "That role cannot be pinged"), .invalid)
        XCTAssertEqual(refuse(500, "boom"), .generic)
        XCTAssertEqual(BauFollowFailure.from(APIError.notFound("Not found")), .unavailable)
        XCTAssertEqual(BauFollowFailure.from(APIError.transport("offline")), .generic)
    }

    func testEveryRefusalHasASentence() {
        let all: [BauFollowFailure] = [.slow, .forbidden, .blocked, .limit, .exists, .invalid, .unavailable, .generic]
        for failure in all { XCTAssertFalse(failure.message.isEmpty) }
    }

    // MARK: - The picker

    private func destination(
        _ id: String, name: String = "Guilda", channels: [(String, String, Bool)], roles: [(String, String)] = [],
        followCount: Int = 0
    ) -> BauFollowDestination {
        let json = """
        {"serverId":"\(id)","serverName":"\(name)","serverIconUrl":null,"followCount":\(followCount),
         "channels":[\(channels.map { #"{"id":"\#($0.0)","name":"\#($0.1)","following":\#($0.2)}"# }.joined(separator: ","))],
         "roles":[\(roles.map { #"{"id":"\#($0.0)","name":"\#($0.1)","color":null}"# }.joined(separator: ","))]}
        """
        return try! Coding.decoder.decode(BauFollowDestination.self, from: Data(json.utf8))
    }

    func testThePickerStartsOnTheFirstServerAndItsFirstFreeChannel() {
        let picker = BauFollowPicker(
            destinations: [
                destination(serverA, channels: [(chan1, "geral", true), (chan2, "novidades", false)]),
                destination(serverB, name: "Outra", channels: [(chan3, "x", false)]),
            ],
            maxPerServer: 20
        )
        XCTAssertEqual(picker.destination?.serverId, serverA)
        XCTAssertEqual(picker.freeChannels.map(\.id), [chan2], "a channel that already follows is not offered")
        XCTAssertEqual(picker.selectedChannelId, chan2)
        XCTAssertTrue(picker.canSubmit)
    }

    func testSwitchingServerRevalidatesTheChannelAndDropsTheRole() {
        var picker = BauFollowPicker(
            destinations: [
                destination(serverA, channels: [(chan1, "geral", false)], roles: [(role1, "Avisos")]),
                destination(serverB, name: "Outra", channels: [(chan3, "x", false)]),
            ],
            maxPerServer: 20
        )
        picker.selectRole(role1)
        XCTAssertEqual(picker.selectedRoleId, role1)
        picker.selectServer(serverB)
        XCTAssertEqual(picker.selectedChannelId, chan3)
        XCTAssertEqual(picker.selectedRoleId, "", "a role of the other server cannot ride along")
        picker.selectRole(role1)
        XCTAssertEqual(picker.selectedRoleId, "", "a role the server does not offer is refused")
    }

    func testAFullServerOffersNothingToSubmit() {
        let picker = BauFollowPicker(
            destinations: [destination(serverA, channels: [(chan1, "geral", false)], followCount: 20)],
            maxPerServer: 20
        )
        XCTAssertTrue(picker.isFull)
        XCTAssertFalse(picker.canSubmit)
    }

    func testAServerWhoseChannelsAllFollowCannotSubmit() {
        let picker = BauFollowPicker(
            destinations: [destination(serverA, channels: [(chan1, "geral", true)])],
            maxPerServer: 20
        )
        XCTAssertTrue(picker.freeChannels.isEmpty)
        XCTAssertFalse(picker.canSubmit)
    }

    func testNoDestinationsIsNothingToPick() {
        let picker = BauFollowPicker(destinations: [], maxPerServer: 20)
        XCTAssertNil(picker.destination)
        XCTAssertFalse(picker.canSubmit)
    }

    func testRefreshingKeepsTheServerOnShowAndDropsTheChannelJustFollowed() {
        var picker = BauFollowPicker(
            destinations: [
                destination(serverA, channels: [(chan1, "geral", false), (chan2, "novidades", false)]),
                destination(serverB, name: "Outra", channels: [(chan3, "x", false)]),
            ],
            maxPerServer: 20
        )
        picker.selectServer(serverB)
        picker.replace(
            destinations: [
                destination(serverA, channels: [(chan1, "geral", false), (chan2, "novidades", false)]),
                destination(serverB, name: "Outra", channels: [(chan3, "x", true)], followCount: 1),
            ],
            maxPerServer: 20
        )
        XCTAssertEqual(picker.destination?.serverId, serverB, "the server stays")
        XCTAssertEqual(picker.selectedChannelId, "", "its only channel now follows")
        XCTAssertFalse(picker.canSubmit)
    }

    func testRefreshingToAServerThatVanishedFallsBackToTheFirst() {
        var picker = BauFollowPicker(
            destinations: [
                destination(serverA, channels: [(chan1, "geral", false)]),
                destination(serverB, name: "Outra", channels: [(chan3, "x", false)]),
            ],
            maxPerServer: 20
        )
        picker.selectServer(serverB)
        picker.replace(destinations: [destination(serverA, channels: [(chan1, "geral", false)])], maxPerServer: 20)
        XCTAssertEqual(picker.destination?.serverId, serverA)
        XCTAssertEqual(picker.selectedChannelId, chan1)
    }

    // MARK: - Who sees what

    func testTheFollowersMenuIsForStaffWhileTheFlagIsOn() throws {
        let on = try Coding.decoder.decode(BauFollowers.self, from: Data(
            #"{"enabled":false,"flagOn":true,"allowed":false,"publicCommunity":false,"count":0,"followers":[],"blocked":[]}"#.utf8))
        let off = try Coding.decoder.decode(BauFollowers.self, from: Data(
            #"{"enabled":false,"flagOn":false,"allowed":false,"publicCommunity":false,"count":0,"followers":[],"blocked":[]}"#.utf8))
        XCTAssertTrue(BauFollowRules.followersMenuVisible(canManageServer: true, followers: on))
        XCTAssertFalse(BauFollowRules.followersMenuVisible(canManageServer: false, followers: on))
        XCTAssertFalse(BauFollowRules.followersMenuVisible(canManageServer: true, followers: off))
        XCTAssertFalse(BauFollowRules.followersMenuVisible(canManageServer: true, followers: nil))
    }

    func testAChannelListsItsFollowsForWebhookOrChannelManagersOnly() throws {
        func snapshot(_ server: UInt64, channels: [String: UInt64] = [:]) throws -> PermissionsSnapshot {
            let body: [String: Any] = [
                "version": 1, "server": String(server),
                "channels": channels.mapValues { String($0) },
            ]
            return try JSONDecoder().decode(PermissionsSnapshot.self, from: JSONSerialization.data(withJSONObject: body))
        }
        XCTAssertTrue(BauFollowRules.mayManageFollows(try snapshot(PermissionBit.manageWebhooks), channelId: "c"))
        XCTAssertTrue(BauFollowRules.mayManageFollows(try snapshot(PermissionBit.manageChannels), channelId: "c"))
        XCTAssertFalse(BauFollowRules.mayManageFollows(try snapshot(PermissionBit.sendMessages), channelId: "c"))
        XCTAssertFalse(BauFollowRules.mayManageFollows(nil, channelId: "c"))
        // A per-channel grant counts there and only there.
        let granted = try snapshot(0, channels: ["c": PermissionBit.manageWebhooks])
        XCTAssertTrue(BauFollowRules.mayManageFollows(granted, channelId: "c"))
        XCTAssertFalse(BauFollowRules.mayManageFollows(granted, channelId: "other"))
    }

    // MARK: - The followers list edits

    private func followers(count: Int = 3) throws -> BauFollowers {
        func row(_ id: String, _ server: String, _ name: String) -> String {
            #"{"id":"\#(id)","targetServerId":"\#(server)","targetServerName":"\#(name)","targetServerIconUrl":null,"targetChannelName":"c","status":"active","createdAt":"2026-10-15T11:00:00.000Z"}"#
        }
        let json = """
        {"enabled":true,"flagOn":true,"allowed":true,"publicCommunity":false,"count":\(count),
         "followers":[\(row(chan1, serverA, "Guilda")),\(row(chan2, serverA, "Guilda")),\(row(chan3, serverB, "Outra"))],
         "blocked":[]}
        """
        return try Coding.decoder.decode(BauFollowers.self, from: Data(json.utf8))
    }

    func testRemovingOneFollowerLeavesTheOthers() throws {
        let current = try followers()
        let next = BauFollowRules.removing(current.followers[0], from: current)
        XCTAssertEqual(next.count, 2)
        XCTAssertEqual(next.followers.map(\.id), [chan2, chan3])
    }

    func testBlockingRemovesEveryFollowOfThatServerAndListsItBlocked() throws {
        let current = try followers()
        let next = BauFollowRules.blocking(current.followers[0], from: current)
        XCTAssertEqual(next.count, 1, "both of Guilda's follows are gone")
        XCTAssertEqual(next.followers.map(\.id), [chan3])
        XCTAssertEqual(next.blocked.first?.serverId, serverA)
    }

    func testTheCountNeverGoesNegative() throws {
        let current = try followers(count: 0)
        XCTAssertEqual(BauFollowRules.removing(current.followers[0], from: current).count, 0)
        XCTAssertEqual(BauFollowRules.blocking(current.followers[0], from: current).count, 0)
    }

    func testUnblockingDropsOnlyThatServer() throws {
        let current = try followers()
        let blocked = BauFollowRules.blocking(current.followers[0], from: current)
        let again = BauFollowRules.unblocking(try XCTUnwrap(blocked.blocked.first), from: blocked)
        XCTAssertTrue(again.blocked.isEmpty)
        XCTAssertEqual(again.followers.map(\.id), [chan3], "unblocking does not bring the follows back")
    }
}
