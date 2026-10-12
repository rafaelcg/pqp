import XCTest
@testable import pqp

/// The mixed channel list on iOS: the port of `packages/shared/src/channel-layout.ts`
/// run against the SAME fixture the web and Android run
/// (`packages/shared/fixtures/channel-layout-cases.json`), the organizer's
/// staged moves, and the wire shapes of the layout endpoints.
final class ChannelLayoutTests: XCTestCase {

    // MARK: - The shared fixture

    private struct Row: Decodable, LayoutChannel {
        let id: String
        let type: String
        let parentId: String?
        let position: Int
    }

    private struct BuildCase: Decodable {
        let name: String
        let server: String
        let mixed: Bool
        let hideWatchParty: Bool
        let expect: LayoutIds
    }

    private struct MoveCase: Decodable {
        let name: String
        let server: String
        let id: String
        let to: LayoutTarget
        let expect: LayoutIds?
    }

    private struct StepCase: Decodable {
        let name: String
        let server: String
        let id: String
        let direction: Int
        let target: LayoutTarget?
        let expect: LayoutIds?
    }

    private struct PayloadCase: Decodable {
        let name: String
        let server: String
        let mixed: Bool
        let hideWatchParty: Bool
        let baseVersion: Int
        let expect: ChannelLayoutPayload
    }

    private struct Fixture: Decodable {
        let version: Int
        let servers: [String: [Row]]
        let build: [BuildCase]
        let move: [MoveCase]
        let step: [StepCase]
        let payload: [PayloadCase]
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath)   // …/ios/pqp/Tests/ChannelLayoutTests.swift
            .deletingLastPathComponent()            // …/ios/pqp/Tests
            .deletingLastPathComponent()            // …/ios/pqp
            .deletingLastPathComponent()            // …/ios
            .deletingLastPathComponent()            // repo root
            .appending(path: "packages/shared/fixtures/channel-layout-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func rows(_ fixture: Fixture, _ server: String) throws -> [Row] {
        try XCTUnwrap(fixture.servers[server], "fixture has no server \(server)")
    }

    func testTheFixtureIsTheVersionThisPortWasWrittenAgainst() throws {
        // A new version may add rules this port does not have. Read the
        // fixture's `about`, port the change, then bump this.
        XCTAssertEqual(try fixture().version, 1)
    }

