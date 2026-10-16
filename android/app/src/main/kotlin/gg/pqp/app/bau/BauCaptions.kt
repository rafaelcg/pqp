package gg.pqp.app.bau

import android.content.Context
import gg.pqp.app.core.ApiClient
import gg.pqp.app.social.getJson
import java.util.Locale
import kotlinx.serialization.Serializable

/**
 * Automatic subtitles of an uploaded Baú video (`community_home_video_captions`, per server).
 *
 * On the post only as "there are some, in these languages" (`communityHomePostCaptionsSchema`): the cues
 * travel through `GET .../home/posts/:postId/captions?lang=`, which is authorised like the video itself,
 * so a feed of fifty posts does not carry fifty transcripts. `null` on the post while the flag is off for
 * the server or nothing has been made yet.
 */
@Serializable
data class BauPostCaptions(
    /** What Whisper heard (ISO-639-1 when it could tell, e.g. `pt`). */
    val sourceLang: String = "",
    /** Tracks the captions route will answer with: the source, plus a translation when one is current. */
    val langs: List<String> = emptyList(),
    /**
     * Length of the sound that was transcribed. The phone plays the vertical cut when the post has one,
     * and the subtitles belong to the main file: a cut of another length would drift, so they are shown
     * only while this agrees with the file that is playing.
     */
    val durationMs: Long? = null,
)

/** One track of `communityHomeCaptionTrackSchema`: a complete WebVTT file. */
@Serializable
data class BauCaptionTrack(
    val lang: String = "",
    /** True for the transcription itself, false for a translation of it. */
    val source: Boolean = false,
    /** Machine made, always today. */
    val auto: Boolean = true,
    val vtt: String = "",
)

@Serializable
data class BauCaptionsResponse(val tracks: List<BauCaptionTrack> = emptyList())

/** `GET /api/servers/:id/home/posts/:id/captions?lang=`: the tracks for the reader's UI language. */
suspend fun ApiClient.bauCaptions(serverId: String, postId: String, lang: String): List<BauCaptionTrack> =
    getJson<BauCaptionsResponse>(
        "/api/servers/$serverId/home/posts/$postId/captions",
        mapOf("lang" to lang),
    ).tracks

/** What the player needs to know about a post's subtitles. */
data class BauCaptionsSource(
    val serverId: String,
    val postId: String,
    val sourceLang: String,
    val durationMs: Long?,
    /** The vertical cut is what plays: its length must agree with the transcribed sound. */
    val mustMatchDuration: Boolean,
)

/** One line of subtitle, in milliseconds from the start of the video. */
data class CaptionCue(val startMs: Long, val endMs: Long, val text: String)

/**
 * Which track to show, whether to show it by default, how to read it. The rules are the web's
 * (`client/src/lib/community-home/captions.ts`): subtitles start ON when the video is in another language
 * than the reader's (that is who they are for), OFF when it is the reader's own, and once a person presses
 * the CC button, that choice wins on every video after it.
 */
object BauCaptions {

    /** `CAPTIONS_DURATION_TOLERANCE_MS` in `community-home-media.tsx`. */
    const val DURATION_TOLERANCE_MS = 1_500L

    /** `pt-BR` and `pt` are one language here, like the post translations. */
    fun baseLang(raw: String?): String? {
        val base = raw?.trim()?.lowercase()?.split('-', '_')?.firstOrNull()?.takeIf { it.isNotEmpty() } ?: return null
        return base
    }

    /** What goes in `?lang=`: the reader's language; the server keeps it only if it translates into it. */
    fun requestLang(readerLocale: String): String = baseLang(readerLocale) ?: "en"

    fun onByDefault(sourceLang: String, readerLocale: String, stored: Boolean?): Boolean {
        if (stored != null) return stored
        val source = baseLang(sourceLang)
        // A track whose language Whisper could not tell is not assumed to be ours.
        if (source == null || source == "und") return true
        return source != baseLang(readerLocale)
    }

    /** The reader's own language when there is a track in it, else what was said. */
    fun pickTrack(tracks: List<BauCaptionTrack>, readerLocale: String): BauCaptionTrack? {
        val reader = baseLang(readerLocale)
        return tracks.firstOrNull { baseLang(it.lang) == reader }
            ?: tracks.firstOrNull { it.source }
            ?: tracks.firstOrNull()
    }

