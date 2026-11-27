import Foundation

// The public jam routes the phone uses, and only those: the take notices and
// the starter's inbox (docs/JAM_PUBLIC.md, "Telling the starter"). All of them
// are behind the runtime flag `jam_public`; with it off the config says so and
// nothing else is asked.

extension APIClient {
    /// `GET /api/jam-public/config`. A 404 or 403 is "off" (an API that predates
    /// the routes, or the flag off). Any other failure answers nil, "do not
    /// know": the caller keeps what it had, so a bad moment never hides these
    /// surfaces for good and never turns them on by guessing.
    func jamPublicConfig() async -> JamPublicConfig? {
        do {
            return try await get("/api/jam-public/config") as JamPublicConfig
        } catch APIError.notFound {
            return .off
        } catch APIError.server(let status, _) where status == 403 {
            return .off
        } catch {
            return nil
        }
    }

    /// Whether a song is public and readable by this account
    /// (`GET /api/jam-public/songs/:id`, 404 when it is not). Only asked to say
    /// WHY a link could not land; the body is not read.
    func isPublicJam(id: String) async -> Bool {
        do {
            let _: EmptyResponse = try await get("/api/jam-public/songs/\(id)")
            return true
        } catch {
            return false
        }
    }

    /// The starter's outside takes, out of the mix, waiting for an answer.
    func jamPublicInbox() async throws -> JamPublicInboxResponse {
        try await get("/api/jam-public/inbox")
    }

    /// The open take notices: parts waiting for this account as a starter, and
    /// the starter's answers to the parts it sent. An empty list while
    /// `jam_take_notices` is off.
    func jamTakeNotices() async throws -> JamTakeNoticesResponse {
        try await get("/api/jam-public/notices")
    }

    /// Spend a notice: its card or its X. Best effort for the caller.
    func ackJamTakeNotice(id: String) async throws {
        struct Body: Encodable { let id: String }
        let _: EmptyResponse = try await post("/api/jam-public/notices/ack", body: Body(id: id))
    }
}
