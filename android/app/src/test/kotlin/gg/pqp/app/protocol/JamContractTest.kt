package gg.pqp.app.protocol

import gg.pqp.app.core.PqpJson
import gg.pqp.app.jam.JamConfig
import gg.pqp.app.jam.JamErrors
import gg.pqp.app.jam.JamFrame
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamJoinMode
import gg.pqp.app.jam.JamLimits
import gg.pqp.app.jam.JamSongDetailResponse
import gg.pqp.app.jam.JamSongListResponse
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamSongViewer
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.JamTrackWithSong
import gg.pqp.app.jam.JamVoteResponse
import gg.pqp.app.jam.jamSongLink
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The jam models and frames against `packages/shared/src/jam.ts`, field by field
 * and cap by cap, the way `ForumContractTest` holds the forum: a rename on the
 * server must fail here, not decode to a default on a phone.
 *
 * The seven jam frames are not members of `chatServerMessageSchema` yet (the
 * union `WireProtocolTest` reads "what the server sends" from; the shared
 * header says so), so that test cannot see them on its own. They are held here
 * against `JAM_FRAME_TYPES` instead: every one is decoded, and every one has a
 * `when` branch the handled-frames scan finds.
 */
class JamContractTest {

    private val jam = "packages/shared/src/jam.ts"

    private fun assertSubset(serializer: KSerializer<*>, schema: String) {
        val schemaKeys = RepoSources.objectKeys(jam, schema).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals(
            "${serializer.descriptor.serialName} names fields $schema does not have",
            emptySet<String>(),
            kotlinKeys - schemaKeys,
        )
    }

    @Test
    fun `the models match the shared schemas`() {
        assertSubset(JamConfig.serializer(), "jamConfigSchema")
        assertSubset(JamSongSummary.serializer(), "jamSongSummarySchema")
        assertSubset(JamSongViewer.serializer(), "jamSongViewerSchema")
        assertSubset(JamSongListResponse.serializer(), "jamSongListResponseSchema")
        assertSubset(JamTrack.serializer(), "jamTrackSchema")
        assertSubset(JamSongDetailResponse.serializer(), "jamSongDetailResponseSchema")
        assertSubset(JamVoteResponse.serializer(), "jamVoteResponseSchema")
        assertSubset(JamTrackWithSong.serializer(), "jamTrackWithSongSchema")
    }

    /** The two models a tile and a track row draw from: every field the server sends is read. */
    @Test
    fun `the summary and the track read every field the server sends`() {
        // Fields the server sends that this build does not read YET, each one a decision
        // made in the open. `coverUrl` was on it until the wall's tiles and the song's header
        // drew it; take a name off this list in the change that makes the model read it.
        val notReadYet = emptySet<String>()
        assertEquals(
            RepoSources.objectKeys(jam, "jamSongSummarySchema").toSet() - notReadYet,
            JamSongSummary.serializer().descriptor.elementNames.toSet(),
        )
        // The track's `videoSources` is the list of every file a video exists as (the worker's
        // MP4 copy first, the recording second) for a client that chooses by what it can play.
        // The phones need none of it: `videoUrl` is already the best file for them (the MP4 copy
        // once it exists), so the decoder skips the list until a screen wants to choose.
        val notReadYetOnTracks = setOf("videoSources")
        assertEquals(
            RepoSources.objectKeys(jam, "jamTrackSchema").toSet() - notReadYetOnTracks,
            JamTrack.serializer().descriptor.elementNames.toSet(),
        )
    }

