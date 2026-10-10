import Foundation

// Writing a Baú post, the rules the server applies, said once.
//
// Every number here is a hand-copy of `packages/shared/src/community-home.ts`
// and every check is one the server repeats. The phone checks first only so a
// refusal arrives before a 40 MB upload rather than after it; the server stays
// the authority, which is also why nothing here decides who may post.

enum CommunityHomeLimits {
    static let titleMax = 200
    static let bodyMax = 4000
    /// `COMMUNITY_HOME_MAX_BYTES`: 100 MiB per file.
    static let maxBytes: Int64 = 100 * 1024 * 1024
    /// What the system picker may hand back. The shared allowlist also carries
    /// `application/pdf`, which is not a photo or a video and has no place
    /// behind a photo picker; a PDF is still welcome from the web.
    static let pickerContentTypes = [
        "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm",
    ]
}

/// The compose button, offered or not.
///
/// Not a guess about roles. The server publishes for `MANAGE_SERVER` and
/// nobody else, and the permissions route answers that question already
/// resolved (owner and administrator folded in, roles and timeouts too), so
/// this asks the same bit of the same snapshot the web asks. FAILS CLOSED: a
/// snapshot that never arrived is "no", because a button shown to somebody the
/// server will refuse is a worse mistake than one that shows up a second late.
/// It also needs the instance flag, since every `/home` route 404s without it.
enum CommunityHomeComposeGate {
    static func canPost(config: CommunityHomeConfig, permissions: PermissionsSnapshot?) -> Bool {
        guard config.enabled, let permissions else { return false }
        return permissions.can(PermissionBit.manageServer)
    }

    /// Photos and videos need object storage; a link and text do not.
    static func canAttachFiles(config: CommunityHomeConfig) -> Bool { config.mediaEnabled }
}

// MARK: - Wire

/// `POST /api/servers/:id/home/posts`. `status = published` is the point: the
/// server's default is `draft`, which the phone has no screen for. Optionals
/// are omitted when nil by the synthesized encoder, which the server reads as
/// "no media".
struct CreateCommunityHomePostRequest: Encodable, Equatable, Sendable {
    let title: String
    let body: String?
    let mediaUploadId: String?
    let youtubeUrl: String?
    let status = "published"
    let visibility = "free"
    let commentsEnabled = true

    init(title: String, body: String?, mediaUploadId: String?, youtubeUrl: String?) {
        self.title = title
        self.body = body
        self.mediaUploadId = mediaUploadId
        self.youtubeUrl = youtubeUrl
    }
}

struct CommunityHomePostResponse: Decodable, Sendable {
    let post: CommunityHomePost
}

struct CommunityHomeMediaMintRequest: Encodable, Equatable, Sendable {
    let contentType: String
    let byteSize: Int64
    let filename: String
}

struct CommunityHomeMediaMint: Decodable, Sendable {
    let uploadId: String
    let uploadUrl: String
}

struct CommunityHomeMediaClaim: Decodable, Sendable {
    let uploadId: String
}

// MARK: - The draft

/// One file picked and (when `uploadId` is set) already sitting in storage.
struct ComposeMedia: Equatable, Sendable {
    var filename: String
    var contentType: String
    var byteSize: Int64
    var isVideo: Bool
    var uploadId: String?
    var uploading = false
    var failed = false
}

enum ComposeProblem: Equatable, Sendable {
    case needsTitle
    /// Title fits, but there is nothing to show: no body, no file, no link.
    case needsContent
    case titleTooLong
    case bodyTooLong
    /// A file and a link together: the server takes one media source.
    case oneMediaSource
    case badLink
    case fileStillUploading
    case fileFailed
}

struct ComposeDraft: Equatable, Sendable {
    var title = ""
    var body = ""
    var link = ""
    var media: ComposeMedia?
    /// The channels this account can see, which `#name` in the body is turned
    /// into `<#id>` against. Empty leaves the body exactly as typed.
    var channels: [Channel] = []

