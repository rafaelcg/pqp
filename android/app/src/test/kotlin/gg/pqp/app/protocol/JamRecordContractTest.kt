package gg.pqp.app.protocol

import gg.pqp.app.core.PqpJson
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamInstrumentColors
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.record.AddJamTrackRequest
import gg.pqp.app.jam.record.CreateJamSongRequest
import gg.pqp.app.jam.record.CreateJamUploadRequest
import gg.pqp.app.jam.record.JamFlac
import gg.pqp.app.jam.record.JamTakeStudioLimits
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.elementNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the studio SENDS, against `packages/shared/src/jam.ts`: the three request
 * bodies (field by field), the audio type (the server accepts FLAC, and FLAC is
 * what the web uploads and every client decodes without moving a sample), the
 * limits a take is held to, and the instrument colours against the web's own
 * tokens in `client/src/index.css`.
 */
class JamRecordContractTest {
    private val jam = "packages/shared/src/jam.ts"

    private fun assertSubset(serializer: KSerializer<*>, schema: String) {
        val schemaKeys = RepoSources.objectKeys(jam, schema).toSet()
        val kotlinKeys = serializer.descriptor.elementNames.toSet()
        assertEquals("${serializer.descriptor.serialName} names fields $schema does not have", emptySet<String>(), kotlinKeys - schemaKeys)
    }

    @Test
    fun `every field the studio sends is one the schema has`() {
        assertSubset(CreateJamSongRequest.serializer(), "createJamSongSchema")
        assertSubset(CreateJamUploadRequest.serializer(), "createJamUploadSchema")
        assertSubset(AddJamTrackRequest.serializer(), "addJamTrackSchema")
    }

    @Test
    fun `the track claim sends every number the placement needs, and the server's defaults are not what it relies on`() {
        val sent = AddJamTrackRequest.serializer().descriptor.elementNames.toSet()
        // The placement is these four and the length: a field the schema defaults (0, 0, 1) must still be on the wire,
        // so a request never depends on what the server would have filled in.
        assertTrue(sent.containsAll(setOf("offsetMs", "trimStartMs", "trimEndMs", "gain", "durationMs", "peaks", "audioUploadId", "instrument")))
        val json = PqpJson.encodeToString(
            AddJamTrackRequest.serializer(),
            AddJamTrackRequest("guitar", null, "8f4c0c1e-0000-4000-8000-000000000000", 62_023, -2023.0, 2023.0, 0.0, 1.0, listOf(0.5)),
        )
        for (field in listOf("\"offsetMs\":-2023.0", "\"trimStartMs\":2023.0", "\"trimEndMs\":0.0", "\"gain\":1.0", "\"durationMs\":62023")) {
            assertTrue("$field is on the wire: $json", json.contains(field))
        }
    }

    @Test
    fun `the audio a take is uploaded as is FLAC, and FLAC is something the server accepts`() {
        val source = RepoSources.stripComments(RepoSources.read(jam))
        val accepted = Regex("""JAM_AUDIO_CONTENT_TYPES\s*=\s*\[(.*?)]""", RegexOption.DOT_MATCHES_ALL).find(source)!!.groupValues[1]
        assertTrue("audio/flac is in JAM_AUDIO_CONTENT_TYPES: $accepted", accepted.contains("\"audio/flac\""))
        // The web's upload step names the same type.
        assertTrue(RepoSources.read("client/src/lib/jam/upload.ts").contains("STEM_AUDIO_MIME = \"audio/flac\""))
        // And the bytes the studio writes are a FLAC stream.
        assertEquals("fLaC", String(JamFlac.encode(ShortArray(100), 48_000), 0, 4))
    }

    @Test
    fun `the limits a take is held to are the shared ones`() {
        assertEquals(RepoSources.numberConstant(jam, "JAM_TRACK_MIN_DURATION_MS"), JamTakeStudioLimits.MIN_TRACK_MS)
        val source = RepoSources.stripComments(RepoSources.read(jam))
        assertTrue(source.contains("JAM_TRACK_MAX_DURATION_MS = 10 * 60 * 1000"))
        assertEquals(10 * 60 * 1000, JamTakeStudioLimits.MAX_TRACK_MS)
        assertTrue(source.contains("JAM_OFFSET_MAX_MS = 10 * 60 * 1000"))
        // A take that starts a count-in and a whole song before the zero still fits the server's offset window.
        assertTrue(JamTakeStudioLimits.MAX_TRACK_MS + 8_000 < JamTakeStudioLimits.OFFSET_MAX_MS * 2)
        assertEquals(RepoSources.numberConstant(jam, "JAM_PEAKS_MAX"), gg.pqp.app.jam.JamLimits.PEAKS_MAX)
        // The nudge limit the web allows is the one the phone allows.
        assertTrue(RepoSources.read("client/src/lib/jam-take-edit.ts").contains("NUDGE_LIMIT_MS = 500"))
        assertEquals(500, gg.pqp.app.jam.record.JamTakeEdit.NUDGE_LIMIT_MS)
    }

