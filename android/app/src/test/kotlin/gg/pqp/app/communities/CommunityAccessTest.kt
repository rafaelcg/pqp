package gg.pqp.app.communities

import gg.pqp.app.communities.CommunityAccess.Change
import gg.pqp.app.communities.CommunityAccess.Edit
import gg.pqp.app.communities.CommunityAccess.Refusal
import gg.pqp.app.communities.CommunityAccess.Visibility
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PqpJson
import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The public-access rules the sheet draws, and the wire they ride on.
 *
 * The incident behind this: a server stayed open to the directory because
 * nobody could see the setting from a phone. So the tests that matter most are
 * the ones that say what each state is called, who may move which switch, and
 * that opening a door asks first while closing one does not.
 */
class CommunityAccessTest {

    private fun settings(address: Boolean, listed: Boolean?, slug: String? = "casa") =
        CommunitySettings(isCommunity = address, isListed = listed, slug = slug)

    // --- the three states ---

    @Test
    fun `no address is private`() {
        assertEquals(Visibility.Private, CommunityAccess.visibility(settings(false, false, null)))
    }

    @Test
    fun `an address alone is a public link`() {
        assertEquals(Visibility.PublicLink, CommunityAccess.visibility(settings(true, false)))
    }

    @Test
    fun `an address and the directory is listed`() {
        assertEquals(Visibility.Listed, CommunityAccess.visibility(settings(true, true)))
    }

    @Test
    fun `a server from before the split reads its address as a listing`() {
        // The schema's own compatibility rule: no isListed on the wire means
        // an addressed community WAS a listed one.
        assertEquals(Visibility.Listed, CommunityAccess.visibility(settings(true, null)))
    }

    @Test
    fun `a stale listed flag without an address is still private`() {
        assertEquals(Visibility.Private, CommunityAccess.visibility(settings(false, true, null)))
    }

    // --- who sees the section ---

    @Test
    fun `Manage Server opens it and nothing else does`() {
        assertTrue(CommunityAccess.mayOpen(Permission.MANAGE_SERVER))
        assertTrue(CommunityAccess.mayOpen(Permission.MANAGE_SERVER or Permission.SEND_MESSAGES))
        assertFalse(CommunityAccess.mayOpen(Permission.SEND_MESSAGES))
        assertFalse(CommunityAccess.mayOpen(Permission.MANAGE_CHANNELS))
        assertFalse(CommunityAccess.mayOpen(0L))
    }

    @Test
    fun `from the server list only owner and admin are offered it`() {
        assertTrue(CommunityAccess.mayOpenFromRole("owner"))
        assertTrue(CommunityAccess.mayOpenFromRole("admin"))
        assertFalse(CommunityAccess.mayOpenFromRole("member"))
        assertFalse(CommunityAccess.mayOpenFromRole(null))
    }

    // --- who may move which switch ---

    @Test
    fun `an admin may change the address while the room is not listed`() {
        assertEquals(Edit.Allowed, CommunityAccess.addressEdit(false, settings(true, false)))
        assertEquals(Edit.Allowed, CommunityAccess.addressEdit(false, settings(false, false, null)))
    }

    @Test
    fun `an admin cannot turn the address off under a listing`() {
        assertEquals(Edit.LockedByListing, CommunityAccess.addressEdit(false, settings(true, true)))
    }

    @Test
    fun `the owner may always change the address`() {
        assertEquals(Edit.Allowed, CommunityAccess.addressEdit(true, settings(true, true)))
    }

    @Test
    fun `the directory is the owner's alone`() {
        assertEquals(Edit.OwnerOnly, CommunityAccess.listingEdit(false, settings(true, false)))
        assertEquals(Edit.OwnerOnly, CommunityAccess.listingEdit(false, settings(false, false, null)))
    }

    @Test
    fun `the directory needs an address first`() {
        assertEquals(Edit.NeedsAddress, CommunityAccess.listingEdit(true, settings(false, false, null)))
        assertEquals(Edit.Allowed, CommunityAccess.listingEdit(true, settings(true, false)))
        assertEquals(Edit.Allowed, CommunityAccess.listingEdit(true, settings(true, true)))
    }

    // --- confirmation ---

    @Test
    fun `opening a door asks first and closing one does not`() {
        assertTrue(CommunityAccess.needsConfirmation(Change.AddressOn))
        assertTrue(CommunityAccess.needsConfirmation(Change.ListingOn))
        assertFalse(CommunityAccess.needsConfirmation(Change.AddressOff))
        assertFalse(CommunityAccess.needsConfirmation(Change.ListingOff))
    }

    // --- the wire ---

    private fun encode(body: UpdateCommunityBody): JsonObject =
        Json.parseToJsonElement(PqpJson.encodeToString(UpdateCommunityBody.serializer(), body)) as JsonObject

