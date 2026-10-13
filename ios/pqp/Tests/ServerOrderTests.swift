import XCTest
@testable import pqp

/// Where a step up or down in the server list stops.
final class ServerOrderTests: XCTestCase {
    private struct Item: Identifiable, Equatable {
        let id: String
    }

    private let list = [Item(id: "a"), Item(id: "b"), Item(id: "c")]

    func testAServerMovesOnePlaceDownOrUp() {
        XCTAssertEqual(ServerOrder.moved(list, id: "a", by: 1)?.map(\.id), ["b", "a", "c"])
        XCTAssertEqual(ServerOrder.moved(list, id: "c", by: -1)?.map(\.id), ["a", "c", "b"])
    }

    func testApplyingAnOrderChangesOnlyTheOrder() {
        XCTAssertEqual(ServerOrder.applying(["c", "a", "b"], to: list).map(\.id), ["c", "a", "b"])
        // An id the list does not hold is ignored; a server the order does not
        // name keeps its place after the named ones.
        XCTAssertEqual(ServerOrder.applying(["zzz", "b"], to: list).map(\.id), ["b", "a", "c"])
    }

    func testMovingPastEitherEndOrAnUnknownServerChangesNothing() {
        XCTAssertNil(ServerOrder.moved(list, id: "a", by: -1))
        XCTAssertNil(ServerOrder.moved(list, id: "c", by: 1))
        XCTAssertNil(ServerOrder.moved(list, id: "zzz", by: 1))
        XCTAssertNil(ServerOrder.moved([Item](), id: "a", by: 1))
    }
}
