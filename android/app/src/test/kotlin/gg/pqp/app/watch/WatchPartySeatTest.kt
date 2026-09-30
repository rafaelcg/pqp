package gg.pqp.app.watch

import gg.pqp.app.protocol.RepoSources
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seat rule, and the frame it is read off.
 *
 * A CONSERVATIVE PORT of the server's real authority, `mayGoOnAir` in
 * `packages/shared/src/watch-party-session.ts` (fed by
 * `fetchWatchPartySeatSnapshot`: guests mode, host, co-host ids, accepted
 * guest ids -- no `voiceEnabled` in it anywhere). This file used to port an
 * older, `@deprecated` sibling, `mayTakeWatchPartySeat`, which read a missing
 * `options.voiceEnabled` key as "voice on" for backward compatibility with a
 * server that predates the option. That is exactly the case this test class
 * exists to pin down: an ordinary viewer of an OLD party (no `voiceEnabled`
 * key at all) must NOT be offered a seat, because the server's real rule
 * never had one to begin with and refuses that join regardless.
 */
class WatchPartySeatTest {

    private fun frame(party: String?): JsonObject = Json.parseToJsonElement(
        """{"type":"watch-party-update","channelId":"c1","party":${party ?: "null"}}""",
    ) as JsonObject

    /**
     * A party object as an OLD server (one that predates `voiceEnabled`)
     * would send it: no `options` key, no `voiceEnabled` key, nothing this
     * decoder still reads beyond `viewerRole` and `state`.
     */
    private fun legacyParty(role: String = "viewer", state: String = "live"): String = """
        {
          "id":"p1","channelId":"c1","name":"Sessão","state":"$state",
          "hostUserId":"h1","hostDisplayName":"Host","viewerRole":"$role"
        }
    """.trimIndent()

    // ------------------------------------------------------------- the rule

    @Test
    fun `an ordinary viewer of a running party is offered nothing`() {
        assertFalse(
            mayJoinWatchPartyRoom(
                canStartWatchParty = false,
                party = WatchPartySeatRule(isHost = false, isCohost = false, isTerminal = false),
            ),
        )
    }

    @Test
    fun `the host of the party always gets in`() {
        assertTrue(
            mayJoinWatchPartyRoom(
                canStartWatchParty = false,
                party = WatchPartySeatRule(isHost = true, isCohost = false, isTerminal = false),
            ),
        )
    }

    @Test
    fun `a co-host of the party always gets in`() {
        assertTrue(
            mayJoinWatchPartyRoom(
                canStartWatchParty = false,
                party = WatchPartySeatRule(isHost = false, isCohost = true, isTerminal = false),
            ),
        )
    }

    @Test
    fun `a channel with no active party is not a closed room`() {
        assertTrue(mayJoinWatchPartyRoom(canStartWatchParty = false, party = null))
    }

    @Test
    fun `an ended party is not a closed room either`() {
        assertTrue(
            mayJoinWatchPartyRoom(
                canStartWatchParty = false,
                party = WatchPartySeatRule(isHost = false, isCohost = false, isTerminal = true),
            ),
        )
    }

    @Test
    fun `a cancelled party reads the same as ended`() {
        val seat = decodeWatchPartySeat(frame(legacyParty(role = "viewer", state = "cancelled")))!!
        assertTrue(seat.isTerminal)
        assertTrue(mayJoinWatchPartyRoom(canStartWatchParty = false, party = seat))
    }

    @Test
    fun `holding START_WATCH_PARTY skips the party entirely`() {
        assertTrue(
            mayJoinWatchPartyRoom(
                canStartWatchParty = true,
                party = WatchPartySeatRule(isHost = false, isCohost = false, isTerminal = false),
            ),
        )
    }