    @Test
    fun `each switch sends only the field it moved`() {
        assertEquals(setOf("isCommunity"), encode(Change.AddressOn.wire(null)).keys)
        assertEquals(setOf("isCommunity"), encode(Change.AddressOff.wire(null)).keys)
        assertEquals(setOf("isListed"), encode(Change.ListingOn.wire(null)).keys)
        assertEquals(setOf("isListed"), encode(Change.ListingOff.wire(null)).keys)
    }

    @Test
    fun `the values are what the switch says`() {
        assertEquals("true", encode(Change.AddressOn.wire(null))["isCommunity"].toString())
        assertEquals("false", encode(Change.AddressOff.wire(null))["isCommunity"].toString())
        assertEquals("true", encode(Change.ListingOn.wire(null))["isListed"].toString())
        assertEquals("false", encode(Change.ListingOff.wire(null))["isListed"].toString())
    }

    @Test
    fun `a typed address rides only on turning the address on`() {
        assertEquals(setOf("isCommunity", "slug"), encode(Change.AddressOn.wire("minha-casa")).keys)
        assertEquals(setOf("isCommunity"), encode(Change.AddressOff.wire("minha-casa")).keys)
        assertEquals(setOf("isListed"), encode(Change.ListingOn.wire("minha-casa")).keys)
    }

    @Test
    fun `a blank typed address is not sent`() {
        assertNull(CommunityAccess.cleanSlug(null))
        assertNull(CommunityAccess.cleanSlug("   "))
        assertEquals("casa", CommunityAccess.cleanSlug("  casa "))
    }

    @Test
    fun `the response decodes with and without isListed`() {
        val modern = PqpJson.decodeFromString(
            CommunitySettingsResponse.serializer(),
            """{"community":{"isCommunity":true,"isListed":false,"slug":"casa","tagline":null,"category":"geral","suspended":false}}""",
        ).community
        assertEquals(Visibility.PublicLink, CommunityAccess.visibility(modern))
        assertEquals("casa", modern.slug)

        val old = PqpJson.decodeFromString(
            CommunitySettingsResponse.serializer(),
            """{"community":{"isCommunity":true,"slug":"casa","suspended":true}}""",
        ).community
        assertEquals(Visibility.Listed, CommunityAccess.visibility(old))
        assertTrue(old.suspended)
    }

    @Test
    fun `the field names are the shared schema's`() {
        val shared = "packages/shared/src/communities.ts"
        val update = RepoSources.objectKeys(shared, "updateCommunitySchema")
        for (key in listOf("isCommunity", "isListed", "slug")) {
            assertTrue("updateCommunitySchema lost `$key`", key in update)
        }
        val read = RepoSources.objectKeys(shared, "communitySettingsSchema")
        for (key in listOf("isCommunity", "isListed", "slug", "suspended")) {
            assertTrue("communitySettingsSchema lost `$key`", key in read)
        }
    }

    // --- refusals ---

    @Test
    fun `a 409 on the address is a taken address`() {
        assertEquals(Refusal.SlugTaken, CommunityAccess.refusal(409, "That address is already taken. Pick another."))
    }

    @Test
    fun `a 409 on the directory is not told the address is taken`() {
        assertEquals(
            Refusal.NeedsAddress,
            CommunityAccess.refusal(
                409,
                "Turn the public address on before listing this community in the directory",
            ),
        )
    }

    @Test
    fun `a 422 and an unusable 400 are the address field`() {
        assertEquals(Refusal.SlugRejected, CommunityAccess.refusal(422, "That name cannot become a web address. Pick one."))
        assertEquals(Refusal.SlugRejected, CommunityAccess.refusal(400, "That address cannot be used"))
        assertTrue(CommunityAccess.isAddressRefusal(Refusal.SlugTaken))
        assertTrue(CommunityAccess.isAddressRefusal(Refusal.SlugRejected))
        assertFalse(CommunityAccess.isAddressRefusal(Refusal.NeedsAddress))
    }

    @Test
    fun `other 400s stay off the address field`() {
        assertEquals(Refusal.Other("Tagline is too long"), CommunityAccess.refusal(400, "Tagline is too long"))
    }

    @Test
    fun `a 403 carries the server's own sentence and a 404 is unavailable`() {
        assertEquals(
            Refusal.Forbidden("Only the owner can list this community in the directory"),
            CommunityAccess.refusal(403, "Only the owner can list this community in the directory"),
        )
        assertEquals(Refusal.Unavailable, CommunityAccess.refusal(404, "Not found"))
    }

    // --- the address ---

    @Test
    fun `the display form drops the scheme and the link keeps it`() {
        assertEquals("pqp.gg/c/casa", CommunityAccess.displayAddress("casa", "https://pqp.gg"))
        assertEquals("pqp.gg/c/casa", CommunityAccess.displayAddress("casa", "https://pqp.gg/"))
        assertEquals("https://pqp.gg/c/casa", CommunityAccess.addressLink("casa", "https://pqp.gg/"))
    }
}
