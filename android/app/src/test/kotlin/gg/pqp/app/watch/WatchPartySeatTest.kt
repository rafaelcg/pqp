package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seat rule, and the frame it is read off.
 *
 * Everything here is a port of `mayTakeWatchPartySeat` in
 * `packages/shared/src/watch-party-session.ts`, so the cases are the ones that
 * function names, in the same order: the audience, the people running the
 * party, an invited guest, a party with voice deliberately on, and a channel
 * with no party at all.
 */
class WatchPartySeatTest {

    private fun frame(party: String?): JsonObject = Json.parseToJsonElement(
        """{"type":"watch-party-update","channelId":"c1","party":${party ?: "null"}}""",
    ) as JsonObject

    private fun party(
        role: String = "viewer",
        voice: String = """"voiceEnabled":false,""",
        invited: String = "",
    ): String = """
        {
          "id":"p1","channelId":"c1","name":"Sessão",
          "viewerRole":"$role",
          "options":{${voice}"stageMode":"hosts_only","raiseHand":true},
          "stage":{"invited":[$invited],"hands":[],"handRaised":false}
        }
    """.trimIndent()

    private val me = "11111111-1111-1111-1111-111111111111"

    private fun person(id: String) = """{"userId":"$id","displayName":"x","avatarUrl":null}"""

    // ------------------------------------------------------------- the rule

    @Test
    fun `the audience of a party with no voice is offered nothing`() {
        assertFalse(
            mayTakeWatchPartySeat(
                canStartWatchParty = false,
                party = WatchPartySeatRule(
                    voiceEnabled = false,
                    isHost = false,
                    isCohost = false,
                    isInvited = false,
                ),
            ),
        )
    }

    @Test
    fun `everybody gets in once a host turns voice on`() {
        assertTrue(
            mayTakeWatchPartySeat(
                canStartWatchParty = false,
                party = WatchPartySeatRule(
                    voiceEnabled = true,
                    isHost = false,
                    isCohost = false,
                    isInvited = false,
                ),
            ),
        )
    }

    @Test
    fun `the people running the party always get in`() {
        val base = WatchPartySeatRule(
            voiceEnabled = false,
            isHost = false,
            isCohost = false,
            isInvited = false,
        )
        assertTrue("host", mayTakeWatchPartySeat(false, base.copy(isHost = true)))
        assertTrue("cohost", mayTakeWatchPartySeat(false, base.copy(isCohost = true)))
        assertTrue("invited", mayTakeWatchPartySeat(false, base.copy(isInvited = true)))
    }

    @Test
    fun `a channel with no active party is not a closed room`() {
        assertTrue(mayTakeWatchPartySeat(canStartWatchParty = false, party = null))
    }

    @Test
    fun `holding START_WATCH_PARTY skips the party entirely`() {
        assertTrue(
            mayTakeWatchPartySeat(
                canStartWatchParty = true,
                party = WatchPartySeatRule(
                    voiceEnabled = false,
                    isHost = false,
                    isCohost = false,
                    isInvited = false,
                ),
            ),
        )
    }

    // ----------------------------------------------------------- the decode

    @Test
    fun `a viewer of a voiceless party is a viewer`() {
        val seat = decodeWatchPartySeat(frame(party(role = "viewer")), me)
        assertEquals(
            WatchPartySeatRule(
                voiceEnabled = false,
                isHost = false,
                isCohost = false,
                isInvited = false,
            ),
            seat,
        )
        assertFalse(mayTakeWatchPartySeat(false, seat))
    }

    @Test
    fun `the host and the co-hosts are recognised by viewerRole`() {
        assertTrue(decodeWatchPartySeat(frame(party(role = "host")), me)!!.isHost)
        assertTrue(decodeWatchPartySeat(frame(party(role = "cohost")), me)!!.isCohost)
    }

