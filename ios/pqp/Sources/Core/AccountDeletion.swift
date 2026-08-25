import Foundation

/// Deleting your own account, as values.
///
/// APP STORE REVIEW GUIDELINE 5.1.1(v) makes this a submission blocker, not a
/// nicety: an app that lets somebody create an account has to let them delete
/// it from inside the app. The web client has had it since the privacy policy
/// promised it (LGPD art. 18, IV and VI); this is the same flow against the
/// same endpoint.
///
/// A MIRROR of `deleteConfirmationMatches` / `expectedDeleteConfirmation` in
/// `packages/shared/src/api.ts`, in the same spirit as `HandleRules`. The
/// server refuses with a 400 when the typed value does not match, so this file
/// decides only when the button lights up. Its whole job is that the button
/// being enabled and the request being accepted can never disagree.
enum AccountDeletion {
    /// What an account with no `name#1234` yet has to type instead.
    ///
    /// NOT LOCALISED, deliberately. The server compares the typed value against
    /// this exact English phrase, so a Portuguese version of it would be
    /// refused with a 400 that the user could do nothing about. It is shown as
    /// a value to copy rather than as a sentence to read, which is why the
    /// screen prints it in a monospace face.
    static let fallbackPhrase = "delete my account"

    /// The string the user has to type: their own tag, or the phrase above.
    static func expectedConfirmation(tag: String?) -> String {
        guard let tag, !tag.isEmpty else { return fallbackPhrase }
        return tag
    }

    /// Case-insensitive after trimming. The requirement is deliberate intent,
    /// not typing accuracy.
    static func confirmationMatches(_ typed: String, tag: String?) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            == expectedConfirmation(tag: tag)
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// A community the caller owns that other people are still in, so deleting the
/// account is refused until it is handed over or deleted.
struct BlockingOwnedServer: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let otherMemberCount: Int
}

/// The one refusal the deletion screen has to *act* on rather than print.
///
/// `DELETE /api/me` answers 409 with the blocking communities listed by name,
/// so the screen can say which ones and what to do about each. Reducing it to a
/// sentence would leave the user to go and find out for themselves which
/// community is the problem, which is the thing the server took the trouble to
/// avoid.
struct AccountDeletionBlocked: LocalizedError {
    let message: String
    let servers: [BlockingOwnedServer]

    var errorDescription: String? { message }
}
