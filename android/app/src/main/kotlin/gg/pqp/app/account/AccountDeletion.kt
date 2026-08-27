package gg.pqp.app.account

import kotlinx.serialization.Serializable

/**
 * Deleting your own account, as values.
 *
 * **This is a Play Store submission blocker, not a nicety.** Google's policy,
 * like App Store Guideline 5.1.1(v) which held the iOS app until build 12,
 * requires an app that lets somebody create an account to let them delete it
 * from inside the app. The web client has had it since the privacy policy
 * promised it (LGPD art. 18, IV and VI); this is the same flow against the same
 * endpoint.
 *
 * A MIRROR of `deleteConfirmationMatches` / `expectedDeleteConfirmation` in
 * `packages/shared/src/api.ts`, and the Kotlin twin of
 * `ios/pqp/Sources/Core/AccountDeletion.swift`. The server refuses with a 400
 * when the typed value does not match, so this file decides only when the
 * button lights up. Its whole job is that the button being enabled and the
 * request being accepted can never disagree.
 */
object AccountDeletion {

    /**
     * What an account with no `name#1234` yet has to type instead.
     *
     * NOT LOCALISED, deliberately. The server compares the typed value against
     * this exact English phrase, so a Portuguese version of it would be refused
     * with a 400 the user could do nothing about. It is shown as a value to
     * copy rather than a sentence to read, which is why the screen prints it in
     * a monospace face.
     */
    const val FALLBACK_PHRASE = "delete my account"

    /** The string the user has to type: their own tag, or the phrase above. */
    fun expectedConfirmation(tag: String?): String =
        if (tag.isNullOrBlank()) FALLBACK_PHRASE else tag

    /**
     * Case-insensitive after trimming. The requirement is deliberate intent,
     * not typing accuracy.
     */
    fun confirmationMatches(typed: String, tag: String?): Boolean =
        typed.trim().lowercase() == expectedConfirmation(tag).trim().lowercase()
}

/**
 * A community the caller owns that other people are still in, so deleting the
 * account is refused until it is handed over or deleted.
 */
@Serializable
data class BlockingOwnedServer(
    val id: String,
    val name: String,
    val otherMemberCount: Int = 0,
)

/**
 * The one refusal the deletion screen has to *act* on rather than print.
 *
 * `DELETE /api/me` answers 409 with the blocking communities listed by name, so
 * the screen can say which ones and what to do about each. Reducing it to a
 * sentence would leave the user to go and find out for themselves which
 * community is the problem, which is the thing the server took the trouble to
 * avoid.
 */
class AccountDeletionBlocked(
    val serverMessage: String,
    val servers: List<BlockingOwnedServer>,
) : Exception(serverMessage)
