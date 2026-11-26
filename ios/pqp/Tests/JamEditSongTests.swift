import UIKit
import XCTest
@testable import pqp

// EDITING A SONG AND ADJUSTING A TAKE, end to end against a stubbed network:
// what each write puts on the wire, in which order, what a refusal does to the
// screen, and how a live frame and the writer's own answer reconcile. The rules
// themselves are in `JamTakeEditTests` (the web's numbers) and below.

// MARK: - Text, plans and refusals

final class JamEditRulesTests: XCTestCase {
    private func song(title: String = "In Bloom", artist: String? = "Nirvana", cover: String? = nil) -> JamSongSummary {
        JamSongSummary(id: "s1", channelId: "c1", serverId: "srv", title: title, artist: artist, coverUrl: cover)
    }

    // MARK: The same rule as the server's `jamTitleSchema`

    func testATitleIsCleanedTheWayTheServerStoresIt() {
        XCTAssertEqual(try JamText.title("  In \u{202E}  Bloom \n").get(), "In Bloom", "controls out, whitespace collapsed, ends trimmed")
        XCTAssertEqual(JamText.title("").mapError { $0 }, .failure(.empty))
        XCTAssertEqual(JamText.title("   ").mapError { $0 }, .failure(.empty))
        // Something typed that draws nothing is told apart from an empty field.
        XCTAssertEqual(JamText.title("\u{200B}\u{200B}").mapError { $0 }, .failure(.invisible))
        XCTAssertEqual(JamText.title("\u{0301}").mapError { $0 }, .failure(.invisible), "a combining mark on its own")
        XCTAssertEqual(JamText.title("\u{2800}").mapError { $0 }, .failure(.invisible), "the Braille blank")
        XCTAssertEqual(JamText.title("a\u{0007}").mapError { $0 }, .failure(.invisible), "a control character")
        // One visible character is enough: emoji sequences, Arabic and Hebrew pass.
        XCTAssertEqual(try JamText.title("\u{200B}x").get(), "\u{200B}x")
        XCTAssertNoThrow(try JamText.title("👨‍👩‍👧").get())
        XCTAssertNoThrow(try JamText.title("مرحبا").get())
    }

    func testTheLengthIsCountedInUTF16UnitsLikeTheServersSchemaAndTheFieldsMaxLength() {
        XCTAssertNoThrow(try JamText.title(String(repeating: "a", count: 100)).get())
        XCTAssertEqual(JamText.title(String(repeating: "a", count: 101)).mapError { $0 }, .failure(.long))
        // 51 astral characters are 102 UTF-16 units: over, though only 51 characters.
        XCTAssertEqual(JamText.title(String(repeating: "𝄞", count: 51)).mapError { $0 }, .failure(.long))
    }

    func testAnArtistIsNilWhenEmptyAndCutAtTheLimit() {
        XCTAssertNil(try JamText.artist("   ").get())
        XCTAssertEqual(try JamText.artist(" Nirvana ").get(), "Nirvana")
        XCTAssertEqual(try JamText.artist(String(repeating: "b", count: 130)).get()?.utf16.count, 100)
        XCTAssertEqual(JamText.artist("\u{200B}").mapError { $0 }, .failure(.invisible), "pasted nothing is refused, not read as none")
    }

    // MARK: What saving means

    func testAnUntouchedSheetIsNothingToSaveEvenForARowThatStillHoldsBidiControls() {
        let old = song(title: "In \u{202E}Bloom", artist: "Nir\u{2066}vana")
        let plan = JamSongEditPlan.make(song: old, draft: .init(title: "In Bloom", artist: "Nirvana"))
        XCTAssertTrue(plan.isEmpty, "opening the sheet is not a change")
    }