    @Test
    fun `the upload errors the studio tells apart are the shared tokens`() {
        val source = RepoSources.read(jam)
        listOf("jam_channels_off", "jam_song_closed", "jam_instrument_not_wanted", "jam_song_full", "jam_author_track_limit", "jam_upload_too_large", "jam_storage_off", "jam_rate_limited")
            .forEach { assertTrue("$it is a JAM_ERRORS value", source.contains("\"$it\"")) }
    }

    // --- covers ---

    private val song =
        """{"id":"00000000-0000-4000-8000-000000000001","channelId":"c","serverId":"s","title":"t","createdAt":"","updatedAt":"","trackCount":1,"instruments":[],"contributorCount":1,"mixDurationMs":1000}"""

    private fun withCover(url: String?) =
        if (url == null) song else song.removeSuffix("}") + ",\"coverUrl\":\"$url\"}"

    @Test
    fun `a cover is read, and an older server's song has none`() {
        val withCover = PqpJson.decodeFromString(JamSongSummary.serializer(), withCover("https://bucket.example/jam/covers/abc.jpg?X-Sig=1"))
        assertEquals("https://bucket.example/jam/covers/abc.jpg?X-Sig=1", withCover.coverUrl)
        assertNull(PqpJson.decodeFromString(JamSongSummary.serializer(), song).coverUrl)
        assertNull(PqpJson.decodeFromString(JamSongSummary.serializer(), song.removeSuffix("}") + ",\"coverUrl\":null}").coverKey)
    }

    @Test
    fun `a cover is cached under the song and the picture's path, never the signed address`() {
        fun key(url: String?) = PqpJson.decodeFromString(JamSongSummary.serializer(), withCover(url)).coverKey
        val first = key("https://bucket.example/jam/covers/abc.jpg?X-Amz-Signature=one&X-Amz-Expires=43200")
        // The song read again twelve hours later: a different signature, the same picture.
        assertEquals(first, key("https://bucket.example/jam/covers/abc.jpg?X-Amz-Signature=two&X-Amz-Expires=43200"))
        // A replaced cover is another object, so another key; another song's cover is another key too.
        assertTrue(first != key("https://bucket.example/jam/covers/def.jpg?X-Amz-Signature=one"))
        assertNotNull(first)
        assertTrue(first!!.contains("00000000-0000-4000-8000-000000000001"))
        assertTrue("no query string in the key", !first.contains("X-Amz"))
        assertNull(key(null))
        assertNull(key(""))
    }

    // --- the instrument colours ---

    /** OKLCH to sRGB, the CSS Color 4 way (OKLab, then linear sRGB, then the sRGB curve, clipped). */
    private fun oklch(l: Double, c: Double, h: Double): Int {
        val a = c * cos(Math.toRadians(h))
        val b = c * sin(Math.toRadians(h))
        val l_ = (l + 0.3963377774 * a + 0.2158037573 * b).pow(3)
        val m_ = (l - 0.1055613458 * a - 0.0638541728 * b).pow(3)
        val s_ = (l - 0.0894841775 * a - 1.2914855480 * b).pow(3)
        val r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
        val g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
        val bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
        fun enc(x: Double): Int {
            val v = x.coerceIn(0.0, 1.0)
            return ((if (v <= 0.0031308) 12.92 * v else 1.055 * v.pow(1 / 2.4) - 0.055) * 255).roundToInt()
        }
        return (enc(r) shl 16) or (enc(g) shl 8) or enc(bl)
    }

    private fun token(name: String): Int {
        val css = RepoSources.read("client/src/index.css")
        val m = Regex("""--color-$name:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)""").find(css)
            ?: error("--color-$name is gone from client/src/index.css")
        return oklch(m.groupValues[1].toDouble(), m.groupValues[2].toDouble(), m.groupValues[3].toDouble())
    }

    private fun channels(rgb: Int) = intArrayOf((rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF)

    private fun assertSame(name: String, want: Int, got: Long) {
        val g = channels((got and 0xFFFFFF).toInt())
        val w = channels(want)
        for (i in 0..2) assertTrue("$name: channel $i is ${g[i]}, the web's token converts to ${w[i]}", kotlin.math.abs(g[i] - w[i]) <= 2)
        assertEquals("$name is opaque", 0xFFL, got ushr 24)
    }

    @Test
    fun `the six instrument colours and their ink are the web's tokens`() {
        for (instrument in JamInstrument.entries) {
            assertSame(instrument.wire, token("inst-${instrument.wire}"), JamInstrumentColors.of(instrument))
        }
        assertSame("on-inst", token("on-inst"), JamInstrumentColors.INK)
    }

    @Test
    fun `the guitar is yellow, and no instrument is the app's lime`() {
        val guitar = channels((JamInstrumentColors.GUITAR and 0xFFFFFF).toInt())
        // Yellow: red and green high, blue low. Lime is green-dominant (the app's accent), which this must not be.
        assertTrue("red ${guitar[0]} is high", guitar[0] > 230)
        assertTrue("green ${guitar[1]} is high but under the red", guitar[1] > 190 && guitar[1] < guitar[0])
        assertTrue("blue ${guitar[2]} is low", guitar[2] < 130)
        val colors = JamInstrument.entries.map { JamInstrumentColors.of(it) }
        assertEquals("six different colours", 6, colors.toSet().size)
    }
}
