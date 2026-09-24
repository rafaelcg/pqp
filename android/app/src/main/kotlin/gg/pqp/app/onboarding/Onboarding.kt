package gg.pqp.app.onboarding

import gg.pqp.app.core.Me
import java.time.DateTimeException
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * The decisions first run makes, with no Compose attached, so they can be
 * tested on the JVM. The Kotlin twin of `client/src/lib/onboarding.ts`: same
 * paths, same screen counts, same handle rules, same invite normalisation.
 */

/** The wizard's steps after the age gate. See `docs/ANDROID.md` §First run. */
enum class OnboardingStep { You, Room, Ready }

/** Every screen a first run can show, the age gate included. */
enum class FirstRunScreen { Age, You, Room, Ready }

/**
 * Who is walking through, which decides how many screens there are.
 *
 * - `Invite`: arrived on an invite link. The app joins behind the wizard, so
 *   there is no room to pick and no invite to hand out. Age, then you.
 * - `Cold`: anything else. Age, you, room, and the invite for the room made.
 *
 * The web's third path (`?import=discord`) has no entry point on Android: the
 * App Link only claims `/app/invite/`. Its door is on the room step instead.
 */
enum class OnboardingPath { Cold, Invite }

fun screensFor(path: OnboardingPath): List<FirstRunScreen> = when (path) {
    OnboardingPath.Cold -> listOf(FirstRunScreen.Age, FirstRunScreen.You, FirstRunScreen.Room, FirstRunScreen.Ready)
    OnboardingPath.Invite -> listOf(FirstRunScreen.Age, FirstRunScreen.You)
}

/** Zero-based index and total, clamped to the last dot. */
data class ScreenPosition(val index: Int, val total: Int)

fun screenPosition(path: OnboardingPath, screen: FirstRunScreen): ScreenPosition {
    val screens = screensFor(path)
    val found = screens.indexOf(screen)
    return ScreenPosition(if (found == -1) screens.lastIndex else found, screens.size)
}

fun OnboardingStep.screen(): FirstRunScreen = when (this) {
    OnboardingStep.You -> FirstRunScreen.You
    OnboardingStep.Room -> FirstRunScreen.Room
    OnboardingStep.Ready -> FirstRunScreen.Ready
}

/**
 * Should this account be shown the wizard?
 *
 * `preferences` absent is an API that predates the preference store: running
 * the flow there would run it on every launch forever, so the answer is no.
 * `onboardedAt` present is finished, skipped or grandfathered: no again.
 */
fun shouldRunOnboarding(me: Me?): Boolean {
    val preferences = me?.preferences ?: return false
    return preferences.onboardedAt == null
}

/** Capitals and accents are keystrokes to fix quietly, not errors to report. */
fun normalizeUsername(input: String): String =
    input.lowercase().filter { it in 'a'..'z' || it in '0'..'9' || it == '_' }.take(32)

/** `usernameSchema`: `^[a-z0-9_]+$`, 2 to 32 characters. */
fun isValidUsername(value: String): Boolean =
    value.length in 2..32 && value.all { it in 'a'..'z' || it in '0'..'9' || it == '_' }

/**
 * Did the server hand back a different NUMBER than the one they had? Only the
 * number is news: the name part is what they typed, and a rename that kept
 * its number (which the server does whenever it can) is not a reassignment.
 *
 * Compared on the number rather than on the whole tag. Comparing whole tags
 * reads every successful rename as "somebody already had that one", which
 * the emulator walk caught on the first rename it tried.
 */
fun tagWasReassigned(requestedUsername: String, previousTag: String?, nextTag: String?): Boolean {
    if (nextTag == null || !nextTag.startsWith("$requestedUsername#")) return false
    val previousNumber = previousTag?.substringAfterLast('#', missingDelimiterValue = "") ?: return false
    return previousNumber.isNotEmpty() && nextTag.substringAfterLast('#') != previousNumber
}

/** Where a handle error sends somebody. Every branch leaves the field editable. */
enum class HandleError { Taken, Invalid, Generic }

fun handleErrorFor(status: Int?): HandleError = when (status) {
    409 -> HandleError.Taken
    400, 422 -> HandleError.Invalid
    else -> HandleError.Generic
}

/**
 * A pasted invite, reduced to the code the API wants. People paste the whole
 * link because the whole link is what they were sent: the last path segment
 * is the code in `/app/invite/<code>`, `pqp://invite/<code>`, `/i/<code>`,
 * and a bare code.
 */
fun normalizeInviteCode(input: String): String {
    val withoutQuery = input.trim().split('?', '#').first()
    val last = withoutQuery.split('/', '\\').lastOrNull { it.isNotEmpty() }.orEmpty()
    return runCatching { java.net.URLDecoder.decode(last, "UTF-8") }.getOrDefault(last)
}

/**
 * The age gate's three fields, read as a calendar date.
 *
 * Null for anything that is not a real day (31 February, a two-digit year, a
 * date in the future, or before 1900). The answer is a plain `YYYY-MM-DD`
 * with no time and no zone, which is what a date of birth is.
 */
fun birthDateOf(day: String, month: Int?, year: String, today: LocalDate = LocalDate.now()): String? {
    val d = day.trim().toIntOrNull() ?: return null
    val m = month ?: return null
    if (year.trim().length != 4) return null
    val y = year.trim().toIntOrNull() ?: return null
    if (y < 1900) return null
    val date = try {
        LocalDate.of(y, m, d)
    } catch (_: DateTimeException) {
        return null
    }
    if (date.isAfter(today)) return null
    return date.format(DateTimeFormatter.ISO_LOCAL_DATE)
}

/** Where a shared invite points, tagged so an arrival can be counted. */
enum class InviteRef(val wire: String) { Onboarding("onboarding"), Discord("discord") }

fun taggedInviteUrl(appUrl: String, code: String, ref: InviteRef): String =
    appUrl.trimEnd('/') + "/app/invite/" + code + "?ref=" + ref.wire

/** `https://pqp.gg/app/invite/abc?ref=x` → `pqp.gg/app/invite/abc`, for display. */
fun displayLink(url: String): String =
    url.removePrefix("https://").removePrefix("http://").substringBefore('?').substringBefore('#')

/**
 * A Discord template preview, drawn as the sidebar it will become: top-level
 * channels first, then each category followed by its children, in Discord's
 * own order. Capped, because a phone shows a taste of it, not all ninety rows.
 */
data class PreviewRow(val name: String, val type: String, val indent: Boolean, val isPrivate: Boolean)

fun previewRows(plan: DiscordImportPlan): List<PreviewRow> {
    val byParent = plan.channels.groupBy { it.parentTemplateId }
    val rows = mutableListOf<PreviewRow>()
    val topLevel = byParent[null].orEmpty().sortedBy { it.position }
    topLevel.filter { it.type != "category" }.forEach {
        rows += PreviewRow(it.name, it.type, indent = false, isPrivate = it.isPrivate)
    }
    topLevel.filter { it.type == "category" }.forEach { category ->
        rows += PreviewRow(category.name, "category", indent = false, isPrivate = category.isPrivate)
        byParent[category.templateId].orEmpty().sortedBy { it.position }.forEach {
            rows += PreviewRow(it.name, it.type, indent = true, isPrivate = it.isPrivate)
        }
    }
    return rows
}