    func testOnlyWhatChangedIsSentAndAnEmptiedArtistIsNull() throws {
        let plan = JamSongEditPlan.make(song: song(), draft: .init(title: "In Bloom", artist: ""))
        XCTAssertNil(plan.patch?.title, "a title put back is not a write")
        XCTAssertEqual(plan.patch?.artist, .clear)
        let json = try JSONSerialization.jsonObject(with: Coding.encoder.encode(try XCTUnwrap(plan.patch))) as? [String: Any]
        XCTAssertEqual(json?.count, 1)
        XCTAssertTrue(json?["artist"] is NSNull, "`artist: null` is how an original is written")

        let both = JamSongEditPlan.make(song: song(), draft: .init(title: " Come  As You Are ", artist: "Nirvana"))
        let body = try JSONSerialization.jsonObject(with: Coding.encoder.encode(try XCTUnwrap(both.patch))) as? [String: Any]
        XCTAssertEqual(body?["title"] as? String, "Come As You Are")
        XCTAssertNil(body?["artist"], "an unchanged artist is not in the body")
    }

    func testTheCoverIsAWriteOnlyWhenThereIsSomethingToDo() {
        let none = song()
        let has = song(cover: "https://x.invalid/jam/s1/a.jpg?sig=1")
        XCTAssertNil(JamSongEditPlan.make(song: none, draft: .init(title: "In Bloom", artist: "Nirvana", cover: .remove)).cover,
                     "removing a cover from a song with none is nothing")
        XCTAssertEqual(JamSongEditPlan.make(song: has, draft: .init(title: "In Bloom", artist: "Nirvana", cover: .remove)).cover, .remove)
        XCTAssertEqual(JamSongEditPlan.make(song: none, draft: .init(title: "In Bloom", artist: "Nirvana", cover: .new(uploadId: "u"))).cover,
                       .set(uploadId: "u"))
        XCTAssertTrue(JamSongEditPlan.make(song: has, draft: .init(title: "In Bloom", artist: "Nirvana", cover: .keep)).isEmpty)
    }

    // MARK: Who may

    func testTheSongsAuthorOrAModeratorEditsWhileTheFlagIsOn() {
        let author = JamSongViewer(isAuthor: true, canModerate: false, addableInstruments: [], votedTrackIds: [])
        let moderator = JamSongViewer(isAuthor: false, canModerate: true, addableInstruments: [], votedTrackIds: [])
        let member = JamSongViewer(isAuthor: false, canModerate: false, addableInstruments: [.bass], votedTrackIds: [])
        XCTAssertTrue(JamPermissions.canEditSong(author, enabled: true))
        XCTAssertTrue(JamPermissions.canEditSong(moderator, enabled: true))
        XCTAssertFalse(JamPermissions.canEditSong(member, enabled: true))
        XCTAssertFalse(JamPermissions.canEditSong(author, enabled: false), "jam_channels off hides it")
        XCTAssertFalse(JamPermissions.canEditSong(.none, enabled: true))
    }

    // MARK: What a refusal says

    func testRefusalsAreToldApart() {
        func server(_ status: Int, _ message: String) -> JamEditFailure { JamEditFailure.of(APIError.server(status: status, message: message)) }
        XCTAssertEqual(server(403, "jam_channels_off"), .kind(.off), "the flag is its own sentence")
        XCTAssertEqual(server(403, "You cannot edit this song"), .denied, "the permission 403 carries a sentence, not a token")
        XCTAssertEqual(server(403, "Only the song's author or a moderator sets the mix"), .denied)
        XCTAssertEqual(server(400, "Invalid body"), .invalid)
        XCTAssertEqual(server(413, "jam_upload_too_large"), .kind(.tooLarge))
        XCTAssertEqual(server(503, "jam_storage_off"), .kind(.storageOff))
        XCTAssertEqual(server(429, "jam_rate_limited"), .kind(.rateLimited))
        XCTAssertEqual(JamEditFailure.of(APIError.notFound("x")), .kind(.gone))
        XCTAssertEqual(JamEditFailure.of(APIError.transport("offline")), .kind(.network))
        XCTAssertEqual(JamEditFailure.of(URLError(.notConnectedToInternet)), .kind(.network))
        XCTAssertTrue(JamEditFailure.denied.isDenied)
        XCTAssertFalse(JamEditFailure.kind(.off).isDenied)
    }

