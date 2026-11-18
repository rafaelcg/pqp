package gg.pqp.app.jam.record

import gg.pqp.app.core.PqpJson
import java.io.File
import kotlinx.serialization.Serializable

/**
 * A song the person is making: what a first take creates the song with.
 * Stored beside the take, so a take that survived the process dying can still
 * be sent as a new song, and a retry lands on the same song (`nonce`).
 */
@Serializable
data class NewSongDraft(
    val title: String,
    val artist: String? = null,
    val joinMode: String = "open",
    val wantedInstruments: List<String> = emptyList(),
    val nonce: String,
)

/**
 * A finished take, on disk. A take that is recorded and not yet sent exists
 * nowhere else, so it is written the moment recording stops and removed only
 * when it is sent or the person throws it away: leaving the studio, the app
 * being killed, a call coming in or the phone running out of battery between
 * "parar" and "mandar" cost nothing but a tap.
 *
 * The audio is the raw capture (`<id>.pcm`, little-endian 16-bit mono at 48 kHz,
 * exactly what the microphone gave) and everything about where it goes is in
 * `<id>.json`. Offsets here are the take's own placement, before the person's
 * [nudgeMs], which is applied on top and saved with it.
 */
@Serializable
data class SavedTake(
    val id: String,
    val channelId: String,
    /** The song it is for; null for a first take of a song that does not exist yet (see [draft]). */
    val songId: String?,
    val draft: NewSongDraft? = null,
    /** The song [draft] became, once it was created, so a retry does not make a second one. */
    val createdSongId: String? = null,
    val instrument: String,
    val offsetMs: Double,
    val trimStartMs: Double,
    val durationMs: Double,
    /** Leading captured samples that are not part of the take (the offset is made whole by dropping them). */
    val dropFrames: Int,
    val frames: Long,
    val peaks: List<Double>,
    val nudgeMs: Int = 0,
    /** The correction this take was placed with, and what measured it, for the review's "Fone ajustado". */
    val correctionMs: Double = 0.0,
    val routeKey: String = "",
    val routeChanged: Boolean = false,
    val uncalibrated: Boolean = false,
    val savedAt: Long = 0L,
    /** The account that recorded it; a take is never offered to another account on the same phone. */
    val ownerId: String? = null,
) {
    /** Where a sent track will put the file's first sample: the take's own offset and the person's nudge. */
    val placedOffsetMs: Double get() = offsetMs + nudgeMs
}

class JamTakeStore(private val dir: File) {
    init {
        dir.mkdirs()
    }

    fun pcm(id: String) = File(dir, "$id.pcm")
    private fun meta(id: String) = File(dir, "$id.json")

    /** A fresh capture file for a take about to be recorded. */
    fun newCapture(id: String): File = pcm(id).also { it.delete() }

    fun save(take: SavedTake) {
        val tmp = File(dir, "${take.id}.json.tmp")
        tmp.writeText(PqpJson.encodeToString(SavedTake.serializer(), take))
        if (!tmp.renameTo(meta(take.id))) {
            meta(take.id).writeText(tmp.readText())
            tmp.delete()
        }
    }

    fun load(id: String): SavedTake? =
        runCatching { PqpJson.decodeFromString(SavedTake.serializer(), meta(id).readText()) }.getOrNull()
            ?.takeIf { pcm(id).isFile }

    /** Every take that is still waiting to be sent, newest first. */
    fun all(): List<SavedTake> =
        dir.listFiles { f -> f.name.endsWith(".json") }.orEmpty()
            .mapNotNull { load(it.name.removeSuffix(".json")) }
            .sortedByDescending { it.savedAt }

    /** The take waiting for this song (or, with a null [songId], for a new song in this channel). */
    fun pending(channelId: String, songId: String?, ownerId: String? = null): SavedTake? =
        all().firstOrNull { it.channelId == channelId && it.songId == songId && it.ownerId == ownerId }

    fun delete(id: String) {
        pcm(id).delete()
        meta(id).delete()
        File(dir, "$id.flac").delete()
    }

    /** The encoded copy of a take, kept so a retry does not encode again. */
    fun flac(id: String) = File(dir, "$id.flac")

    /**
     * Files nothing refers to: a capture whose take was never finished (the
     * process died mid-recording) or a leftover encode. Called when a studio opens.
     */
    fun sweepOrphans() {
        val live = all().mapTo(HashSet()) { it.id }
        dir.listFiles().orEmpty().forEach { f ->
            val id = f.name.substringBefore('.')
            if (id !in live && !f.name.startsWith("calibration")) f.delete()
        }
    }
}
