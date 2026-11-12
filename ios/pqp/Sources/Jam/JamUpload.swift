import Foundation

/// STEP TWO OF ADDING A TRACK: the bytes go straight to the bucket, never
/// through the API. The request MUST send exactly the `Content-Type` that was
/// asked for and a `Content-Length` of exactly `byteSize` (both are signed into
/// the URL; any other body is refused by the bucket), which is why the size is
/// read from the file being sent and not from anywhere else.
enum JamStorageUpload {
    enum UploadError: Error, Equatable {
        case badURL
        case rejected(Int)
    }

    /// PUT a file. `progress` is 0...1 and is called off the main actor.
    static func put(
        file: URL, to address: String, contentType: String,
        session: URLSession = .shared,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        guard let url = JamMediaURL.allowed(address) else { throw UploadError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        let delegate = Progress(report: progress)
        let (_, response) = try await session.upload(for: request, fromFile: file, delegate: delegate)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw UploadError.rejected((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        progress(1)
    }

    private final class Progress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Double) -> Void
        init(report: @escaping @Sendable (Double) -> Void) { self.report = report }

        func urlSession(
            _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
            totalBytesSent: Int64, totalBytesExpectedToSend: Int64
        ) {
            guard totalBytesExpectedToSend > 0 else { return }
            report(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
        }
    }
}

/// A take on its way up, and what has already been done for it. Kept across
/// retries because the claim is idempotent on `audioUploadId`: a retry after a
/// lost answer must name the SAME upload, so each try does only what is not
/// done yet (a stored file is not sent again, a ticket still good is reused, a
/// claim that already succeeded is returned as it was).
struct JamPostState: Equatable, Sendable {
    var ticket: JamUploadTicket?
    var stored = false
    var result: JamTrackWithSongBox?

    /// A ticket is good for 15 minutes; one with under a minute left is not
    /// worth the PUT.
    func ticketUsable(now: Date = Date()) -> Bool {
        guard let ticket else { return false }
        guard let expires = ticket.expiresAt else { return true }
        return expires.timeIntervalSince(now) > 60
    }
}

/// `JamTrackWithSong` is not Equatable; the state is, for the tests.
struct JamTrackWithSongBox: Equatable, Sendable {
    let value: JamTrackWithSong
    static func == (lhs: JamTrackWithSongBox, rhs: JamTrackWithSongBox) -> Bool {
        lhs.value.track.id == rhs.value.track.id
    }
}