    func testAnOverTheLimitCoverUploadIsTheCoversOwnSentence() {
        XCTAssertEqual(JamEditSongModel.problem(for: APIError.server(status: 413, message: "jam_upload_too_large")), .tooLarge)
        XCTAssertEqual(JamEditSongModel.problem(for: APIError.transport("offline")), .failed)
    }

    // MARK: The picture

    func testACoverMustBeBigEnoughAndFitUnderTheCeiling() {
        XCTAssertNil(JamCoverRules.check(width: 400, height: 4000))
        XCTAssertEqual(JamCoverRules.check(width: 399, height: 1000), .small(width: 399, height: 1000))
        XCTAssertEqual(JamCoverRules.check(width: 0, height: 0), .unreadable)
        XCTAssertTrue(JamCoverRules.fits(byteCount: 4 * 1024 * 1024))
        XCTAssertFalse(JamCoverRules.fits(byteCount: 4 * 1024 * 1024 + 1))
        XCTAssertFalse(JamCoverRules.fits(byteCount: 0))
        XCTAssertEqual(JamCoverRules.contentTypes, ["image/jpeg", "image/png", "image/webp"], "the contract's JAM_COVER_CONTENT_TYPES")
        XCTAssertEqual(JamCoverRules.size, 1024)
    }

    /// A real picture, through the real ImageIO path: a wide PNG becomes a 1024
    /// square JPEG, under the ceiling, which is what the ticket is minted for.
    func testAPickedPhotoBecomesASquareJPEGUnderTheLimit() throws {
        let wide = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 900)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1600, height: 900))
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 700, y: 300, width: 200, height: 300))
        }
        let prepared = try JamCoverPrep.prepare(data: try XCTUnwrap(wide.pngData())).get()
        XCTAssertEqual(Array(prepared.jpeg.prefix(2)), [0xFF, 0xD8], "a JPEG")
        XCTAssertTrue(JamCoverRules.fits(byteCount: prepared.jpeg.count))
        XCTAssertEqual(prepared.preview.size.width * prepared.preview.scale, 1024, accuracy: 1)
        XCTAssertEqual(prepared.preview.size.height * prepared.preview.scale, 1024, accuracy: 1)
    }

    /// The library hands over a FILE, which ImageIO reads as it needs it.
    func testAPhotoIsPreparedFromAFileWithoutReadingItWhole() async throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 900), format: format).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1200, height: 900))
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("jam-test-\(UUID().uuidString).png")
        try XCTUnwrap(image.pngData()).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let prepared = try JamCoverPrep.prepare(file: file).get()
        XCTAssertEqual(Array(prepared.jpeg.prefix(2)), [0xFF, 0xD8])
        // The queue the app uses decodes one at a time and answers the same.
        let serial = try await JamCoverPrep.prepareSerially(file: file).get()
        XCTAssertEqual(serial.jpeg.count, prepared.jpeg.count)
        XCTAssertEqual(prepared.preview.size.width * prepared.preview.scale, 1024, accuracy: 1)
        if case .failure(let problem) = JamCoverPrep.prepare(file: file.appendingPathExtension("missing")) {
            XCTAssertEqual(problem, .unreadable)
        } else {
            XCTFail("a file that is not there is unreadable")
        }
    }

    func testATooSmallPhotoAndANonImageAreRefusedBeforeAnythingIsEncoded() throws {
        // Scale 1: a point is a pixel, so this really is a 300 px side.
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 900), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 300, height: 900))
        }
        if case .failure(let problem) = JamCoverPrep.prepare(data: try XCTUnwrap(small.pngData())) {
            XCTAssertEqual(problem, .small(width: 300, height: 900))
        } else {
            XCTFail("a 300 px side is too small to be a cover")
        }
        if case .failure(let problem) = JamCoverPrep.prepare(data: Data("not a picture".utf8)) {
            XCTAssertEqual(problem, .unreadable)
        } else {
            XCTFail("text is not a picture")
        }
    }

    func testTheUploadTicketRequestForACoverIsKindCoverWithTheExactLength() throws {
        let body = JamUploadRequest.cover(contentType: "image/jpeg", byteSize: 123_456)
        let json = try JSONSerialization.jsonObject(with: Coding.encoder.encode(body)) as? [String: Any]
        XCTAssertEqual(json?["kind"] as? String, "cover")
        XCTAssertEqual(json?["contentType"] as? String, "image/jpeg")
        XCTAssertEqual(json?["byteSize"] as? Int, 123_456)
    }
}

