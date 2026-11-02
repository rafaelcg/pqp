package gg.pqp.app.onboarding

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Me
import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import java.io.File
import java.io.IOException
import java.time.LocalDate
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The age gate's read-back, plausibility floor and flag, pinned against the
 * web gate (`client/src/components/user/age-gate-dialog.tsx`) and the server
 * (`POST /api/me/age-check`) that PR #1454 changed.
 */
class AgeGateTest {

    private val today = LocalDate.of(2026, 11, 2)
    private val pt = Locale.forLanguageTag("pt-BR")
    private val en = Locale.ENGLISH
    private val es = Locale.forLanguageTag("es")

    // --- read-back wording ---

    @Test
    fun `the date is said back in words in the language of the person`() {
        assertEquals("3 de dezembro de 2008", formatBirthDateInWords("2008-12-03", pt))
        assertEquals("December 3, 2008", formatBirthDateInWords("2008-12-03", en))
        assertEquals("3 de diciembre de 2008", formatBirthDateInWords("2008-12-03", es))
    }

    @Test
    fun `a day and a month that could be swapped read back as what was typed`() {
        // 3 of December and 12 of March are the slip the read-back exists to catch.
        assertEquals("12 de março de 1990", formatBirthDateInWords("1990-03-12", pt))
        assertEquals("3 de dezembro de 1990", formatBirthDateInWords("1990-12-03", pt))
    }

    @Test
    fun `something that is not a calendar date is never said back as another day`() {
        assertNull(formatBirthDateInWords("2001-02-31", pt))
        assertNull(formatBirthDateInWords("not a date", pt))
        assertNull(formatBirthDateInWords("", pt))
    }

    // --- Continue, and the flag ---

    @Test
    fun `with the read-back on, Continue says the date back and sends nothing`() {
        val outcome = continueOutcome("3", 12, "2008", readback = true, locale = pt, today = today)
        assertEquals(ContinueOutcome.ReadBack("2008-12-03", "3 de dezembro de 2008"), outcome)
    }

    @Test
    fun `with the read-back off, Continue submits directly`() {
        val outcome = continueOutcome("3", 12, "2008", readback = false, locale = pt, today = today)
        assertEquals(ContinueOutcome.Submit("2008-12-03"), outcome)
    }

    @Test
    fun `an unreadable date is refused locally with or without the read-back`() {
        for (readback in listOf(true, false)) {
            assertEquals(
                ContinueOutcome.BadDate,
                continueOutcome("31", 2, "1990", readback = readback, locale = pt, today = today),
            )
            assertEquals(
                ContinueOutcome.BadDate,
                continueOutcome("3", null, "1990", readback = readback, locale = pt, today = today),
            )
        }
    }

    @Test
    fun `the flag is on unless the server says it is off`() {
        assertTrue(ageGateReadbackEnabled(true))
        assertTrue(ageGateReadbackEnabled(null))
        assertFalse(ageGateReadbackEnabled(false))
    }

    @Test
    fun `me carries the flag from GET api me, and its absence`() {
        val served = PqpJson.decodeFromString(
            Me.serializer(),
            """{"id":"u1","displayName":"Ana","ageGate":"pending","ageGateReadback":false}""",
        )
        assertFalse(ageGateReadbackEnabled(served.ageGateReadback))
        val silent = PqpJson.decodeFromString(
            Me.serializer(),
            """{"id":"u1","displayName":"Ana","ageGate":"pending"}""",
        )
        assertNull(silent.ageGateReadback)
        assertTrue(ageGateReadbackEnabled(silent.ageGateReadback))
    }

    // --- the plausibility floor ---

    @Test
    fun `the floor is a recoverable input error, never the blocked state`() {
        val floor = ApiException(400, "That date of birth does not look right. Check the year.", BIRTH_DATE_IMPLAUSIBLE)
        assertEquals(AgeCheckFailure.CheckYear, ageCheckFailureOf(floor))
    }

