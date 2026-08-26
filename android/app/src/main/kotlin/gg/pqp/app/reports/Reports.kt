package gg.pqp.app.reports

import gg.pqp.app.R
import kotlinx.serialization.Serializable

/**
 * Reporting, as values.
 *
 * **This is a Play Store submission blocker, not a nicety.** Google requires an
 * app carrying user-generated content to offer an in-app way to report it; this
 * app had blocking and nothing else. The web client and the iOS app have had
 * this flow for a while, against the same `POST /api/reports`, and this is the
 * Kotlin twin of `ios/pqp/Sources/Home/ReportSheet.swift`.
 *
 * The rules the server owns and this file must not second-guess:
 *
 * - WHERE A REPORT GOES IS NOT THE CLIENT'S DECISION. A message report carries
 *   no context at all: the channel, and therefore the server or the
 *   conversation, is read from the message itself. A user report may carry the
 *   server it was filed from, which is what routes it to that server's
 *   moderators, and the server validates that against the reporter's own
 *   membership before it trusts it. A community report goes to the INSTANCE
 *   queue and never to that community's owner.
 * - EVERY REFUSAL IS A 404. The route answers the same way for "no such thing"
 *   and "you cannot see that", so the endpoint cannot be used to test ids for
 *   existence. There is nothing here to translate a status into, which is why
 *   the sheet prints the server's own sentence.
 * - A DUPLICATE IS A SUCCESS. Re-reporting something already in the queue
 *   answers 200 rather than 201 and reads as sent, because "we already have
 *   this" and "thank you" are the same fact to a reporter.
 */

/**
 * The closed set of reasons, in `REPORT_REASONS` order.
 *
 * [wire] is the untranslated enum the server parses and must never be
 * localised; [label] is the only half a person reads. `ReportReasonTest` pins
 * the wire values against `packages/shared/src/reports.ts`, because a
 * mistyped one is a 400 that no amount of retrying fixes.
 */
enum class ReportReason(val wire: String, val label: Int) {
    Spam("spam", R.string.report_reason_spam),
    Harassment("harassment", R.string.report_reason_harassment),
    HateSpeech("hate_speech", R.string.report_reason_hate_speech),
    Violence("violence", R.string.report_reason_violence),
    SexualContent("sexual_content", R.string.report_reason_sexual_content),
    SelfHarm("self_harm", R.string.report_reason_self_harm),
    IllegalContent("illegal_content", R.string.report_reason_illegal_content),
    Other("other", R.string.report_reason_other),
}

/**
 * What is being reported. The server keys three shapes on `subjectType`; this
 * is the same discriminated union with Kotlin's spelling.
 *
 * The display name on each is display-only. It never travels: the server takes
 * its own snapshot of the subject at write time, so a name typed by a client
 * could only ever be a way to put words in somebody else's mouth inside a
 * moderator's queue.
 */
sealed interface ReportTarget {
    data class Message(val messageId: String, val authorName: String) : ReportTarget

    /**
     * A person. [serverId] is "this person, in this place" and is what routes
     * the report to that server's moderators; null sends it to the instance
     * queue, which is what a report filed from the friends list is.
     */
    data class Person(
        val userId: String,
        val displayName: String,
        val serverId: String? = null,
    ) : ReportTarget

    /**
     * A whole community, reported off its listing rather than off anything
     * said inside it.
     *
     * A THIRD SUBJECT TYPE rather than a user report carrying a server id,
     * because the two go to different queues: `resolveServerSubject` routes
     * this one to the instance moderators, never to the community's owner. A
     * complaint about a room is not something its owner should judge.
     */
    data class Community(val serverId: String, val name: String) : ReportTarget
}

/**
 * The request body, in the one shape per subject the server's discriminated
 * union accepts.
 *
 * `PqpJson` is configured with `explicitNulls = false` and
 * `encodeDefaults = false`, so a field left at its `null` default is absent
 * from the JSON entirely rather than sent as `null`. That is what keeps a
 * message report from carrying a `userId` key the schema would reject.
 */
@Serializable
data class CreateReportBody(
    val subjectType: String,
    val reason: String,
    val messageId: String? = null,
    val userId: String? = null,
    val serverId: String? = null,
    val details: String? = null,
)

/**
 * The rules with an edge to get wrong, pulled out of the composables so they
 * can be tested without a device. Same split as `ServerActions`.
 */
object ReportDraft {

    /**
     * Mirrors `REPORT_DETAILS_MAX_LENGTH` in `packages/shared/src/reports.ts`.
     * Pinned by a test rather than trusted, because the server answers a longer
     * body with a 400 that says nothing a reporter can act on.
     */
    const val DETAILS_MAX_LENGTH = 1000

    /**
     * The free-text box, as the server wants it: trimmed, absent when empty.
     *
     * The server trims it again and stores `null` for a blank one, so sending
     * whitespace would only be a way to make a moderator open an empty note.
     * The ceiling is applied here as well as in the field so a paste past it
     * cannot become a refusal.
     */
    fun details(raw: String): String? =
        raw.trim().take(DETAILS_MAX_LENGTH).ifBlank { null }

    /** The body for a target, with nothing on it the server did not ask for. */
    fun body(target: ReportTarget, reason: ReportReason, rawDetails: String): CreateReportBody =
        when (target) {
            is ReportTarget.Message -> CreateReportBody(
                subjectType = "message",
                reason = reason.wire,
                messageId = target.messageId,
                details = details(rawDetails),
            )

            is ReportTarget.Person -> CreateReportBody(
                subjectType = "user",
                reason = reason.wire,
                userId = target.userId,
                serverId = target.serverId,
                details = details(rawDetails),
            )

            is ReportTarget.Community -> CreateReportBody(
                subjectType = "server",
                reason = reason.wire,
                serverId = target.serverId,
                details = details(rawDetails),
            )
        }

    /**
     * Whether the servers list should offer Report on a row.
     *
     * Only a listed community can be reported: `resolveServerSubject` looks for
     * `is_community AND NOT is_community_suspended` and answers 404 for
     * anything else, as does the route itself when the instance has communities
     * turned off. A menu item that can only ever fail is worse than no menu
     * item, so an ordinary server the caller is simply a member of does not get
     * one. Reporting a *person* in it, or a message they wrote, is the remedy
     * there, and both of those are reachable from inside.
     */
    fun canReportCommunity(isCommunity: Boolean): Boolean = isCommunity
}