// MARK: - A stubbed network

private struct EditTestToken: TokenProviding {
    func currentToken() async -> String? { "stub" }
    func refreshedToken() async -> TokenRefresh { .token("stub") }
}

/// What the app sent, in order.
private struct SentRequest: @unchecked Sendable {
    let method: String
    let path: String
    let json: [String: Any]?
}

private func bodyOf(_ request: URLRequest) -> [String: Any]? {
    var data = request.httpBody
    if data == nil, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            collected.append(buffer, count: n)
        }
        data = collected
    }
    return data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
}

private func songJSON(title: String = "In Bloom", artist: String? = "Nirvana", cover: String? = nil) -> String {
    """
    {"id":"s1","channelId":"chan-1","serverId":"srv-1","title":"\(title)","artist":\(artist.map { "\"\($0)\"" } ?? "null"),
     "joinMode":"open","wantedInstruments":[],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
     "createdAt":"2026-11-09T22:00:01.000Z","updatedAt":"2026-11-09T22:01:40.000Z","trackCount":1,"instruments":["guitar"],
     "contributorCount":1,"mixDurationMs":1000,"coverUrl":\(cover.map { "\"\($0)\"" } ?? "null")}
    """
}

private func trackJSON(
    offset: Double = 0, trimStart: Double = 0, trimEnd: Double = 0, gain: Double = 1,
    author: String = "u1", votes: Int = 0, label: String? = nil
) -> String {
    """
    {"id":"t1","songId":"s1","authorId":"\(author)","authorName":"rafa","authorAvatarUrl":null,
     "instrument":"guitar","label":\(label.map { "\"\($0)\"" } ?? "null"),"audioUrl":"https://example.invalid/a.m4a","audioContentType":"audio/mp4","audioBytes":10,
     "videoUrl":null,"videoContentType":null,"videoBytes":null,"mediaExpiresAt":"2026-11-10T10:00:00.000Z",
     "offsetMs":\(offset),"trimStartMs":\(trimStart),"trimEndMs":\(trimEnd),"durationMs":8000,"gain":\(gain),"peaks":[0.5,0.9,0.4],"inMix":true,
     "voteCount":\(votes),"createdAt":"2026-11-09T22:01:00.000Z"}
    """
}

private let detailJSON = """
{"song":\(songJSON()),"tracks":[\(trackJSON())],"viewer":{"isAuthor":true,"canModerate":false,"addableInstruments":[],"votedTrackIds":[]}}
"""

private let editChannel: Channel = try! Coding.decoder.decode(Channel.self, from: Data("""
{"id":"chan-1","serverId":"srv-1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}
""".utf8))

private let editServer = Server(id: "srv-1", name: "S", ownerId: "u1", role: "owner", createdAt: Date())

@MainActor
private func makeEditSession() -> SessionStore {
    let api = APIClient(tokenProvider: EditTestToken(), protocolClasses: [JamStubURLProtocol.self])
    return SessionStore(authMode: .devBypass, tokenProvider: EditTestToken(), api: api)
}

