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

    func testMovingPastEitherEndOrAnUnknownServerChangesNothing() {
        XCTAssertNil(ServerOrder.moved(list, id: "a", by: -1))
        XCTAssertNil(ServerOrder.moved(list, id: "c", by: 1))
        XCTAssertNil(ServerOrder.moved(list, id: "zzz", by: 1))
        XCTAssertNil(ServerOrder.moved([Item](), id: "a", by: 1))
    }
}
