import SwiftUI
import XCTest
@testable import pqp

/// The viewer's side of layers: where the canvas sits, which stories use it,
/// what the call sticker says in each state, and what is a door.
@MainActor
final class StoryViewerLayersTests: XCTestCase {
    private let server = "33333333-3333-4333-8333-333333333333"
    private let room = "11111111-1111-4111-8111-111111111111"

    private func person(_ id: String, _ name: String) -> StoryAuthor {
        StoryAuthor(id: id, displayName: name, avatarUrl: nil)
    }

    private func live(state: String = "live", count: Int = 2, joinable: Bool = true, people: [StoryAuthor]? = nil) -> StoryCallLive {
        StoryCallLive(
            serverId: server, channelId: room, channelName: "Lobby",
            participants: people ?? [person("a", "Ana Costa"), person("b", "Bia Souza")],
            count: count, state: state, joinable: joinable
        )
    }

    // MARK: - The canvas

    /// The canvas is the smallest 9:16 box that COVERS the card, centered: on
    /// a tall phone it is as tall as the screen and a little wider, so a strip
    /// of canvas past each side is clipped.
    func testTheCanvasCoversTheCardAndIsCentered() {
        let phone = StoryStage.canvas(in: CGSize(width: 402, height: 781))
        XCTAssertEqual(phone.height, 781, accuracy: 0.5)
        XCTAssertEqual(phone.width, 781 * 9 / 16, accuracy: 0.5)
        XCTAssertLessThan(phone.minX, 0, "Wider than the screen: the sides are clipped")
        XCTAssertEqual(phone.midX, 201, accuracy: 0.5)
        XCTAssertEqual(phone.midY, 390.5, accuracy: 0.5)
        // A card already 9:16 is covered exactly.
        let exact = StoryStage.canvas(in: CGSize(width: 360, height: 640))
        XCTAssertEqual(exact, CGRect(x: 0, y: 0, width: 360, height: 640))
        // A wide card: as wide as the card, much taller than it.
        let window = StoryStage.canvas(in: CGSize(width: 900, height: 600))
        XCTAssertEqual(window.width, 900, accuracy: 0.5)
        XCTAssertGreaterThan(window.height, 600)
    }

    func testOnlyAPictureShapedLikeTheCanvasFillsIt() {
        XCTAssertTrue(StoryStage.fillsCanvas(width: 1080, height: 1920))
        XCTAssertTrue(StoryStage.fillsCanvas(width: 810, height: 1440))
        XCTAssertFalse(StoryStage.fillsCanvas(width: 1920, height: 1080), "Landscape is shown whole over a blur")
        XCTAssertFalse(StoryStage.fillsCanvas(width: 1080, height: 1350), "4:5 is shown whole over a blur")
        XCTAssertTrue(StoryStage.fillsCanvas(width: 1080, height: 2160), "Within 12% of 9:16 fills")
        XCTAssertFalse(StoryStage.fillsCanvas(width: 0, height: 0))
    }

    /// The same layer lands on the same fraction of the canvas whatever size
    /// the canvas is: what the author placed is what is seen.
    func testALayerKeepsItsPlaceAtAnySize() {
        let layer = StoryLayer(x: 0.25, y: 0.75, content: .text(StoryTextData(text: "oi")))
        for canvas in [CGSize(width: 360, height: 640), CGSize(width: 720, height: 1280)] {
            let center = CGPoint(x: layer.x * canvas.width, y: layer.y * canvas.height)
            XCTAssertEqual(center.x / canvas.width, 0.25, accuracy: 1e-9)
            XCTAssertEqual(center.y / canvas.height, 0.75, accuracy: 1e-9)
        }
        let small = StoryCanvas.fontSize(for: StoryTextData(text: "x", size: 2), canvasWidth: 360)
        let big = StoryCanvas.fontSize(for: StoryTextData(text: "x", size: 2), canvasWidth: 720)
        XCTAssertEqual(big / small, 2, accuracy: 1e-9, "Text scales with the canvas")
    }

    // MARK: - What is a door

    func testOnlyTheCallAndMentionsTakeTouches() {
        let call = StoryLayer(content: .call(serverId: server, channelId: room))
        let mention = StoryLayer(content: .mention(userId: "u", user: person("u", "Bia")))
        let text = StoryLayer(content: .text(StoryTextData(text: "oi")))
        let picture = StoryLayer(content: .image(StoryLayerPicture(url: "https://x.y/a.jpg", width: 10, height: 10)))
        XCTAssertTrue(call.isInteractiveInViewer)
        XCTAssertTrue(mention.isInteractiveInViewer)
        XCTAssertFalse(text.isInteractiveInViewer)
        XCTAssertFalse(picture.isInteractiveInViewer)
    }

