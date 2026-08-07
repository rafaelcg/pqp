import Foundation
import ClerkKit

/// How the app proves who it is.
///
/// Two implementations, chosen at launch:
///
/// - **Clerk** — the real one. Works against any deployment.
/// - **dev bypass** — a fixed public token the server only honours when
///   `DEV_AUTH_BYPASS=true` and `NODE_ENV != production`. It cannot reach the
///   hosted API at all, by design.
///
/// The seam is `TokenProviding`, so nothing above this file knows which is in
/// play.
enum AuthMode: Equatable, Sendable {
    case clerk
    case devBypass
}

/// Configuration, read from the bundle rather than compiled in.
///
/// A Clerk *publishable* key is public by design — the web client ships one in
/// its JS bundle — but it still differs per deployment, so it lives in
/// Info.plist where a fork can change it without editing Swift.
enum AppConfig {
    static var clerkPublishableKey: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String,
              !value.isEmpty,
              // XcodeGen writes the literal `$(VAR)` through when the build
              // setting is unset, which would otherwise be handed to Clerk as a
              // key and fail somewhere much less obvious.
              !value.hasPrefix("$(")
        else { return nil }
        return value
    }

    /// Clerk when a key is present, otherwise the dev bypass. Stated this way
    /// round so a missing key in a release build is loud (nothing authenticates
    /// against hosted) rather than silently falling back to a token that only
    /// works locally.
    static var authMode: AuthMode {
        clerkPublishableKey == nil ? .devBypass : .clerk
    }
}

/// Reads a fresh session token per request.
///
/// Clerk session tokens live about a minute. Caching one — or capturing it at
/// launch — is exactly the bug the web client already shipped once: everything
/// works for the first minute and then every request 401s.
struct ClerkTokenProvider: TokenProviding {
    func currentToken() async -> String? {
        do {
            return try await Clerk.shared.auth.getToken()
        } catch {
            return nil
        }
    }
}