    @Test
    fun `the caps and the error tokens are the shared ones`() {
        assertEquals(RepoSources.numberConstant(jam, "JAM_TITLE_MAX"), JamLimits.TITLE_MAX)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PAGE_SIZE"), JamLimits.PAGE_SIZE)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PAGE_MAX"), JamLimits.PAGE_MAX)
        assertEquals(RepoSources.numberConstant(jam, "JAM_MAX_TRACKS_PER_SONG"), JamLimits.MAX_TRACKS_PER_SONG)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PEAKS_MAX"), JamLimits.PEAKS_MAX)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PREVIEW_PEAKS_MAX"), JamLimits.PREVIEW_PEAKS_MAX)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PREVIEW_CONTRIBUTORS_MAX"), JamLimits.PREVIEW_CONTRIBUTORS_MAX)
        assertEquals(RepoSources.numberConstant(jam, "JAM_GAIN_MAX"), JamLimits.GAIN_MAX.toInt())
        val source = RepoSources.read(jam)
        listOf(
            JamErrors.OFF, JamErrors.CLOSED, JamErrors.INSTRUMENT_NOT_WANTED, JamErrors.SONG_FULL,
            JamErrors.AUTHOR_TRACK_LIMIT, JamErrors.RATE_LIMITED,
        ).forEach { token -> assertTrue("$token is no longer a JAM_ERRORS value", source.contains("\"$token\"")) }
    }

    @Test
    fun `the instruments and join modes are the shared enums, in the picker's order`() {
        assertEquals(
            RepoSources.read(jam).substringAfter("export const JAM_INSTRUMENTS = [").substringBefore("]")
                .let { block -> Regex("\"(\\w+)\"").findAll(block).map { it.groupValues[1] }.toList() },
            JamInstrument.entries.map { it.wire },
        )
        assertEquals(
            RepoSources.read(jam).substringAfter("export const JAM_JOIN_MODES = [").substringBefore("]")
                .let { block -> Regex("\"(\\w+)\"").findAll(block).map { it.groupValues[1] }.toList() },
            JamJoinMode.entries.map { it.wire },
        )
    }

    // --- decoding what the server sends ---

    private val songJson = """
        {"id":"s1","channelId":"c1","serverId":"srv","title":"In Bloom","artist":"Nirvana","joinMode":"wanted",
         "wantedInstruments":["vocals","theremin"],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
         "createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-02T10:00:00.000Z","trackCount":2,
         "instruments":["guitar","kazoo"],"contributorCount":2,"mixDurationMs":14000,"somethingNew":true}
    """.trimIndent()

    /** The same summary as a server that sends the preview writes it (jam.ts, "the preview"). */
    private val previewJson = songJson.removeSuffix("}") + """,
        "previewPeaks":[0.1,0.9,0.4],"hasVideo":true,
        "contributors":[{"id":"u1","name":"rafa","avatarUrl":null},{"id":"u2","name":null,"avatarUrl":"https://x/a.png"}],
        "missingInstruments":["vocals"]}"""

    private fun trackJson(id: String = "t1", extra: String = "") = """
        {"id":"$id","songId":"s1","authorId":"u1","authorName":"rafa","authorAvatarUrl":null,"instrument":"guitar",
         "label":null,"audioUrl":"https://bucket/a.flac","audioContentType":"audio/flac","audioBytes":123,
         "videoUrl":null,"videoContentType":null,"videoBytes":null,"mediaExpiresAt":"2026-11-03T00:00:00.000Z",
         "offsetMs":-250,"trimStartMs":10.5,"trimEndMs":0,"durationMs":14000,"gain":1.25,"peaks":[0.1,0.5,1],
         "inMix":true,"voteCount":3,"createdAt":"2026-11-01T10:00:00.000Z"$extra}
    """.trimIndent()

    @Test
    fun `a summary decodes, an unknown instrument reads as other and an unknown mode as closed`() {
        val song = PqpJson.decodeFromString(JamSongSummary.serializer(), songJson)
        assertEquals("In Bloom", song.title)
        assertEquals(listOf(JamInstrument.Vocals, JamInstrument.Other), song.wantedInstruments)
        assertEquals(listOf(JamInstrument.Guitar, JamInstrument.Other), song.instruments)
        assertEquals(JamJoinMode.Wanted, song.joinMode)
        assertEquals(14000.0, song.mixDurationMs!!, 0.0)
        val odd = PqpJson.decodeFromString(JamSongSummary.serializer(), songJson.replace("\"wanted\"", "\"secret\""))
        assertEquals(JamJoinMode.Closed, odd.joinMode)
        assertEquals(java.time.Instant.parse("2026-11-02T10:00:00.000Z").toEpochMilli(), song.updatedAtMs)
    }

    @Test
    fun `a summary from a server that sends the preview reads all four fields`() {
        val song = PqpJson.decodeFromString(JamSongSummary.serializer(), previewJson)
        assertEquals(listOf(0.1, 0.9, 0.4), song.previewPeaks)
        assertEquals(true, song.hasVideo)
        assertEquals(listOf("rafa", null), song.contributors!!.map { it.name })
        assertEquals("https://x/a.png", song.contributors!![1].avatarUrl)
        assertEquals(listOf(JamInstrument.Vocals), song.missingInstruments)
        assertTrue(song.hasPreview)
    }

    @Test
    fun `a summary from an older server has none of them, and says so with null rather than with empty`() {
        val song = PqpJson.decodeFromString(JamSongSummary.serializer(), songJson)
        assertNull(song.previewPeaks)
        assertNull(song.hasVideo)
        assertNull(song.contributors)
        assertNull(song.missingInstruments)
        assertTrue(!song.hasPreview)
        // The server that looked and found nothing sends empty values, which are not the same thing.
        val empty = PqpJson.decodeFromString(
            JamSongSummary.serializer(),
            songJson.removeSuffix("}") + ""","previewPeaks":[],"hasVideo":false,"contributors":[],"missingInstruments":[]}""",
        )
        assertEquals(emptyList<Double>(), empty.previewPeaks)
        assertTrue(empty.hasPreview)
    }

    @Test
    fun `an instrument in missingInstruments that a newer server invented reads as other`() {
        val song = PqpJson.decodeFromString(
            JamSongSummary.serializer(),
            previewJson.replace("\"vocals\"]}", "\"theremin\"]}"),
        )
        assertEquals(listOf(JamInstrument.Other), song.missingInstruments)
    }

    @Test
    fun `every song frame carries the preview on its summary, and so does the detail and the track answer`() {
        val c = "\"channelId\":\"c1\""
        val created = JamFrame.decode(frame("""{"type":"jam-song-created",$c,"song":$previewJson}""")) as JamFrame.SongCreated
        assertEquals(listOf(0.1, 0.9, 0.4), created.song.previewPeaks)
        val updated = JamFrame.decode(frame("""{"type":"jam-song-updated",$c,"song":$previewJson}""")) as JamFrame.SongUpdated
        assertEquals(true, updated.song.hasVideo)
        val added = JamFrame.decode(frame("""{"type":"jam-track-added",$c,"song":$previewJson,"track":${trackJson()}}""")) as JamFrame.TrackAdded
        assertEquals(listOf(JamInstrument.Vocals), added.song.missingInstruments)
        val updatedTrack = JamFrame.decode(frame("""{"type":"jam-track-updated",$c,"song":$previewJson,"track":${trackJson()}}""")) as JamFrame.TrackUpdated
        assertEquals(2, updatedTrack.song.contributors!!.size)
        val deleted = JamFrame.decode(frame("""{"type":"jam-track-deleted",$c,"song":$previewJson,"trackId":"t1"}""")) as JamFrame.TrackDeleted
        assertTrue(deleted.song.hasPreview)
        val detail = PqpJson.decodeFromString(
            JamSongDetailResponse.serializer(),
            """{"song":$previewJson,"tracks":[${trackJson()}],"viewer":{}}""",
        )
        assertTrue(detail.song.hasPreview)
        val withSong = PqpJson.decodeFromString(
            JamTrackWithSong.serializer(),
            """{"track":${trackJson()},"song":$previewJson}""",
        )
        assertEquals(listOf(0.1, 0.9, 0.4), withSong.song.previewPeaks)
        // The same frames from an older server still decode, with the preview absent.
        val old = JamFrame.decode(frame("""{"type":"jam-song-created",$c,"song":$songJson}""")) as JamFrame.SongCreated
        assertNull(old.song.previewPeaks)
    }

    @Test
    fun `a track decodes with a negative offset and fractional milliseconds`() {
        val track = PqpJson.decodeFromString(JamTrack.serializer(), trackJson())
        assertEquals(-250.0, track.offsetMs, 0.0)
        assertEquals(10.5, track.trimStartMs, 0.0)
        assertEquals(1.25, track.gain, 0.0)
        assertEquals(3, track.peaks.size)
        assertEquals(13_989.5, track.playedMs, 0.0)
        // The file's first sample is at -250 and 10.5 ms of its head are hidden: heard from -239.5 to the file's end.
        assertEquals(-250.0 + 10.5, track.startMs, 0.0)
        assertEquals(-250.0 + 14_000.0, track.endMs, 0.0)
        assertEquals(track.startMs + track.playedMs, track.endMs, 0.0)
        assertTrue(!track.hasVideo)
    }

    @Test
    fun `the detail and the vote answer decode`() {
        val detail = PqpJson.decodeFromString(
            JamSongDetailResponse.serializer(),
            """{"song":$songJson,"tracks":[${trackJson()}],"viewer":{"isAuthor":true,"canModerate":false,
               "addableInstruments":["guitar"],"votedTrackIds":["t1"]}}""",
        )
        assertEquals(1, detail.tracks.size)
        assertTrue(detail.viewer.isAuthor)
        assertEquals(listOf("t1"), detail.viewer.votedTrackIds)
        val vote = PqpJson.decodeFromString(JamVoteResponse.serializer(), """{"trackId":"t1","songId":"s1","voteCount":4,"voted":true}""")
        assertEquals(4, vote.voteCount)
    }

    private fun frame(json: String): JsonObject = PqpJson.parseToJsonElement(json).jsonObject

    @Test
    fun `all seven frames decode`() {
        val c = "\"channelId\":\"c1\""
        assertTrue(JamFrame.decode(frame("""{"type":"jam-song-created",$c,"song":$songJson}""")) is JamFrame.SongCreated)
        assertTrue(JamFrame.decode(frame("""{"type":"jam-song-updated",$c,"song":$songJson}""")) is JamFrame.SongUpdated)
        assertEquals(JamFrame.SongDeleted("c1", "s1"), JamFrame.decode(frame("""{"type":"jam-song-deleted",$c,"songId":"s1"}""")))
        assertTrue(JamFrame.decode(frame("""{"type":"jam-track-added",$c,"song":$songJson,"track":${trackJson()}}""")) is JamFrame.TrackAdded)
        assertTrue(JamFrame.decode(frame("""{"type":"jam-track-updated",$c,"song":$songJson,"track":${trackJson()}}""")) is JamFrame.TrackUpdated)
        assertTrue(JamFrame.decode(frame("""{"type":"jam-track-deleted",$c,"song":$songJson,"trackId":"t1"}""")) is JamFrame.TrackDeleted)
        assertEquals(
            JamFrame.TrackVotes("c1", "s1", "t1", 7),
            JamFrame.decode(frame("""{"type":"jam-track-votes",$c,"songId":"s1","trackId":"t1","voteCount":7}""")),
        )
    }

    @Test
    fun `a frame that does not decode, or is not a jam frame, is dropped quietly`() {
        assertNull(JamFrame.decode(frame("""{"type":"jam-song-created","channelId":"c1"}""")))
        assertNull(JamFrame.decode(frame("""{"type":"jam-track-votes","channelId":"c1","songId":"s1"}""")))
        assertNull(JamFrame.decode(frame("""{"type":"jam-from-the-future","channelId":"c1"}""")))
        assertNull(JamFrame.decode(frame("""{"type":"message-broadcast","channelId":"c1"}""")))
        assertTrue(JamFrame.isJam(frame("""{"type":"jam-track-votes"}""")))
        assertTrue(!JamFrame.isJam(frame("""{"type":"forum-post-upsert"}""")))
    }

    /**
     * The seven are what the shared package lists, and every one has a `when`
     * branch the scan in `RepoSources.frameTypesHandled` finds.
     */
    @Test
    fun `every jam frame in shared is handled by the app`() {
        val declared = Regex("\"(jam-[a-z-]+)\"")
            .findAll(RepoSources.read(jam).substringAfter("export const JAM_FRAME_TYPES = [").substringBefore("]"))
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(7, declared.size)
        assertEquals(
            "Jam frames the server sends and the app has no `when` branch for",
            emptySet<String>(),
            declared - RepoSources.frameTypesHandled(),
        )
        // And they are the frames the shared schemas declare, so a rename on the server fails here.
        assertEquals(emptySet<String>(), declared - RepoSources.sharedFrameTypeLiterals())
    }

    @Test
    fun `the song link is the web's route`() {
        assertEquals(
            "https://pqp.gg/app/server/srv/channel/chan/song/song1",
            jamSongLink("https://pqp.gg/", "srv", "chan", "song1"),
        )
    }
}