    /**
     * MANAGE_CHANNELS ends and edits somebody else's party. It does not
     * perform in one, and the shared rule does not name it, so neither does
     * this: a manager watching a voiceless party is an audience member.
     */
    @Test
    fun `a manager is not one of the people running the party`() {
        val seat = decodeWatchPartySeat(frame(party(role = "manager")), me)!!
        assertFalse(seat.isHost)
        assertFalse(seat.isCohost)
        assertFalse(mayTakeWatchPartySeat(false, seat))
    }

    @Test
    fun `an invited guest recognises themselves on the public stage list`() {
        val seat = decodeWatchPartySeat(frame(party(invited = person(me))), me)!!
        assertTrue(seat.isInvited)
        assertTrue(mayTakeWatchPartySeat(false, seat))
    }

    @Test
    fun `somebody else's invitation is not ours`() {
        val other = "22222222-2222-2222-2222-222222222222"
        val seat = decodeWatchPartySeat(frame(party(invited = person(other))), me)!!
        assertFalse(seat.isInvited)
        assertFalse(mayTakeWatchPartySeat(false, seat))
    }

    @Test
    fun `an account that does not know its own id yet is on nobody's list`() {
        val seat = decodeWatchPartySeat(frame(party(invited = person(me))), null)!!
        assertFalse(seat.isInvited)
    }

    /**
     * THE COMPATIBILITY CASE, and the one worth breaking on purpose.
     *
     * `voiceEnabled` is a new option. Every server that predates it ran watch
     * parties as ordinary voice rooms and admits anybody who asks, so reading
     * a missing key as `false` would hide the join button on exactly those
     * servers: a control withheld for a join that would have succeeded, which
     * is the mirror of the bug this whole change fixes.
     */
    @Test
    fun `a party from a server that has never heard of voiceEnabled reads as voice on`() {
        val seat = decodeWatchPartySeat(frame(party(voice = "")), me)!!
        assertTrue(seat.voiceEnabled)
        assertTrue(mayTakeWatchPartySeat(false, seat))
    }

    @Test
    fun `an explicit true is voice on`() {
        val seat = decodeWatchPartySeat(frame(party(voice = """"voiceEnabled":true,""")), me)!!
        assertTrue(seat.voiceEnabled)
    }

    @Test
    fun `party null means there is nothing here for this account any more`() {
        assertNull(decodeWatchPartySeat(frame(null), me))
    }

    @Test
    fun `a frame this client cannot make sense of is not a closed room`() {
        val junk = Json.parseToJsonElement(
            """{"type":"watch-party-update","channelId":"c1","party":"nonsense"}""",
        ) as JsonObject
        assertNull(decodeWatchPartySeat(junk, me))
        assertTrue(mayTakeWatchPartySeat(false, decodeWatchPartySeat(junk, me)))
    }

    // ------------------------------------------------- against shared itself

    /**
     * The fields this decoder reads, read off the schema that declares them.
     *
     * The `when` on a String problem that `RepoSources` exists for applies to
     * object keys too: renaming `viewerRole` on the server turns every host on
     * Android into a viewer with no join button and nothing red anywhere. This
     * is that rename made loud.
     *
     * `voiceEnabled` is deliberately NOT asserted here. It arrives with the
     * change that turns voice off by default, and until that lands no server
     * sends the key at all; the port reads an absent key as ON, which is what
     * every server without it permits, and the test above pins that reading.
     */
    @Test
    fun `the shared schema still declares the fields this decoder reads`() {
        val shared = RepoSources.read("packages/shared/src/watch-party-session.ts")
        val chat = RepoSources.read("packages/shared/src/chat.ts")
        listOf("viewerRole", "options", "stage", "invited").forEach { field ->
            assertTrue(
                "packages/shared/src/watch-party-session.ts no longer declares `$field`, " +
                    "which `decodeWatchPartySeat` reads off `watch-party-update`",
                shared.contains("$field:"),
            )
        }
        listOf("host", "cohost").forEach { role ->
            assertTrue(
                "WATCH_PARTY_ROLES no longer contains \"$role\", which this decoder matches on",
                shared.contains("\"$role\""),
            )
        }
        assertTrue(
            "watch-party-update is no longer the frame that carries a party",
            chat.contains("""type: z.literal("watch-party-update")"""),
        )
    }
}