    func testAStoryWithLayersUsesThemAndAnOldCardKeepsItsLine() throws {
        func story(_ layers: String) throws -> Story {
            try Coding.decoder.decode(Story.self, from: Data("""
            {"id":"\(room)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"text","caption":null,"text":"velho","background":"night","media":null,
             "sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":true,"replyBlockedReason":null,"canModerate":[]},"own":null,"layers":\(layers)}
            """.utf8))
        }
        XCTAssertFalse(StoryStage.usesLayers(try story("[]")))
        XCTAssertTrue(StoryStage.usesLayers(try story(#"[{"id":"a","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"novo"}]"#)))
    }

    // MARK: - The call sticker

    func testALiveCallShowsTheRoomTheServerAndWhoIsIn() {
        let data = StoryCallStickerData(live: live(), serverName: "QG do pqp", serverIconUrl: nil)
        XCTAssertEqual(data.state, .live)
        XCTAssertEqual(data.roomName, "Lobby")
        XCTAssertEqual(data.serverName, "QG do pqp")
        XCTAssertEqual(data.count, 2)
        XCTAssertEqual(data.participants.map(\.displayName), ["Ana Costa", "Bia Souza"])
        XCTAssertTrue(data.joinable)
    }

    func testEndedAndFullAndEmptyAreEachTheirOwnState() {
        XCTAssertEqual(StoryCallStickerData(live: live(state: "ended", count: 0, joinable: false, people: []), serverName: "QG", serverIconUrl: nil).state, .ended)
        XCTAssertEqual(StoryCallStickerData(live: live(state: "full", count: 8, joinable: false), serverName: "QG", serverIconUrl: nil).state, .full)
        let empty = StoryCallStickerData(live: live(state: "live", count: 0, people: []), serverName: "QG", serverIconUrl: nil)
        XCTAssertEqual(empty.state, .live)
        XCTAssertEqual(empty.count, 0, "A live room nobody is in says so, it does not pulse")
    }

    func testAnUnknownCallStateIsTreatedAsEnded() {
        XCTAssertEqual(StoryCallStickerData(live: live(state: "melted", count: 0, people: []), serverName: "QG", serverIconUrl: nil).state, .ended)
    }

    func testTheStickerSaysItInWordsForVoiceOver() {
        let ended = StoryCallStickerData(live: live(state: "ended", count: 0, joinable: false, people: []), serverName: "QG", serverIconUrl: nil)
        let card = StoryCallStickerCard(data: ended, canvasWidth: 360)
        XCTAssertTrue(card.spokenDescription.contains("Lobby"))
        XCTAssertTrue(card.spokenDescription.contains(String(localized: "The call ended")))
        let liveCard = StoryCallStickerCard(data: StoryCallStickerData(live: live(), serverName: "QG", serverIconUrl: nil), canvasWidth: 360)
        XCTAssertTrue(liveCard.spokenDescription.contains("Ana Costa"))
        let empty = StoryCallStickerCard(data: StoryCallStickerData(live: live(count: 0, people: []), serverName: "QG", serverIconUrl: nil), canvasWidth: 360)
        XCTAssertTrue(empty.spokenDescription.contains(String(localized: "Nobody in the call right now")))
    }

    func testTheStickerIsTheSameProportionOnEveryCanvas() {
        // Everything in the card is a fraction of one unit, which is a fraction
        // of the canvas width, so a card is the same picture at any size.
        XCTAssertEqual(StoryCanvas.stickerWidthFraction * 400, 328, accuracy: 0.001)
    }

    // MARK: - Alt text

    func testTheStoryIsReadFromItsAltTextThenItsCaptionThenItsText() throws {
        func story(alt: String?, caption: String?, text: String?) throws -> Story {
            let altJSON = alt.map { "\"\($0)\"" } ?? "null"
            let captionJSON = caption.map { "\"\($0)\"" } ?? "null"
            let textJSON = text.map { "\"\($0)\"" } ?? "null"
            return try Coding.decoder.decode(Story.self, from: Data("""
            {"id":"\(room)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"text","caption":\(captionJSON),"text":\(textJSON),"background":"night","media":null,
             "sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":true,"replyBlockedReason":null,"canModerate":[]},"own":null,"altText":\(altJSON)}
            """.utf8))
        }
        XCTAssertEqual(try story(alt: "bora jogar", caption: "c", text: "t").spokenDescription, "bora jogar")
        XCTAssertEqual(try story(alt: nil, caption: "c", text: "t").spokenDescription, "c")
        XCTAssertEqual(try story(alt: nil, caption: nil, text: "t").spokenDescription, "t")
        XCTAssertNil(try story(alt: nil, caption: nil, text: nil).spokenDescription)
    }
}