    func testEveryBuildCase() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.build.isEmpty)
        for test in fixture.build {
            let layout = ChannelLayoutRules.build(
                try rows(fixture, test.server), mixed: test.mixed, hideWatchParty: test.hideWatchParty
            )
            XCTAssertEqual(layout.ids, test.expect, test.name)
        }
    }

    func testEveryMoveCase() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.move.isEmpty)
        for test in fixture.move {
            let start = ChannelLayoutRules.build(try rows(fixture, test.server), mixed: true)
            let moved = ChannelLayoutRules.move(start, id: test.id, to: test.to)
            XCTAssertEqual(moved?.ids, test.expect, test.name)
        }
    }

    func testEveryStepCase() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.step.isEmpty)
        for test in fixture.step {
            let start = ChannelLayoutRules.build(try rows(fixture, test.server), mixed: true)
            let stepped = ChannelLayoutRules.step(start, id: test.id, direction: test.direction)
            XCTAssertEqual(stepped?.target, test.target, test.name)
            XCTAssertEqual(stepped?.layout.ids, test.expect, test.name)
        }
    }

    func testEveryPayloadCase() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.payload.isEmpty)
        for test in fixture.payload {
            let layout = ChannelLayoutRules.build(
                try rows(fixture, test.server), mixed: test.mixed, hideWatchParty: test.hideWatchParty
            )
            XCTAssertEqual(ChannelLayoutRules.payload(layout, baseVersion: test.baseVersion), test.expect, test.name)
        }
    }

    // MARK: - Organizar canais

    private func guris() throws -> ChannelOrganizer<Row> {
        let fixture = try fixture()
        return ChannelOrganizer(layout: ChannelLayoutRules.build(try rows(fixture, "guris"), mixed: true))
    }

    /// Display order of the organizer's flat list, as the ids the List draws.
    private let gurisItems = [
        "c:t-avisos", "c:v-afk", "c:w-filme", "c:t-regras",
        "h:cat-canais", "c:t-general", "c:v-lobby", "c:f-duvidas",
        "h:cat-jogos", "c:t-clipes", "c:v-squad", "c:t-lfg",
        "h:cat-cinema", "e:cat-cinema",
    ]

    func testTheFlatListIsLooseThenEachHeaderWithItsChannelsAndAPlaceholderWhenEmpty() throws {
        XCTAssertEqual(try guris().items.map(\.id), gurisItems)
    }

    /// The mock: Lobby dragged from Canais to between clipes and Squad.
    func testAChannelDroppedInsideAnotherCategoryJoinsItThere() throws {
        var organizer = try guris()
        XCTAssertTrue(organizer.move(from: [6], to: 10))
        XCTAssertEqual(organizer.layout.ids.categories[0].children, ["t-general", "f-duvidas"])
        XCTAssertEqual(organizer.layout.ids.categories[1].children, ["t-clipes", "v-lobby", "v-squad", "t-lfg"])
        XCTAssertTrue(organizer.hasChanges)
    }

    func testAChannelDroppedAboveTheFirstHeaderBecomesLoose() throws {
        var organizer = try guris()
        XCTAssertTrue(organizer.move(from: [5], to: 0))
        XCTAssertEqual(organizer.layout.ids.loose, ["t-general", "t-avisos", "v-afk", "w-filme", "t-regras"])
    }

    func testAChannelDroppedUnderAnEmptyCategoryGoesIntoIt() throws {
        var organizer = try guris()
        // The end of the list, past the "Vazia" placeholder.
        XCTAssertTrue(organizer.move(from: [11], to: gurisItems.count))
        XCTAssertEqual(organizer.layout.ids.categories[2].children, ["t-lfg"])
        XCTAssertEqual(organizer.items.last?.id, "c:t-lfg")
        XCTAssertFalse(organizer.items.contains { $0.id == "e:cat-cinema" })
    }

    func testAHeaderCarriesItsChannelsAndLandsAmongCategories() throws {
        var organizer = try guris()
        // Jogos dropped above Canais.
        XCTAssertTrue(organizer.move(from: [8], to: 4))
        XCTAssertEqual(organizer.layout.ids.categories.map(\.id), ["cat-jogos", "cat-canais", "cat-cinema"])
        XCTAssertEqual(organizer.layout.ids.categories[0].children, ["t-clipes", "v-squad", "t-lfg"])
    }

    func testAHeaderDroppedInsideItsOwnChannelsStaysPut() throws {
        var organizer = try guris()
        XCTAssertFalse(organizer.move(from: [8], to: 10))
        XCTAssertFalse(organizer.hasChanges)
    }

    func testAHeaderDroppedMidCategoryLandsAfterThatCategory() throws {
        var organizer = try guris()
        // Cinema dropped between general and Lobby: after Canais.
        XCTAssertTrue(organizer.move(from: [12], to: 6))
        XCTAssertEqual(organizer.layout.ids.categories.map(\.id), ["cat-canais", "cat-cinema", "cat-jogos"])
    }

    func testThePlaceholderNeverMoves() throws {
        var organizer = try guris()
        XCTAssertFalse(organizer.move(from: [13], to: 0))
        XCTAssertEqual(organizer.items.map(\.id), gurisItems)
    }

    func testMovingBackIsNoChangeAndResetForgetsTheStagedOrder() throws {
        var organizer = try guris()
        organizer.move(from: [6], to: 10)
        organizer.move(from: [9], to: 6)   // Lobby back between general and duvidas
        XCTAssertEqual(organizer.items.map(\.id), gurisItems)
        XCTAssertFalse(organizer.hasChanges)

        organizer.move(from: [0], to: 3)
        XCTAssertTrue(organizer.hasChanges)
        let fresh = ChannelLayoutRules.build(try rows(try fixture(), "single"), mixed: true)
        organizer.reset(to: fresh)
        XCTAssertFalse(organizer.hasChanges)
        XCTAssertEqual(organizer.items.map(\.id), ["h:cat-a", "c:t-x"])
    }

    func testAccessibilityStepsCrossCategoryBorders() throws {
        var organizer = try guris()
        XCTAssertFalse(organizer.canStep("t-avisos", direction: -1))
        XCTAssertTrue(organizer.canStep("t-general", direction: -1))
        let target = organizer.step("t-general", direction: -1)
        XCTAssertEqual(target, LayoutTarget(parentId: nil, index: 4))
        XCTAssertEqual(organizer.layout.ids.loose.last, "t-general")
        XCTAssertTrue(organizer.hasChanges)
        XCTAssertNil(organizer.step("cat-cinema", direction: 1))
    }

    func testACategoryCreatedMidSessionIsNotAStagedChange() throws {
        var organizer = try guris()
        organizer.appendCategory(Row(id: "cat-new", type: "category", parentId: nil, position: 3))
        XCTAssertFalse(organizer.hasChanges)
        XCTAssertEqual(organizer.items.suffix(2).map(\.id), ["h:cat-new", "e:cat-new"])
        organizer.replaceCategory(Row(id: "cat-new", type: "category", parentId: nil, position: 3))
        XCTAssertFalse(organizer.hasChanges)
    }

    // MARK: - Applying a saved order locally

    private func channel(_ id: String, type: String = "text", parentId: String? = nil, position: Int = 0) throws -> Channel {
        let parent = parentId.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"\#(id)","serverId":"s1","kind":"server","name":"n-\#(id)","type":"\#(type)","position":\#(position),"isPrivate":false,"topic":null,"imageUrl":null,"parentId":\#(parent)}"#
        return try JSONDecoder().decode(Channel.self, from: Data(json.utf8))
    }

    func testApplyRewritesParentAndPositionAndLeavesUnlistedRowsAlone() throws {
        let channels = [
            try channel("cat", type: "category"),
            try channel("a", parentId: "cat", position: 0),
            try channel("b", parentId: "cat", position: 1),
            try channel("wp", type: "watch_party", position: 7),
        ]
        let layout = ChannelLayoutRules.build(channels.filter { !$0.isWatchParty }, mixed: true)
        let moved = try XCTUnwrap(ChannelLayoutRules.move(layout, id: "b", to: LayoutTarget(parentId: nil, index: 0)))
        let applied = ChannelLayoutRules.apply(moved, to: channels)
        let byId = Dictionary(uniqueKeysWithValues: applied.map { ($0.id, $0) })
        XCTAssertNil(byId["b"]?.parentId)
        XCTAssertEqual(byId["b"]?.position, 0)
        XCTAssertEqual(byId["a"]?.parentId, "cat")
        XCTAssertEqual(byId["a"]?.position, 0)
        XCTAssertEqual(byId["wp"]?.position, 7)
        // Rebuilt from the rewritten rows, the list draws the same order.
        XCTAssertEqual(ChannelLayoutRules.build(applied.filter { !$0.isWatchParty }, mixed: true).ids, moved.ids)
    }

    // MARK: - Wire shapes

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTheLooseGroupSendsAnExplicitNullParent() throws {
        let payload = ChannelLayoutPayload(
            baseVersion: 3,
            categoryIds: ["c1"],
            groups: [.init(parentId: nil, channelIds: ["a"]), .init(parentId: "c1", channelIds: [])]
        )
        let groups = try XCTUnwrap(try json(payload)["groups"] as? [[String: Any]])
        XCTAssertTrue(groups[0].keys.contains("parentId"))
        XCTAssertTrue(groups[0]["parentId"] is NSNull)
        XCTAssertEqual(groups[1]["parentId"] as? String, "c1")
    }

    /// Absent `parentId` is how the server spots an OLDER client and files
    /// its channel into the first category. This build must always say.
    func testCreateAlwaysSaysWhereAChannelGoesAndNeverForACategory() throws {
        let loose = try json(CreateChannelBody(name: "a", type: "text", isPrivate: false, parentId: nil))
        XCTAssertTrue(loose.keys.contains("parentId"))
        XCTAssertTrue(loose["parentId"] is NSNull)

        let inside = try json(CreateChannelBody(name: "a", type: "voice", isPrivate: false, parentId: "c1"))
        XCTAssertEqual(inside["parentId"] as? String, "c1")

        let category = try json(CreateChannelBody(name: "Salas de voz", type: "category", isPrivate: false, parentId: nil))
        XCTAssertFalse(category.keys.contains("parentId"))
    }

    private let channelJSON = #"{"id":"c1","serverId":"s1","kind":"server","name":"general","type":"text","position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}"#

    func testASavedOrderWithAReadBack() throws {
        let data = Data(#"{"channels":[\#(channelJSON)],"version":9}"#.utf8)
        guard case .saved(let channels, let version) = try APIClient.channelLayoutSaveResult(data: data, status: 200) else {
            return XCTFail("expected saved")
        }
        XCTAssertEqual(channels?.map(\.id), ["c1"])
        XCTAssertEqual(version, 9)
    }

    func testASavedOrderWithoutAReadBackKeepsWhatWasDrawn() throws {
        let data = Data(#"{"channels":null,"version":9}"#.utf8)
        guard case .saved(let channels, 9) = try APIClient.channelLayoutSaveResult(data: data, status: 200) else {
            return XCTFail("expected saved")
        }
        XCTAssertNil(channels)
    }

    func testAStaleOrderCarriesTheFreshListAndVersion() throws {
        let data = Data(#"{"error":"channel_layout_stale","channels":[\#(channelJSON)],"version":12}"#.utf8)
        guard case .stale(let channels, 12) = try APIClient.channelLayoutSaveResult(data: data, status: 409) else {
            return XCTFail("expected stale")
        }
        XCTAssertEqual(channels.map(\.id), ["c1"])
    }

    func testTheMixedListSwitchedOffAndARefusedBody() throws {
        let off = Data(#"{"error":"channel_layout_off","version":4}"#.utf8)
        guard case .off = try APIClient.channelLayoutSaveResult(data: off, status: 409) else {
            return XCTFail("expected off")
        }
        let invalid = Data(#"{"error":"Every category must be listed"}"#.utf8)
        guard case .invalid(let message) = try APIClient.channelLayoutSaveResult(data: invalid, status: 400) else {
            return XCTFail("expected invalid")
        }
        XCTAssertEqual(message, "Every category must be listed")
        XCTAssertThrowsError(try APIClient.channelLayoutSaveResult(data: Data(#"{"error":"Forbidden"}"#.utf8), status: 403))
    }

    func testTheConfigDecodes() throws {
        let config = try JSONDecoder().decode(ChannelLayoutConfig.self, from: Data(#"{"mixed":true,"version":5}"#.utf8))
        XCTAssertEqual(config, ChannelLayoutConfig(mixed: true, version: 5))
    }

    // MARK: - Names and memory

    func testCategoryNamesAreLabelsUpTo32Units() {
        XCTAssertEqual(CategoryName.normalized("  Salas de voz "), "Salas de voz")
        XCTAssertEqual(CategoryName.normalized("Jogos & Música"), "Jogos & Música")
        XCTAssertNil(CategoryName.normalized("   "))
        XCTAssertNotNil(CategoryName.normalized(String(repeating: "a", count: 32)))
        XCTAssertNil(CategoryName.normalized(String(repeating: "a", count: 33)))
        XCTAssertNil(CategoryName.normalized("a\u{0007}b"))
    }

    func testTheLastAnswerIsRememberedPerServerWithoutAVersion() throws {
        let suite = "pqp.tests.layout.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = ChannelLayoutMemory(defaults: defaults)
        XCTAssertEqual(memory.load(serverId: "s1"), .legacy)
        memory.save(ChannelLayoutConfig(mixed: true, version: 8), serverId: "s1")
        XCTAssertEqual(memory.load(serverId: "s1"), ChannelLayoutConfig(mixed: true, version: 0))
        XCTAssertEqual(memory.load(serverId: "s2"), .legacy)
        memory.save(.legacy, serverId: "s1")
        XCTAssertEqual(memory.load(serverId: "s1"), .legacy)
    }

    // MARK: - One refresh at a time

    /// A burst of frames while a read is in flight is ONE follow-up read, and
    /// two reads never overlap.
    @MainActor
    func testARefreshBurstCollapsesIntoOneFollowUpAndNeverOverlaps() async {
        let gate = ChannelRefreshGate()
        var reads = 0
        var inFlight = 0
        var maxInFlight = 0
        let body: @MainActor () async -> Void = {
            reads += 1
            inFlight += 1
            maxInFlight = max(maxInFlight, inFlight)
            await Task.yield()
            await Task.yield()
            inFlight -= 1
        }
        async let first: Void = gate.run(body)
        await Task.yield()
        for _ in 0..<5 { await gate.run(body) }
        await first
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(maxInFlight, 1)
        await gate.run(body)
        XCTAssertEqual(reads, 3)
    }
}
