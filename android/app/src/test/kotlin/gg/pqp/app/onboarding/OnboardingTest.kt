package gg.pqp.app.onboarding

import gg.pqp.app.core.Me
import gg.pqp.app.core.MePreferences
import gg.pqp.app.core.PqpJson
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules first run makes, pinned against the web's (`client/src/lib/onboarding.ts`
 * and its test): who sees the wizard, how many screens, what a pasted invite
 * reduces to, and what the age gate accepts as a date.
 */
class OnboardingTest {

    private fun me(preferences: MePreferences?) = Me(id = "u1", displayName = "Ana", preferences = preferences)

    @Test
    fun `an API without preferences never runs the wizard`() {
        assertFalse(shouldRunOnboarding(me(null)))
        assertFalse(shouldRunOnboarding(null))
    }

    @Test
    fun `onboardedAt present means not again, absent means run it`() {
        assertFalse(shouldRunOnboarding(me(MePreferences(onboardedAt = "2026-09-01T00:00:00Z"))))
        assertTrue(shouldRunOnboarding(me(MePreferences())))
    }

    @Test
    fun `me decodes preferences from the wire and ignores the rest`() {
        val decoded = PqpJson.decodeFromString(
            Me.serializer(),
            """{"id":"u1","displayName":"Ana","ageGate":"passed","preferences":{"theme":"dark"}}""",
        )
        assertTrue(shouldRunOnboarding(decoded))
    }

    @Test
    fun `cold is four screens and invite is two, and the rail never reads past its end`() {
        assertEquals(ScreenPosition(0, 4), screenPosition(OnboardingPath.Cold, FirstRunScreen.Age))
        assertEquals(ScreenPosition(3, 4), screenPosition(OnboardingPath.Cold, FirstRunScreen.Ready))
        assertEquals(ScreenPosition(1, 2), screenPosition(OnboardingPath.Invite, FirstRunScreen.You))
        assertEquals(ScreenPosition(1, 2), screenPosition(OnboardingPath.Invite, FirstRunScreen.Ready))
    }

    @Test
    fun `usernames are fixed as typed, not refused on submit`() {
        assertEquals("joo_99", normalizeUsername("João_99"))
        assertEquals(32, normalizeUsername("a".repeat(40)).length)
        assertTrue(isValidUsername("ab"))
        assertFalse(isValidUsername("a"))
        assertFalse(isValidUsername("Ab"))
    }

    @Test
    fun `only a changed number is news`() {
        assertTrue(tagWasReassigned("ana", "ana#0001", "ana#0417"))
        assertTrue(tagWasReassigned("ana", "old#0001", "ana#0417"))
        assertFalse(tagWasReassigned("ana", "ana#0001", "ana#0001"))
        // A rename that kept its number is the ordinary success, not news.
        assertFalse(tagWasReassigned("ana", "old#0001", "ana#0001"))
        assertFalse(tagWasReassigned("ana", "old#0001", null))
    }

    @Test
    fun `the full namespace is its own error`() {
        assertEquals(HandleError.Taken, handleErrorFor(409))
        assertEquals(HandleError.Invalid, handleErrorFor(400))
        assertEquals(HandleError.Generic, handleErrorFor(null))
    }

    @Test
    fun `every pasted invite shape reduces to its code`() {
        assertEquals("abc123", normalizeInviteCode("abc123"))
        assertEquals("abc123", normalizeInviteCode(" https://pqp.gg/app/invite/abc123?ref=onboarding "))
        assertEquals("abc123", normalizeInviteCode("pqp.gg/app/invite/abc123/"))
        assertEquals("abc123", normalizeInviteCode("pqp://invite/abc123"))
        assertEquals("abc123", normalizeInviteCode("/i/abc123#x"))
        assertEquals("", normalizeInviteCode("   "))
    }

    @Test
    fun `the age gate reads real calendar dates only`() {
        val today = LocalDate.of(2026, 9, 24)
        assertEquals("1990-03-07", birthDateOf("7", 3, "1990", today))
        assertEquals("1990-03-07", birthDateOf("07", 3, "1990", today))
        assertNull(birthDateOf("31", 2, "1990", today))
        assertNull(birthDateOf("01", 1, "90", today))
        assertNull(birthDateOf("01", 1, "1899", today))
        assertNull(birthDateOf("25", 9, "2026", today))
        assertNull(birthDateOf("01", null, "1990", today))
        // Somebody born today is a real date; the server decides what it means.
        assertEquals("2026-09-24", birthDateOf("24", 9, "2026", today))
    }

    @Test
    fun `invite links are tagged for counting and shown without the tag`() {
        val url = taggedInviteUrl("https://pqp.gg/", "abc", InviteRef.Onboarding)
        assertEquals("https://pqp.gg/app/invite/abc?ref=onboarding", url)
        assertEquals("pqp.gg/app/invite/abc", displayLink(url))
    }

    @Test
    fun `the public preview is feature-detected, never trusted blind`() {
        assertEquals(
            InvitePreview("Sala", null, 4),
            parseInvitePreview("""{"invite":{"serverName":"Sala","iconUrl":null,"memberCount":4}}"""),
        )
        assertNull(parseInvitePreview("""{"invite":{"serverName":"  ","memberCount":4}}"""))
        assertNull(parseInvitePreview("""{"error":"not found"}"""))
        assertNull(parseInvitePreview("<html>"))
    }

    @Test
    fun `a discord preview reads as the sidebar it becomes`() {
        val plan = DiscordImportPlan(
            serverName = "Guilda",
            channels = listOf(
                DiscordImportChannel(10, null, "category", "Voz", position = 1),
                DiscordImportChannel(11, 10, "voice", "Lobby", position = 0),
                DiscordImportChannel(1, null, "text", "geral", position = 0),
                DiscordImportChannel(20, null, "category", "Texto", position = 0),
                DiscordImportChannel(21, 20, "text", "memes", position = 0, isPrivate = true),
            ),
        )
        assertEquals(
            listOf(
                PreviewRow("geral", "text", indent = false, isPrivate = false),
                PreviewRow("Texto", "category", indent = false, isPrivate = false),
                PreviewRow("memes", "text", indent = true, isPrivate = true),
                PreviewRow("Voz", "category", indent = false, isPrivate = false),
                PreviewRow("Lobby", "voice", indent = true, isPrivate = false),
            ),
            previewRows(plan),
        )
    }
}
