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

    /// The author's canvas is never cropped: it is the biggest 9:16 box that
    /// FITS the card, centered; the rest of the card is filled by the base.
    func testTheCanvasFitsTheCardAndIsNeverCropped() {
        let phone = StoryStage.canvas(in: CGSize(width: 402, height: 781))
        XCTAssertEqual(phone.width, 402, accuracy: 0.5, "As wide as the card")
        XCTAssertEqual(phone.height, 402 * 16 / 9, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(phone.minX, 0)
        XCTAssertGreaterThanOrEqual(phone.minY, 0)
        XCTAssertLessThanOrEqual(phone.maxY, 781, "Inside the card on every side")
        XCTAssertEqual(phone.midX, 201, accuracy: 0.5)
        XCTAssertEqual(phone.midY, 390.5, accuracy: 0.5)
        // A card already 9:16 is filled exactly.
        XCTAssertEqual(StoryStage.canvas(in: CGSize(width: 360, height: 640)), CGRect(x: 0, y: 0, width: 360, height: 640))
        // A wide card: as tall as the card, with room left and right.
        let window = StoryStage.canvas(in: CGSize(width: 900, height: 600))
        XCTAssertEqual(window.height, 600, accuracy: 0.5)
        XCTAssertEqual(window.width, 337.5, accuracy: 0.5)
        XCTAssertEqual(window.midX, 450, accuracy: 0.5)
    }

    /// The same canvas the editor uses, so a layer is where it was placed.
    func testTheViewerAndTheEditorShareTheCanvasRule() {
        for size in [CGSize(width: 402, height: 781), CGSize(width: 440, height: 900), CGSize(width: 320, height: 500)] {
            let width = min(size.width, size.height * StoryCanvas.aspect)
            let viewer = StoryStage.canvas(in: size)
            XCTAssertEqual(viewer.width, width, accuracy: 0.001)
            XCTAssertEqual(viewer.height, width / StoryCanvas.aspect, accuracy: 0.001)
        }
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

    /// The caption is the old builds' copy of the text layers. A story with text
    /// layers speaks through them once: the pill is not drawn (web's rule).
    func testTheCaptionPillIsOnlyForAStoryWithoutTextLayers() throws {
        func story(kind: String = "image", caption: String?, layers: String) throws -> Story {
            let captionJSON = caption.map { "\"\($0)\"" } ?? "null"
            return try Coding.decoder.decode(Story.self, from: Data("""
            {"id":"\(room)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"\(kind)","caption":\(captionJSON),"text":null,"background":null,"media":null,
             "sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":true,"replyBlockedReason":null,"canModerate":[]},"own":null,"layers":\(layers)}
            """.utf8))
        }
        let text = #"{"id":"a","type":"text","x":0.5,"y":0.5,"scale":1,"rotation":0,"text":"oi"}"#
        let mention = #"{"id":"b","type":"mention","x":0.5,"y":0.3,"scale":1,"rotation":0,"userId":"u2"}"#
        XCTAssertEqual(try story(caption: "legenda velha", layers: "[]").legacyCaption, "legenda velha", "A photo from before layers keeps its pill")
        XCTAssertNil(try story(caption: "oi", layers: "[\(text)]").legacyCaption, "Text layers draw those words once")
        XCTAssertNil(try story(caption: "oi", layers: "[\(mention),\(text)]").legacyCaption)
        XCTAssertNil(try story(caption: nil, layers: "[]").legacyCaption)
        XCTAssertNil(try story(caption: "", layers: "[]").legacyCaption)
        XCTAssertNil(try story(kind: "text", caption: "x", layers: "[]").legacyCaption, "A text card never draws it")
    }

    func testOnlyAStoryWithACallIsKeptFresh() throws {
        func story(call: String) throws -> Story {
            try Coding.decoder.decode(Story.self, from: Data("""
            {"id":"\(room)","author":{"id":"u","displayName":"Bia","avatarUrl":null},"kind":"text","caption":null,"text":"x","background":"night","media":null,
             "sticker":null,"call":\(call),"publishedAt":null,"expiresAt":null,"audiences":[],
             "viewer":{"seen":false,"reaction":null,"canReply":true,"replyBlockedReason":null,"canModerate":[]},"own":null,"layers":[]}
            """.utf8))
        }
        let withCall = try story(call: #"{"serverId":"\#(server)","channelId":"\#(room)","channelName":"Lobby","participants":[],"count":0,"state":"live","joinable":true}"#)
        XCTAssertTrue(StoryCallRefresh.watches(withCall))
        XCTAssertFalse(StoryCallRefresh.watches(try story(call: "null")))
        XCTAssertLessThanOrEqual(StoryCallRefresh.delay(unchanged: 0, random: 1), .seconds(7), "A card that stays on 'nobody' for long reads as broken")
        XCTAssertEqual(StoryCallRefresh.delay(unchanged: 0, random: 0), .seconds(6))
        XCTAssertEqual(StoryCallRefresh.delay(unchanged: 99, random: 0), .seconds(40), "It backs off to a slow beat and stays there")
        XCTAssertGreaterThan(StoryCallRefresh.delay(unchanged: 3, random: 0), StoryCallRefresh.delay(unchanged: 1, random: 0))
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

    /// Live whenever the room exists and the author can still use it, with
    /// nobody in it too: "Ninguem na call agora" and the door.
    func testAnEmptyLiveRoomKeepsItsDoor() {
        let data = StoryCallStickerData(live: live(state: "live", count: 0, joinable: true, people: []), serverName: "QG", serverIconUrl: nil)
        XCTAssertEqual(data.state, .live)
        XCTAssertEqual(data.count, 0)
        XCTAssertTrue(data.joinable)
        let card = StoryCallStickerCard(data: data, canvasWidth: 360)
        XCTAssertTrue(card.spokenDescription.contains(String(localized: "Nobody in the call right now")))
        XCTAssertFalse(card.spokenDescription.contains(String(localized: "The call ended")))
    }

    /// The editor's card is in the viewer's states with the viewer's words: an
    /// empty room says so there too, instead of a "Live" it is not.
    func testTheEditorsCardSaysTheSameThingForAnEmptyRoomAsTheViewer() {
        let viewer = StoryCallStickerData(live: live(state: "live", count: 0, joinable: true, people: []), serverName: "QG", serverIconUrl: nil)
        let editor = StoryCallStickerData(
            roomName: viewer.roomName, serverName: "QG", serverId: viewer.serverId, serverIconUrl: nil,
            participants: [], count: 0, state: .live, joinable: true, isPreview: true
        )
        XCTAssertEqual(
            StoryCallStickerCard(data: editor, canvasWidth: 360).spokenDescription,
            StoryCallStickerCard(data: viewer, canvasWidth: 360).spokenDescription
        )
        XCTAssertTrue(StoryCallStickerCard(data: editor, canvasWidth: 360).spokenDescription.contains(String(localized: "Nobody in the call right now")))
    }

    /// A viewer without CONNECT sees the room live, with no door.
    func testAViewerWithoutConnectSeesItLiveWithNoDoor() {
        let data = StoryCallStickerData(live: live(state: "live", count: 2, joinable: false), serverName: "QG", serverIconUrl: nil)
        XCTAssertEqual(data.state, .live)
        XCTAssertFalse(data.joinable)
    }

    /// A deleted channel arrives with no name: the card still says what it is.
    func testAnEndedCallWithNoNameStillSaysCall() {
        let data = StoryCallStickerData(live: StoryCallLive(
            serverId: server, channelId: room, channelName: "", participants: [], count: 0, state: "ended", joinable: false
        ), serverName: "QG", serverIconUrl: nil)
        XCTAssertEqual(data.state, .ended)
        XCTAssertEqual(data.roomName, String(localized: "Call"))
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
