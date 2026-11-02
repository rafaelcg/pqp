package gg.pqp.app.onboarding

import gg.pqp.app.core.ApiException
import java.time.DateTimeException
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The decisions of the age gate that are not drawing: what Continue does, what
 * a refusal from `POST /api/me/age-check` means, and how a date is said back.
 * Kept apart from `AgeGateScreen` so they can be pinned without a device. The
 * web gate (`client/src/components/user/age-gate-dialog.tsx`) is the reference.
 */

/** Where an account blocked by mistake writes, from the account's own email address. */
const val AGE_GATE_APPEAL_EMAIL = "contato@pqp.gg"

/** The server's stable `code` on a 400 for a real date nobody answering this could have. */
const val BIRTH_DATE_IMPLAUSIBLE = "birth_date_implausible"

/**
 * A date of birth spelled out for the read-back ("3 de dezembro de 2008"), in
 * [locale]. Null when [isoDate] is not a real calendar date, which is what lets
 * "31 February" be refused without a request: it is parsed strictly, so it is
 * never quietly turned into 3 March and then confirmed back to somebody who
 * never typed it. A `LocalDate` has no zone, so the formatter cannot apply one:
 * a date of birth is a calendar fact. No clock is read.
 */
fun formatBirthDateInWords(isoDate: String, locale: Locale): String? {
    val date = try {
        LocalDate.parse(isoDate, DateTimeFormatter.ISO_LOCAL_DATE)
    } catch (_: DateTimeException) {
        return null
    }
    return try {
        DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale).format(date)
    } catch (_: DateTimeException) {
        null
    }
}

/**
 * Whether the gate says the date back before sending it, from `ageGateReadback`
 * on `GET /api/me` (the `age_gate_readback` kill switch, which the server
 * serves only while the gate is pending). Unknown reads as ON: the switch is
 * default-on, only an explicit `false` turns it off, and showing the read-back
 * to somebody an old server did not tell is the safe side of the mistake.
 */
fun ageGateReadbackEnabled(served: Boolean?): Boolean = served != false

/** What the Continue button does with what is typed. */
sealed interface ContinueOutcome {
    /** Not a date we can read: say so, keep the fields, send nothing. */
    data object BadDate : ContinueOutcome

    /** The switch is off: send it, as the gate always did. */
    data class Submit(val isoDate: String) : ContinueOutcome

    /** Say [inWords] back first. Only "Está certo" sends [isoDate]. */
    data class ReadBack(val isoDate: String, val inWords: String) : ContinueOutcome
}

fun continueOutcome(
    day: String,
    month: Int?,
    year: String,
    readback: Boolean,
    locale: Locale,
    today: LocalDate = LocalDate.now(),
): ContinueOutcome {
    val isoDate = birthDateOf(day, month, year, today) ?: return ContinueOutcome.BadDate
    if (!readback) return ContinueOutcome.Submit(isoDate)
    val inWords = formatBirthDateInWords(isoDate, locale) ?: return ContinueOutcome.BadDate
    return ContinueOutcome.ReadBack(isoDate, inWords)
}

/** Why `POST /api/me/age-check` did not give a verdict, as the gate has to react to it. */
enum class AgeCheckFailure {
    /**
     * 400 `birth_date_implausible`: a real date under the plausibility floor
     * (the year of today, a default, a slip). The attempt is NOT spent. Back to
     * the fields, values kept, "Confere o ano", cursor in the year.
     */
    CheckYear,

    /** Any other 400: not a date the server can read. Also not spent: back to the fields. */
    BadDate,

    /** 409: this account already answered (another device). Re-read `/api/me`. */
    Stale,

    /** Anything else (offline, a 5xx): nothing was decided, try again. */
    Save,
}

/**
 * A 400 is always recoverable input and never the blocked state: the blocked
 * state comes only from a 200 whose `ageGate` is `blocked`, which the caller
 * reads out of `/api/me`.
 */
fun ageCheckFailureOf(error: Throwable): AgeCheckFailure {
    if (error !is ApiException) return AgeCheckFailure.Save
    return when (error.status) {
        400 -> if (error.code == BIRTH_DATE_IMPLAUSIBLE) AgeCheckFailure.CheckYear else AgeCheckFailure.BadDate
        409 -> AgeCheckFailure.Stale
        else -> AgeCheckFailure.Save
    }
}