    var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedBody: String { body.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedLink: String { link.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// First thing wrong with this draft, or nil when it can go. Lengths are
    /// counted on the untrimmed text, the way the server's `max()` does.
    var problem: ComposeProblem? {
        if trimmedTitle.isEmpty { return .needsTitle }
        if title.utf16.count > CommunityHomeLimits.titleMax { return .titleTooLong }
        // The limit is on what the server stores: a `#channel` is `<#uuid>` there.
        if BauChannelRefs.toStored(body, channels: channels).utf16.count > CommunityHomeLimits.bodyMax {
            return .bodyTooLong
        }
        if media != nil, !trimmedLink.isEmpty { return .oneMediaSource }
        if !trimmedLink.isEmpty, CommunityHomeLinks.provider(trimmedLink) == nil { return .badLink }
        if media?.uploading == true { return .fileStillUploading }
        if media?.failed == true { return .fileFailed }
        if trimmedBody.isEmpty, media == nil, trimmedLink.isEmpty { return .needsContent }
        return nil
    }

    /// The request, or nil while `problem` says no. The media id and the link
    /// are mutually exclusive by construction, which is the server's own "pick
    /// one media source" rule.
    var request: CreateCommunityHomePostRequest? {
        guard problem == nil else { return nil }
        return CreateCommunityHomePostRequest(
            title: trimmedTitle,
            body: trimmedBody.isEmpty ? nil : BauChannelRefs.toStored(trimmedBody, channels: channels),
            mediaUploadId: media?.uploadId,
            youtubeUrl: trimmedLink.isEmpty ? nil : trimmedLink
        )
    }
}

// MARK: - Links

/// Which of the four embed providers a pasted link looks like, by host alone.
///
/// Deliberately NOT a port of the shared parsers: those decide which paths are
/// a post and which are a profile, and a second copy that drifted would tell a
/// person "looks good" about a link the server then refuses. This only names
/// the provider for the preview chip and catches what is plainly not a link;
/// the server's answer (a 400 with its own sentence) stays the verdict, and the
/// composer shows it.
enum CommunityHomeLinks {
    enum Provider: String, Sendable {
        case youtube = "YouTube"
        case twitch = "Twitch"
        case tiktok = "TikTok"
        case instagram = "Instagram"
    }

    static func provider(_ raw: String) -> Provider? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace),
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              var host = url.host?.lowercased() else { return nil }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        func isHost(_ name: String) -> Bool { host == name || host.hasSuffix("." + name) }
        if host == "youtu.be" || isHost("youtube.com") { return .youtube }
        if isHost("twitch.tv") { return .twitch }
        if isHost("tiktok.com") { return .tiktok }
        if isHost("instagram.com") { return .instagram }
        return nil
    }

    /// The public thumbnail of a YouTube watch / youtu.be / shorts link, the
    /// same one the feed shows. nil for anything else: the other three name
    /// their provider and nothing more.
    static func youtubeThumbnail(_ raw: String) -> URL? {
        guard provider(raw) == .youtube,
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        let id: String?
        if url.host?.lowercased() == "youtu.be" {
            id = url.pathComponents.dropFirst().first
        } else if url.path == "/watch" {
            id = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "v" })?.value
        } else {
            let parts = url.pathComponents.dropFirst()
            id = ["shorts", "embed", "live"].contains(parts.first ?? "") ? Array(parts).dropFirst().first : nil
        }
        guard let id, id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://i.ytimg.com/vi/\(id)/hqdefault.jpg")
    }
}

// MARK: - Refusals

/// Why a write was refused, as something a localised sentence can be written
/// about. Mapped from the HTTP status because that is what the Baú routes use
/// (`mapCommunityHomeError`): 403 staff only, 404 the feed is off or the post is
/// gone, 413 too large, 429 slow down, 503 no storage, 400 anything the draft
/// got wrong, with the server's own sentence attached.
enum CommunityHomeRefusal: Equatable, Sendable {
    case notStaff
    case unavailable
    case tooLarge
    case slowDown
    case noStorage
    case invalid(String?)
    case network
    /// A create that died on the wire. The server may well have committed it,
    /// and the post route takes no idempotency key, so a blind retry could
    /// publish twice: the sentence tells the person to look first.
    case unconfirmed

    static func from(_ error: Error) -> CommunityHomeRefusal {
        guard let api = error as? APIError else { return .network }
        switch api {
        case .server(let status, let message):
            switch status {
            case 403: return .notStaff
            case 413: return .tooLarge
            case 503: return .noStorage
            default:
                let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
                // `APIClient` fills "Request failed (400)" when the body had no
                // sentence of its own; that is not worth showing a person.
                let usable = trimmed.isEmpty || trimmed.hasPrefix("Request failed (") ? nil : trimmed
                return .invalid(usable)
            }
        case .notFound: return .unavailable
        case .rateLimited: return .slowDown
        case .unauthorized, .decoding: return .invalid(nil)
        case .transport: return .network
        }
    }

