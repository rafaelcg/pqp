package gg.pqp.app.jam

import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/*
 * Jam channels on the wire, as `packages/shared/src/jam.ts` spells them.
 *
 * THE MODEL, ONCE. A jam is a channel of type `jam` that holds SONGS. A song is
 * a pile of TRACKS: one recorded stem each, one instrument, one person,
 * optionally with a video. A client plays every track that is `inMix` at the
 * same time. Nothing is mixed on the server.
 *
 * THE TIMELINE, ONCE (header of `jam.ts`). `offsetMs` is the song time of the
 * stored file's FIRST sample (which may be negative) and only
 * `audio[trimStartMs, durationMs - trimEndMs]` is heard: a trim hides audio and
 * never moves it, so the track is heard from `offsetMs + trimStartMs` to
 * `offsetMs + durationMs - trimEndMs`. Trims are applied at play time and never
 * touch the stored bytes. `audio/JamAlignment.kt` turns this into frames;
 * nothing else in the app does the arithmetic.
 *
 * Hand-copied like every other wire model here and pinned field by field
 * against the zod schemas by `JamContractTest`. Decoded leniently: a field a
 * card can live without has a default, so a server that adds one (or an
 * instrument it invented) costs a detail, not the whole list.
 */

/** The caps from `jam.ts`. `JamContractTest` pins each one. */
object JamLimits {
    const val TITLE_MAX = 100
    const val PAGE_SIZE = 25
    const val PAGE_MAX = 50
    const val MAX_TRACKS_PER_SONG = 32
    const val PEAKS_MAX = 400
    const val PREVIEW_PEAKS_MAX = 64
    const val PREVIEW_CONTRIBUTORS_MAX = 4
    const val GAIN_MAX = 2.0
    const val TRACK_MAX_DURATION_MS = 10 * 60 * 1000
}

/** `JAM_ERRORS`: the `error` token of a jam refusal. */
object JamErrors {
    const val OFF = "jam_channels_off"
    const val CLOSED = "jam_song_closed"
    const val INSTRUMENT_NOT_WANTED = "jam_instrument_not_wanted"
    const val SONG_FULL = "jam_song_full"
    const val AUTHOR_TRACK_LIMIT = "jam_author_track_limit"
    const val RATE_LIMITED = "jam_rate_limited"
}

/**
 * Order is the picker's order, and the order `instruments` arrives in. An
 * instrument a newer server invented reads as [Other], the way the shared
 * schema's `.catch("other")` does.
 */
enum class JamInstrument(val wire: String) {
    Guitar("guitar"),
    Bass("bass"),
    Drums("drums"),
    Vocals("vocals"),
    Keys("keys"),
    Other("other"),
    ;

    companion object {
        fun fromWire(token: String?): JamInstrument = entries.firstOrNull { it.wire == token } ?: Other
    }
}

/**
 * An unknown mode reads as [Closed]: the most permissive reading would invite
 * people the server may refuse, and the most restrictive one is the safe copy.
 */
enum class JamJoinMode(val wire: String) {
    Open("open"),
    Wanted("wanted"),
    Closed("closed"),
    ;

    companion object {
        fun fromWire(token: String?): JamJoinMode = entries.firstOrNull { it.wire == token } ?: Closed
    }
}

object JamInstrumentSerializer : KSerializer<JamInstrument> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("JamInstrument", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): JamInstrument = JamInstrument.fromWire(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: JamInstrument) = encoder.encodeString(value.wire)
}

object JamJoinModeSerializer : KSerializer<JamJoinMode> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("JamJoinMode", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): JamJoinMode = JamJoinMode.fromWire(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: JamJoinMode) = encoder.encodeString(value.wire)
}

/** `GET /api/jam/config?serverId=`. Off hides the row on this build: an unflagged server looks as it always did. */
@Serializable
data class JamConfig(
    val enabled: Boolean = false,
    /** Object storage is configured, so a track could be added at all. */
    val uploads: Boolean = false,
) {
    companion object {
        val Off = JamConfig()
    }
}

/** ISO date to epoch milliseconds, or 0 for something that is not one. */
internal fun parseJamInstant(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)

/**
 * One song as every viewer who can see the channel sees it: the list, the
 * detail and the song frames. Counts, not media: no peaks, no video flag and no
 * names of contributors, which is why a tile reads the detail lazily.
 */
@Serializable
data class JamSongSummary(
    val id: String,
    val channelId: String,
    val serverId: String = "",
    val title: String,
    /** The original artist. Null means the song is an original. */
    val artist: String? = null,
    @Serializable(with = JamJoinModeSerializer::class)
    val joinMode: JamJoinMode = JamJoinMode.Open,
    /** Empty unless [joinMode] is wanted. */
    val wantedInstruments: List<@Serializable(with = JamInstrumentSerializer::class) JamInstrument> = emptyList(),
    /** Null once the account is gone ("Conta excluída"). */
    val authorId: String? = null,
    val authorName: String? = null,
    val authorAvatarUrl: String? = null,
    val createdAt: String = "",
    /** The bump: created, edited, a track added, changed or removed. The list sorts on it. */
    val updatedAt: String = "",
    val trackCount: Int = 0,
    /** Distinct instruments among the live tracks, in picker order. */
    val instruments: List<@Serializable(with = JamInstrumentSerializer::class) JamInstrument> = emptyList(),
    val contributorCount: Int = 0,
    /** Length of the default mix. Null with no `inMix` track. */
    val mixDurationMs: Double? = null,
    // The preview, what a wall of songs draws without opening each one (jam.ts, "the preview"). The server added
    // these after the first release and every one has a default there, so an OLDER server sends none of them. Here
    // each is NULL when it was not sent and a real value (possibly empty) when it was: null is "ask the detail",
    // empty is "the server looked and there is nothing". `JamTileInfo` is the one place that tells the two apart.
    /** The loudest in-mix stem's peaks, at most 64 values in 0..1; empty when no in-mix stem has any. */
    val previewPeaks: List<Double>? = null,
    /** At least one live track has a video. */
    val hasVideo: Boolean? = null,
    /** Up to four people with a live track, in the order of their first track. [contributorCount] is the full number. */
    val contributors: List<JamContributor>? = null,
    /** For a wanted song, the wanted instruments nobody has a live track for yet; empty for every other mode. */
    val missingInstruments: List<@Serializable(with = JamInstrumentSerializer::class) JamInstrument>? = null,
) {
    val updatedAtMs: Long get() = parseJamInstant(updatedAt)
    val createdAtMs: Long get() = parseJamInstant(createdAt)

    /** True when this summary carries the whole preview (a server that has it), so a tile needs no detail read for it. */
    val hasPreview: Boolean get() = previewPeaks != null && contributors != null && missingInstruments != null && hasVideo != null
}