    @Test
    fun `any other 400 is also a date to fix, with the attempt kept`() {
        assertEquals(
            AgeCheckFailure.BadDate,
            ageCheckFailureOf(ApiException(400, "Enter a valid date of birth.", "birth_date_invalid")),
        )
        assertEquals(AgeCheckFailure.BadDate, ageCheckFailureOf(ApiException(400, "Bad request", null)))
    }

    @Test
    fun `a 409 means another device answered and everything else is a failed save`() {
        assertEquals(AgeCheckFailure.Stale, ageCheckFailureOf(ApiException(409, "Already answered", null)))
        assertEquals(AgeCheckFailure.Save, ageCheckFailureOf(ApiException(500, null, null)))
        assertEquals(AgeCheckFailure.Save, ageCheckFailureOf(ApiException(403, "Age check required", null)))
        assertEquals(AgeCheckFailure.Save, ageCheckFailureOf(IOException("offline")))
    }

    // --- contract with the server and the web ---

    @Test
    fun `the code, the flag and the field are the ones the server serves`() {
        val server = RepoSources.read("server/src/api/index.ts")
        assertTrue(server.contains("\"$BIRTH_DATE_IMPLAUSIBLE\""))
        assertTrue(server.contains("ageGateReadback: isEnabled(\"age_gate_readback\")"))
        assertTrue(RepoSources.read("server/src/lib/flags.ts").contains("age_gate_readback: {"))
        assertTrue(RepoSources.read("packages/shared/src/api.ts").contains("ageGateReadback: z.boolean()"))
    }

    /**
     * The words are the web's, not a paraphrase: the read-back and the blocked
     * screen are one product on three clients, and the appeal address is the
     * point of the blocked screen.
     */
    @Test
    fun `the strings are the web's, in each language the app has`() {
        val pairs = mapOf(
            "age_gate_error_check_year" to "ageGate.error.checkYear",
            "age_gate_readback_title" to "ageGate.readback.title",
            "age_gate_readback_born" to "ageGate.readback.born",
            "age_gate_readback_check" to "ageGate.readback.check",
            "age_gate_readback_confirm" to "ageGate.readback.confirm",
            "age_gate_readback_edit" to "ageGate.readback.edit",
            "age_gate_blocked_eyebrow" to "ageGate.blocked.eyebrow",
            "age_gate_blocked_title" to "ageGate.blocked.title",
            "age_gate_blocked_body" to "ageGate.blocked.body",
            "age_gate_blocked_contact_before" to "ageGate.blocked.contact.before",
            "age_gate_blocked_contact_after" to "ageGate.blocked.contact.after",
            "age_gate_blocked_appeal_before" to "ageGate.blocked.appeal.before",
            "age_gate_blocked_appeal_link" to "ageGate.blocked.appeal.link",
            "age_gate_blocked_appeal_after" to "ageGate.blocked.appeal.after",
            "age_gate_blocked_wait" to "ageGate.blocked.wait",
        )
        for ((res, locale) in listOf("values" to "en", "values-pt-rBR" to "pt-BR")) {
            val android = androidStrings(res)
            val web = Json.parseToJsonElement(
                RepoSources.read("client/src/locales/$locale/translation.json"),
            ).jsonObject
            for ((name, key) in pairs) {
                val expected = web.getValue(key).jsonPrimitive.content
                    .replace("{date}", "%1\$s")
                    .replace("{age}", "%1\$d")
                assertEquals("$locale $name", expected, android.getValue(name))
            }
        }
    }

    @Test
    fun `the blocked screen names the same appeal address as the web`() {
        assertEquals("contato@pqp.gg", AGE_GATE_APPEAL_EMAIL)
        assertTrue(
            RepoSources.read("client/src/components/user/age-gate-dialog.tsx").contains(AGE_GATE_APPEAL_EMAIL),
        )
    }

    private fun androidStrings(dir: String): Map<String, String> {
        val file = File(RepoSources.root, "android/app/src/main/res/$dir/strings.xml")
        return Regex("""<string\s+name="([^"]+)"[^>]*>(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(file.readText())
            .associate { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }
    }
}