    var message: String {
        switch self {
        case .notStaff: String(localized: "Only people who manage this server can post to the Baú.")
        case .unavailable: String(localized: "The Baú is not available on this server right now.")
        case .tooLarge: String(localized: "That file is too large for the Baú.")
        case .slowDown: String(localized: "Slow down a little and try again in a moment.")
        case .noStorage: String(localized: "This server cannot take photos or videos right now. A link or text still works.")
        case .network: String(localized: "Could not reach the server. Try again.")
        case .unconfirmed: String(localized: "Could not confirm the post. Check the Baú before trying again.")
        case .invalid(let detail?): String(localized: "Could not post. \(detail)")
        case .invalid(nil): String(localized: "Could not post. Try again.")
        }
    }
}

extension ComposeProblem {
    var message: String {
        switch self {
        case .needsTitle: String(localized: "Add a title to post.")
        case .needsContent: String(localized: "Write something, or add a photo, video or link.")
        case .titleTooLong: String(localized: "The title is over \(CommunityHomeLimits.titleMax) characters.")
        case .bodyTooLong: String(localized: "The text is too long for one post.")
        case .oneMediaSource: String(localized: "A post carries a file or a link, not both.")
        case .badLink: String(localized: "That does not look like a YouTube, Twitch, TikTok or Instagram link.")
        case .fileStillUploading: String(localized: "Wait for the upload to finish.")
        case .fileFailed: String(localized: "The upload failed. Remove it and try again.")
        }
    }
}

// MARK: - Endpoints and the upload

/// The two calls an upload makes against the API, as a seam so the storage leg
/// can be tested without a server.
protocol CommunityHomeMediaAPI: Sendable {
    func mintCommunityHomeMedia(serverId: String, request: CommunityHomeMediaMintRequest) async throws -> CommunityHomeMediaMint
    func claimCommunityHomeMedia(serverId: String, uploadId: String) async throws -> String
}

extension APIClient: CommunityHomeMediaAPI {
    func mintCommunityHomeMedia(serverId: String, request: CommunityHomeMediaMintRequest) async throws -> CommunityHomeMediaMint {
        try await post("/api/servers/\(serverId)/home/media", body: request)
    }

    func claimCommunityHomeMedia(serverId: String, uploadId: String) async throws -> String {
        struct Body: Encodable { let uploadId: String }
        let claimed: CommunityHomeMediaClaim = try await post(
            "/api/servers/\(serverId)/home/media/claim", body: Body(uploadId: uploadId)
        )
        return claimed.uploadId
    }

    /// Publish. 403 for anybody without `MANAGE_SERVER`, 404 while the feed is off.
    func createCommunityHomePost(serverId: String, request: CreateCommunityHomePostRequest) async throws -> CommunityHomePost {
        let response: CommunityHomePostResponse = try await post("/api/servers/\(serverId)/home/posts", body: request)
        return response.post
    }
}

/// A picked file, all the way to a claimed upload id: the same mint, PUT, claim
/// dance chat attachments do (`AttachmentUploader`), against the Baú's routes.
///
///  1. mint: the server signs a PUT for exactly this type and length;
///  2. PUT: the bytes go straight to storage, never through the API;
///  3. claim: the server HEADs the object and marks it verified.
///
/// The id it returns is not attached to anything yet; it rides on the create
/// call as `mediaUploadId`, which is what claims it onto a post.
///
/// FROM A FILE, NOT `Data`. A Baú clip can be 100 MiB, and holding that in
/// memory beside the picker's own copy is how an iPhone kills an app. The file
/// also settles the one fact the signature depends on: the length minted and the
/// length sent are the same on-disk size. The PUT carries no Authorization:
/// storage refuses a request that is also authenticated another way.
struct CommunityHomeMediaUploader: Sendable {
    let api: any CommunityHomeMediaAPI
    var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()

    func upload(serverId: String, fileURL: URL, contentType: String, filename: String) async throws -> String {
        let size = (try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else { throw APIError.transport(String(localized: "Could not read that file.")) }
        guard size <= CommunityHomeLimits.maxBytes else { throw APIError.server(status: 413, message: "File too large") }

        let minted = try await api.mintCommunityHomeMedia(
            serverId: serverId,
            request: CommunityHomeMediaMintRequest(contentType: contentType, byteSize: size, filename: filename)
        )
        guard let url = URL(string: minted.uploadUrl) else {
            throw APIError.transport("Storage returned an unusable upload URL")
        }
        var put = URLRequest(url: url)
        put.httpMethod = "PUT"
        // Must match the type that was signed, exactly.
        put.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: put, fromFile: fileURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.transport("Upload rejected by storage (\(status))")
        }
        return try await api.claimCommunityHomeMedia(serverId: serverId, uploadId: minted.uploadId)
    }
}
