package gg.pqp.app.ui.chat

import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The day rows, against the rule in `client/src/lib/utils.ts` (`formatDayLabel`).
 */
class DayLabelsTest {

    private val utc: ZoneId = ZoneId.of("UTC")
    private val saoPaulo: ZoneId = ZoneId.of("America/Sao_Paulo")
    private val today: LocalDate = LocalDate.of(2026, 9, 1)

    private fun label(iso: String, locale: Locale = Locale.ENGLISH, zone: ZoneId = utc) =
        DayLabels.labelFor(iso, today = today, zone = zone, locale = locale)

    @Test
    fun `today and yesterday are words, not dates`() {
        assertEquals(DayLabel.Today, label("2026-09-01T10:00:00.000Z"))
        assertEquals(DayLabel.Yesterday, label("2026-08-31T23:59:59.000Z"))
    }

    @Test
    fun `inside the last week the weekday is spelled out`() {
        val english = label("2026-08-29T12:00:00.000Z") as DayLabel.Dated
        assertTrue(english.text, english.text.startsWith("Saturday"))
        assertTrue(english.text, english.text.contains("29"))
        assertFalse("No year inside the current year", english.text.contains("2026"))

        val portuguese =
            label("2026-08-29T12:00:00.000Z", locale = Locale.forLanguageTag("pt-BR")) as DayLabel.Dated
        assertTrue(portuguese.text, portuguese.text.startsWith("Sábado"))
        assertTrue(portuguese.text, portuguese.text.contains("29 de "))
    }

    @Test
    fun `a week or more ago is a short date without the weekday`() {
        val english = label("2026-08-22T12:00:00.000Z") as DayLabel.Dated
        assertFalse(english.text, english.text.contains("Saturday"))
        assertTrue(english.text, english.text.contains("22"))
        assertFalse(english.text, english.text.contains("2026"))
    }

    @Test
    fun `another year carries the year`() {
        val english = label("2025-08-22T12:00:00.000Z") as DayLabel.Dated
        assertTrue(english.text, english.text.endsWith("2025"))

        val portuguese =
            label("2025-08-22T12:00:00.000Z", locale = Locale.forLanguageTag("pt-BR")) as DayLabel.Dated
        assertTrue(portuguese.text, portuguese.text.endsWith("de 2025"))
    }

    @Test
    fun `the day is the reader's day, not UTC's`() {
        // 01:30 UTC on the 1st is still the evening of the 31st in São Paulo,
        // so for a reader there this message was sent yesterday.
        assertEquals(DayLabel.Yesterday, label("2026-09-01T01:30:00.000Z", zone = saoPaulo))
        assertEquals(DayLabel.Today, label("2026-09-01T01:30:00.000Z", zone = utc))
    }

    @Test
    fun `same day is decided in the reader's zone as well`() {
        val lateEvening = "2026-08-31T23:30:00.000Z"
        val justAfterMidnight = "2026-09-01T00:30:00.000Z"
        assertFalse(DayLabels.isSameDay(lateEvening, justAfterMidnight, utc))
        // Both are the evening of the 31st in São Paulo.
        assertTrue(DayLabels.isSameDay(lateEvening, justAfterMidnight, saoPaulo))
    }

    @Test
    fun `a timestamp that will not parse draws a separator rather than throwing`() {
        assertNull(label("not a date"))
        assertFalse(DayLabels.isSameDay("not a date", "2026-09-01T00:30:00.000Z", utc))
    }
}