/** One person with a live track, as a tile draws them (`jamContributorSchema`). */
@Serializable
data class JamContributor(
    val id: String,
    val name: String? = null,
    val avatarUrl: String? = null,
)

/** What the caller may do in one song. Per viewer: never cached, never framed. */
@Serializable
data class JamSongViewer(
    val isAuthor: Boolean = false,
    /** MANAGE_MESSAGES or MANAGE_CHANNELS on the channel: may edit and delete anything. */
    val canModerate: Boolean = false,
    val addableInstruments: List<@Serializable(with = JamInstrumentSerializer::class) JamInstrument> = emptyList(),
    /** The tracks (ids) the caller has voted for. */
    val votedTrackIds: List<String> = emptyList(),
)

@Serializable
data class JamSongListResponse(
    val songs: List<JamSongSummary> = emptyList(),
    /** Opaque keyset cursor; null at the end. */
    val nextCursor: String? = null,
)

/**
 * One track, shared by every viewer. [audioUrl] and [videoUrl] are presigned
 * GETs valid until [mediaExpiresAt]; a screen that outlives them re-reads the
 * song for fresh ones.
 */
@Serializable
data class JamTrack(
    val id: String,
    val songId: String,
    val authorId: String = "",
    val authorName: String? = null,
    val authorAvatarUrl: String? = null,
    @Serializable(with = JamInstrumentSerializer::class)
    val instrument: JamInstrument = JamInstrument.Other,
    val label: String? = null,
    val audioUrl: String = "",
    val audioContentType: String = "",
    val audioBytes: Long = 0,
    val videoUrl: String? = null,
    val videoContentType: String? = null,
    val videoBytes: Long? = null,
    val mediaExpiresAt: String = "",
    /** The song time of the stored file's FIRST sample (a count-in is before 0). May be negative. */
    val offsetMs: Double = 0.0,
    val trimStartMs: Double = 0.0,
    val trimEndMs: Double = 0.0,
    /** The full length of the stored audio. */
    val durationMs: Double = 0.0,
    val gain: Double = 1.0,
    /** Up to 400 numbers in 0..1 across the WHOLE recording, before trims. */
    val peaks: List<Double> = emptyList(),
    val inMix: Boolean = false,
    val voteCount: Int = 0,
    val createdAt: String = "",
) {
    val hasVideo: Boolean get() = !videoUrl.isNullOrBlank()

    /** The length the track plays for on the song timeline (`jamTrackPlayedMs`). */
    val playedMs: Double get() = maxOf(0.0, durationMs - trimStartMs - trimEndMs)

    /** Where the first HEARD sample sits on the song timeline: the file's start plus the head the trim hides (`jamTrackStartMs`). */
    val startMs: Double get() = offsetMs + trimStartMs

    /** Where the heard slice ends: the file's end less the tail the trim hides (`jamTrackEndMs`). */
    val endMs: Double get() = offsetMs + durationMs - trimEndMs

    val createdAtMs: Long get() = parseJamInstant(createdAt)

    /**
     * The envelope at a song time, 0 outside the heard slice. `peaks` run
     * across the whole stored recording, so the position in them is the file
     * time: `t - offset`.
     */
    fun peakAt(songMs: Double): Double {
        if (peaks.isEmpty() || durationMs <= 0 || songMs < startMs || songMs >= endMs) return 0.0
        val fileMs = songMs - offsetMs
        val index = (fileMs / durationMs * peaks.size).toInt().coerceIn(0, peaks.size - 1)
        return peaks[index].coerceIn(0.0, 1.0)
    }
}

/** `GET /api/jam-songs/:songId`: the deep link and the song view. */
@Serializable
data class JamSongDetailResponse(
    val song: JamSongSummary,
    val tracks: List<JamTrack> = emptyList(),
    val viewer: JamSongViewer = JamSongViewer(),
)

/** The answer of a vote or an unvote: the new count and where the caller stands. */
@Serializable
data class JamVoteResponse(
    val trackId: String,
    val songId: String,
    val voteCount: Int = 0,
    val voted: Boolean = false,
)

/** The answer of a track edit: the track and the song's fresh summary. */
@Serializable
data class JamTrackWithSong(
    val track: JamTrack,
    val song: JamSongSummary,
)

/** `PATCH /api/jam-tracks/:trackId`, the one field the phone writes today. */
@Serializable
data class UpdateJamTrackRequest(val inMix: Boolean? = null)