/// Routes the app's requests: the config and the detail read are fixed, the
/// writes are the test's.
private func route(
    log: LockedBox<[SentRequest]>,
    writeDelay: TimeInterval = 0,
    writes: @escaping @Sendable (URLRequest) -> (Int, String)
) -> @Sendable (URLRequest) -> (TimeInterval, Int, Data) {
    { request in
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        if method == "GET" {
            if path.hasSuffix("/api/jam/config") { return (0, 200, Data("{\"enabled\":true,\"uploads\":true}".utf8)) }
            if path.hasSuffix("/api/jam-songs/s1") {
                log.value.append(SentRequest(method: method, path: path, json: nil))
                return (0, 200, Data(detailJSON.utf8))
            }
            return (0, 200, Data("{}".utf8))
        }
        log.value.append(SentRequest(method: method, path: path, json: bodyOf(request)))
        let (status, body) = writes(request)
        return (writeDelay, status, Data(body.utf8))
    }
}

@MainActor
private func startedModel(session: SessionStore) async throws -> JamSongModel {
    let model = JamSongModel(
        song: try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON().utf8)),
        channel: editChannel, server: editServer, audioSession: JamAudioSession(driver: FakeAudioDriver())
    )
    await model.start(session: session)
    return model
}

// MARK: - Saving a song edit

@MainActor
final class JamEditSongModelTests: XCTestCase {
    private var keep: SessionStore?

    func testSaveSendsTheTextThenTheCoverClaimInThatOrderAndAppliesEachAnswer() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/cover") { return (200, "{\"song\":\(songJSON(title: "Come As You Are", artist: nil, cover: "https://x.invalid/jam/s1/new.jpg?sig=2"))}") }
            return (200, "{\"song\":\(songJSON(title: "Come As You Are", artist: nil))}")
        }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        XCTAssertTrue(song.canEditSong, "the author, flag on")

        let edit = JamEditSongModel(song: song)
        edit.titleEdit = "  Come  As You Are "
        edit.artistEdit = ""
        // The cover half of a pick is the picker and the bucket: its end state is what a landed upload leaves.
        edit.adopt(uploadId: "11111111-1111-1111-1111-111111111111", preview: nil)
        XCTAssertTrue(edit.canSave)
        let landed = await edit.save(api: session.api)
        XCTAssertTrue(landed)