    /**
     * THE COMPATIBILITY CASE, and the bug this change fixes.
     *
     * The deprecated `mayTakeWatchPartySeat` read a missing `voiceEnabled`
     * key as "voice on" and let an ordinary viewer of an old party in. The
     * server's real rule, `mayGoOnAir`, has no such key and never admits a
     * plain viewer, so an old party must refuse one here too -- offering a
     * join button the server then refuses is the exact failure reported.
     */
    @Test
    fun `an ordinary viewer of a party from a server that predates voiceEnabled is still refused`() {
        val seat = decodeWatchPartySeat(frame(legacyParty(role = "viewer", state = "live")))!!
        assertFalse(seat.isHost)
        assertFalse(seat.isCohost)
        assertFalse(seat.isTerminal)
        assertFalse(mayJoinWatchPartyRoom(canStartWatchParty = false, party = seat))
    }

    @Test
    fun `the host of that same legacy party still gets in`() {
        val seat = decodeWatchPartySeat(frame(legacyParty(role = "host", state = "live")))!!
        assertTrue(mayJoinWatchPartyRoom(canStartWatchParty = false, party = seat))
    }

    // ----------------------------------------------------------- the decode

    @Test
    fun `the host and the co-hosts are recognised by viewerRole`() {
        assertTrue(decodeWatchPartySeat(frame(legacyParty(role = "host")))!!.isHost)
        assertTrue(decodeWatchPartySeat(frame(legacyParty(role = "cohost")))!!.isCohost)
    }

    /**
     * MANAGE_CHANNELS ends and edits somebody else's party. It does not
     * perform in one, and the server's real rule does not name it either, so
     * neither does this: a manager watching a running party is an audience
     * member.
     */
    @Test
    fun `a manager is not one of the people running the party`() {
        val seat = decodeWatchPartySeat(frame(legacyParty(role = "manager")))!!
        assertFalse(seat.isHost)
        assertFalse(seat.isCohost)
        assertFalse(mayJoinWatchPartyRoom(canStartWatchParty = false, party = seat))
    }

    @Test
    fun `ended and cancelled are the only states read as terminal`() {
        assertFalse(decodeWatchPartySeat(frame(legacyParty(state = "draft")))!!.isTerminal)
        assertFalse(decodeWatchPartySeat(frame(legacyParty(state = "scheduled")))!!.isTerminal)
        assertFalse(decodeWatchPartySeat(frame(legacyParty(state = "live")))!!.isTerminal)
        assertTrue(decodeWatchPartySeat(frame(legacyParty(state = "ended")))!!.isTerminal)
        assertTrue(decodeWatchPartySeat(frame(legacyParty(state = "cancelled")))!!.isTerminal)
    }

    @Test
    fun `party null means there is nothing here for this account any more`() {
        assertNull(decodeWatchPartySeat(frame(null)))
    }

    @Test
    fun `a frame this client cannot make sense of is not a closed room`() {
        val junk = Json.parseToJsonElement(
            """{"type":"watch-party-update","channelId":"c1","party":"nonsense"}""",
        ) as JsonObject
        assertNull(decodeWatchPartySeat(junk))
        assertTrue(mayJoinWatchPartyRoom(canStartWatchParty = false, party = decodeWatchPartySeat(junk)))
    }

    // ------------------------------------------------- against shared itself

    /**
     * The fields this decoder reads, read off the schema that declares them.
     *
     * The `when` on a String problem that `RepoSources` exists for applies to
     * object keys too: renaming `viewerRole` or `state` on the server turns
     * every host on Android into a viewer with no join button, or stops a
     * terminal party from ever reopening its room.
     */
    @Test
    fun `the shared schema still declares the fields this decoder reads`() {
        val shared = RepoSources.read("packages/shared/src/watch-party-session.ts")
        val chat = RepoSources.read("packages/shared/src/chat.ts")
        listOf("viewerRole", "state").forEach { field ->
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
        listOf("ended", "cancelled").forEach { phase ->
            assertTrue(
                "WATCH_PARTY_PHASES no longer contains \"$phase\", which this decoder reads as terminal",
                shared.contains("\"$phase\""),
            )
        }
        assertTrue(
            "watch-party-update is no longer the frame that carries a party",
            chat.contains("""type: z.literal("watch-party-update")"""),
        )
    }
}