    /** Whether the subtitles may be shown on the file that is playing, which has [playerDurationMs] (null until known). */
    fun fits(source: BauCaptionsSource, playerDurationMs: Long?): Boolean {
        if (!source.mustMatchDuration) return true
        val transcribed = source.durationMs ?: return false
        val playing = playerDurationMs ?: return false
        return kotlin.math.abs(playing - transcribed) <= DURATION_TOLERANCE_MS
    }

    /** "Português", "English": the language in the reader's own UI language, or null for one that has no name. */
    fun languageName(lang: String, uiLocale: Locale): String? {
        if (lang.isBlank() || lang == "und") return null
        val name = Locale.forLanguageTag(lang).getDisplayLanguage(uiLocale)
        if (name.isBlank() || name.equals(lang, ignoreCase = true)) return null
        return name.replaceFirstChar { it.titlecase(uiLocale) }
    }

    // --- WebVTT ---

    private val TIMING = Regex("""^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})""")
    private val TAG = Regex("""<[^>]*>""")

    /**
     * A WebVTT file as cues. The server writes `WEBVTT`, then blocks of an index, `HH:MM:SS.mmm --> HH:MM:SS.mmm`
     * and one or two lines of text with `&`, `<` and `>` escaped; this reads that and any ordinary file of the
     * same shape (a block without an index, minute-only timestamps, a comma for the dot, cue settings after the
     * times), and never throws: a block it cannot read is skipped.
     */
    fun parseVtt(vtt: String): List<CaptionCue> {
        val cues = ArrayList<CaptionCue>()
        val blocks = vtt.replace("\r\n", "\n").replace('\r', '\n').split(Regex("\n{2,}"))
        for (block in blocks) {
            val lines = block.split('\n')
            val timingIndex = lines.indexOfFirst { TIMING.containsMatchIn(it) }
            if (timingIndex < 0) continue
            val match = TIMING.find(lines[timingIndex]) ?: continue
            val start = timestampMs(match.groupValues[1]) ?: continue
            val end = timestampMs(match.groupValues[2]) ?: continue
            val text = lines.drop(timingIndex + 1)
                .joinToString("\n") { unescape(it.replace(TAG, "")) }
                .trim()
            if (text.isEmpty() || end <= start) continue
            cues += CaptionCue(start, end, text)
        }
        return cues.sortedBy { it.startMs }
    }

    private fun timestampMs(raw: String): Long? {
        val parts = raw.replace(',', '.').split(':')
        if (parts.size !in 2..3) return null
        val (seconds, millis) = parts.last().split('.').let { it[0] to (it.getOrNull(1) ?: "0") }
        val h = if (parts.size == 3) parts[0].toLongOrNull() ?: return null else 0L
        val m = parts[parts.size - 2].toLongOrNull() ?: return null
        val s = seconds.toLongOrNull() ?: return null
        val ms = millis.padEnd(3, '0').take(3).toLongOrNull() ?: return null
        return ((h * 60 + m) * 60 + s) * 1000 + ms
    }

    private fun unescape(text: String): String =
        text.replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")

    /** The text to show at [positionMs], or "" between cues. [cues] is sorted by start. */
    fun cueAt(cues: List<CaptionCue>, positionMs: Long): String {
        if (cues.isEmpty()) return ""
        // The last cue that has started; a few may overlap, the latest to start wins, like a browser.
        var low = 0
        var high = cues.size - 1
        var found = -1
        while (low <= high) {
            val mid = (low + high) ushr 1
            if (cues[mid].startMs <= positionMs) {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        // Walk back over cues that already ended: an earlier, longer one may still be on.
        var i = found
        var steps = 0
        while (i >= 0 && steps < 4) {
            if (positionMs < cues[i].endMs) return cues[i].text
            i -= 1
            steps += 1
        }
        return ""
    }
}

/**
 * The reader's own choice of subtitles on or off, once pressed, wins on every video after it
 * (`COMMUNITY_HOME_CAPTIONS_PREF_KEY` on the web). On this phone, not on the account: same as the web, where
 * it is the browser's.
 */
object BauCaptionsPreference {
    private const val FILE = "pqp_bau"
    private const val KEY = "captions"

    fun read(context: Context): Boolean? =
        when (context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)) {
            "on" -> true
            "off" -> false
            else -> null
        }

    fun write(context: Context, on: Boolean) {
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit().putString(KEY, if (on) "on" else "off").apply()
    }
}