        let writes = log.value.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.method), ["PATCH", "PUT"], "the text, then the picture")
        XCTAssertEqual(writes[0].path, "/api/jam-songs/s1")
        XCTAssertEqual(writes[0].json?["title"] as? String, "Come As You Are")
        XCTAssertTrue(writes[0].json?["artist"] is NSNull)
        XCTAssertEqual(writes[1].path, "/api/jam-songs/s1/cover")
        XCTAssertEqual(writes[1].json?["uploadId"] as? String, "11111111-1111-1111-1111-111111111111")
        // Each answer is the song as it now is, and the screen shows it.
        XCTAssertEqual(song.song.title, "Come As You Are")
        XCTAssertNil(song.song.artist)
        XCTAssertNotNil(song.song.cover)
        song.stop()
    }

    func testRemovingTheCoverIsADeleteAndNothingElse() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{\"song\":\(songJSON())}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        // The song has a cover for this one.
        song.applySongEdit(try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON(cover: "https://x.invalid/jam/s1/a.jpg?sig=1").utf8)))
        let edit = JamEditSongModel(song: song)
        edit.removePhoto()
        XCTAssertEqual(edit.note, .removed)
        let landed = await edit.save(api: session.api)
        XCTAssertTrue(landed)
        let writes = log.value.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.method), ["DELETE"])
        XCTAssertEqual(writes.first?.path, "/api/jam-songs/s1/cover")
        song.stop()
    }

    func testAnOlderAnswerDoesNotGoOverANewerChangeThatArrivedFirst() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let newer = songJSON(title: "Newer from a moderator").replacingOccurrences(of: "22:01:40", with: "22:05:00")
        song.applySongEdit(try Coding.decoder.decode(JamSongSummary.self, from: Data(newer.utf8)))
        XCTAssertEqual(song.song.title, "Newer from a moderator")
        // This phone's own request, answered late: it was made before that change.
        song.applySongEdit(try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON(title: "Older answer").utf8)))
        XCTAssertEqual(song.song.title, "Newer from a moderator")
        song.stop()
    }

    func testANothingToSaveSheetSendsNothing() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let edit = JamEditSongModel(song: song)
        XCTAssertFalse(edit.canSave)
        XCTAssertFalse(edit.isDirty)
        let landed = await edit.save(api: session.api)
        XCTAssertFalse(landed)
        XCTAssertTrue(log.value.filter { $0.method != "GET" }.isEmpty)
        // And a title typed empty is a problem the sheet says at once, and cannot be saved.
        edit.titleEdit = "   "
        XCTAssertEqual(edit.titleProblem, .empty)
        XCTAssertTrue(edit.showsTitleProblem)
        XCTAssertFalse(edit.canSave)
        song.stop()
    }

    func testASaveCannotRunWhileAPickedPhotoIsStillBeingPrepared() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{\"song\":\(songJSON(title: "Another name"))}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let edit = JamEditSongModel(song: song)
        edit.titleEdit = "Another name"
        XCTAssertTrue(edit.canSave)
        // The person picked a photo: it is read and framed before any byte is sent.
        _ = edit.beginPick()
        XCTAssertEqual(edit.upload, .preparing)
        XCTAssertTrue(edit.isUploading)
        XCTAssertTrue(edit.isDirty, "closing now would drop the pick, so it asks first")
        XCTAssertFalse(edit.canSave, "Save waits for the photo, or the sheet would close over it")
        let landed = await edit.save(api: session.api)
        XCTAssertFalse(landed)
        XCTAssertTrue(log.value.filter { $0.method != "GET" }.isEmpty, "nothing was sent")
        // Even a sheet with no text change is not done while the photo is.
        let bare = JamEditSongModel(song: song)
        _ = bare.beginPick()
        XCTAssertTrue(bare.isDirty)
        // A later pick replaces the earlier one: the older worker's answer is stale.
        let first = edit.beginPick()
        let second = edit.beginPick()
        XCTAssertGreaterThan(second, first)
        song.stop()
    }

    func testAPermissionRefusalIsSaidAndThePermissionsAreReadAgain() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (403, "{\"error\":\"You cannot edit this song\"}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let reads = { log.value.filter { $0.method == "GET" }.count }
        let before = reads()
        let edit = JamEditSongModel(song: song)
        edit.titleEdit = "Another name"
        let landed = await edit.save(api: session.api)
        XCTAssertFalse(landed)
        XCTAssertEqual(edit.failure, .denied)
        XCTAssertGreaterThan(reads(), before, "the song's viewer permissions were read again")
        XCTAssertEqual(song.song.title, "In Bloom", "nothing was applied")
        song.stop()
    }

    func testThePausedFlagIsItsOwnRefusalAndStaysFinal() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (403, "{\"error\":\"jam_channels_off\"}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let edit = JamEditSongModel(song: song)
        edit.titleEdit = "Another name"
        let landed = await edit.save(api: session.api)
        XCTAssertFalse(landed)
        XCTAssertEqual(edit.failure, .kind(.off))
        song.stop()
    }
}

// MARK: - Adjusting a take

@MainActor
final class JamAdjustModelTests: XCTestCase {
    private var keep: SessionStore?

    private func frame(_ json: String) throws -> RealtimeEvent {
        .jam(try XCTUnwrap(JamFrame.parse(Data(json.utf8))))
    }

    private func trackUpdated(_ track: String) -> String {
        "{\"type\":\"jam-track-updated\",\"channelId\":\"chan-1\",\"song\":\(songJSON()),\"track\":\(track)}"
    }

    func testChangesAreHeardAtOnceAndNothingIsSentUntilSave() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        let adjust = JamAdjustModel(song: song, track: track)

        adjust.nudge(by: 10)
        adjust.gain(0.5)
        // The engine is told through the model's one `effective` view of the track.
        let heard = song.effective(track)
        XCTAssertEqual(heard.offsetMs, 10)
        XCTAssertEqual(heard.gain, 0.5)
        XCTAssertEqual(song.tracks.first?.offsetMs, 0, "what is stored has not moved")
        XCTAssertTrue(adjust.isDirty)
        XCTAssertTrue(log.value.filter { $0.method != "GET" }.isEmpty, "nothing has been sent")

        // Back to what is stored: the preview is gone, the engine hears the stored numbers.
        adjust.reset()
        XCTAssertEqual(song.effective(track).offsetMs, 0)
        XCTAssertEqual(song.effective(track).gain, 1)
        XCTAssertFalse(adjust.isDirty)
        song.stop()
    }

    func testSaveSendsOnlyWhatChangedAndTheAnswerBecomesTheStoredTake() async throws {
        let log = LockedBox<[SentRequest]>([])
        let answer = "{\"track\":\(trackJSON(offset: 10, gain: 0.5)),\"song\":\(songJSON())}"
        JamStubURLProtocol.handler = route(log: log) { _ in (200, answer) }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        let adjust = JamAdjustModel(song: song, track: track)
        adjust.nudge(by: 10)
        adjust.gain(0.5)

        let landed = await adjust.save()
        XCTAssertTrue(landed)
        let writes = log.value.filter { $0.method != "GET" }
        XCTAssertEqual(writes.map(\.method), ["PATCH"])
        XCTAssertEqual(writes.first?.path, "/api/jam-tracks/t1")
        XCTAssertEqual(Set(writes.first?.json?.keys.map { $0 } ?? []), ["offsetMs", "gain"], "no trims, no mix switch")
        XCTAssertEqual(writes.first?.json?["offsetMs"] as? Double, 10)
        XCTAssertEqual(writes.first?.json?["gain"] as? Double, 0.5)
        XCTAssertEqual(song.tracks.first?.offsetMs, 10)
        XCTAssertEqual(song.tracks.first?.gain, 0.5)
        XCTAssertEqual(song.effective(try XCTUnwrap(song.tracks.first)).offsetMs, 10)
        song.stop()
    }

    func testNothingIsEditedWhileASaveIsOut() async throws {
        let log = LockedBox<[SentRequest]>([])
        let answer = "{\"track\":\(trackJSON(offset: 10)),\"song\":\(songJSON())}"
        JamStubURLProtocol.handler = route(log: log, writeDelay: 0.4) { _ in (200, answer) }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let adjust = JamAdjustModel(song: song, track: try XCTUnwrap(song.tracks.first))
        adjust.nudge(by: 10)
        let saving = Task { await adjust.save() }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(adjust.saving)
        // A drag after the request left would live in the draft only, and the answer closes the sheet over it.
        adjust.nudge(by: 50)
        adjust.gain(1.8)
        adjust.reset()
        XCTAssertEqual(adjust.edits.nudgeMs, 10)
        XCTAssertEqual(adjust.edits.gain, 1)
        let landed = await saving.value
        XCTAssertTrue(landed)
        XCTAssertEqual(song.tracks.first?.offsetMs, 10)
        // Editable again once it has landed or failed.
        adjust.nudge(by: 5)
        XCTAssertEqual(adjust.edits.nudgeMs, 15)
        song.stop()
    }

    func testARefusedSaveKeepsTheEditsAndSaysWhy() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (403, "{\"error\":\"You cannot edit somebody else's track\"}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        let adjust = JamAdjustModel(song: song, track: track)
        adjust.nudge(by: 20)
        let landed = await adjust.save()
        XCTAssertFalse(landed)
        XCTAssertEqual(adjust.failure, .denied)
        XCTAssertEqual(adjust.edits.nudgeMs, 20, "the person's edits are still there")
        XCTAssertEqual(song.tracks.first?.offsetMs, 0)
        XCTAssertFalse(adjust.saving)
        // Moving anything clears the line, so it never reads as being about the next try.
        adjust.nudge(by: 10)
        XCTAssertNil(adjust.failure)
        song.stop()
    }

    func testThePausedFlagIsHandledOnATakeSaveToo() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (403, "{\"error\":\"jam_channels_off\"}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let adjust = JamAdjustModel(song: song, track: try XCTUnwrap(song.tracks.first))
        adjust.gain(1.5)
        let landed = await adjust.save()
        XCTAssertFalse(landed)
        XCTAssertEqual(adjust.failure, .kind(.off))
        song.stop()
    }

    func testALiveFrameThatMovedTheTakeStartsTheEditsOverAndAVoteDoesNot() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        let adjust = JamAdjustModel(song: song, track: track)
        adjust.nudge(by: 30)
        adjust.gain(1.5)

        // Somebody votes and the label changes: the stored numbers the edits start from did not move.
        song.apply(try frame(trackUpdated(trackJSON(votes: 4, label: "take 2"))))
        adjust.reconcile()
        XCTAssertEqual(adjust.edits.nudgeMs, 30)
        XCTAssertEqual(adjust.edits.gain, 1.5)
        XCTAssertEqual(song.tracks.first?.voteCount, 4)

        // The same account changed the take on the web: its numbers are the truth, the preview is dropped.
        song.apply(try frame(trackUpdated(trackJSON(offset: -60, gain: 0.8))))
        adjust.reconcile()
        XCTAssertEqual(adjust.edits.nudgeMs, 0)
        XCTAssertEqual(adjust.edits.gain, 0.8)
        XCTAssertFalse(adjust.isDirty)
        let stored = try XCTUnwrap(song.tracks.first)
        XCTAssertEqual(stored.offsetMs, -60)
        XCTAssertEqual(song.effective(stored).offsetMs, -60, "the engine follows the stored numbers again")
        XCTAssertEqual(song.effective(stored).gain, 0.8)
        song.stop()
    }

    func testTheWritersOwnEchoWhileTheSaveIsOutDoesNotThrowTheDraftAway() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        var draft = JamAdjustDraft(track: track)
        draft.set(draft.edits.withNudge(25))
        song.apply(try frame(trackUpdated(trackJSON(offset: 25))))
        // The frame beat the HTTP answer: with the save out, the draft stays and is what the answer will equal.
        XCTAssertFalse(draft.reconcile(with: try XCTUnwrap(song.tracks.first), saving: true))
        XCTAssertEqual(draft.edits.nudgeMs, 25)
        song.stop()
    }

    func testATakeDeletedUnderTheSheetLeavesNoTrackToAdjust() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        let adjust = JamAdjustModel(song: song, track: track)
        song.apply(try frame("{\"type\":\"jam-track-deleted\",\"channelId\":\"chan-1\",\"song\":\(songJSON()),\"trackId\":\"t1\"}"))
        XCTAssertNil(adjust.track)
        XCTAssertNil(adjust.source)
        let landed = await adjust.save()
        XCTAssertFalse(landed, "nothing to save for a take that is gone")
        song.stop()
    }

    func testOnlyTheTakesAuthorIsOfferedTheAdjuster() async throws {
        let log = LockedBox<[SentRequest]>([])
        JamStubURLProtocol.handler = route(log: log) { _ in (200, "{}") }
        let session = makeEditSession()
        keep = session
        let song = try await startedModel(session: session)
        let track = try XCTUnwrap(song.tracks.first)
        // No signed-in account in this stub: nobody is the author, so nobody is offered it.
        XCTAssertFalse(song.canAdjust(track))
        song.beginAdjust(track)
        XCTAssertNil(song.adjustingTrack, "asked anyway, the model still refuses")
        song.stop()
    }
}
