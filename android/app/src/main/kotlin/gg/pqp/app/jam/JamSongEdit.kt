package gg.pqp.app.jam

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.max
import kotlin.math.min

/*
 * EDITING A SONG: its name, its artist and its cover. The web's `jam-edit-sheet.tsx`, `jam-cover.ts` and `jam-text.ts`,
 * with the same rules and in the same order, and none of it needing a phone (`JamSongEditTest`).
 *
 * TEXT is checked with the server's own rule (`jamTitleSchema` and `jamArtistSchema` in `packages/shared/src/jam.ts`:
 * bidi controls stripped, whitespace collapsed, something visible left to read, at most 100 characters) so "Salvar" is
 * never offered for a name the server will refuse, and a name of nothing but zero-width spaces is told apart from an
 * empty field.
 *
 * THE COVER is sent when it is picked and claimed when the person saves: the upload is a ticket, a PUT and an id, and
 * nothing about the song changes until the id is claimed, so closing the sheet leaves the old picture exactly as it was.
 */

object JamText {
    const val ARTIST_MAX = 100

    /** Override, embedding and isolate controls: STRIPPED, not refused (`BIDI_CONTROLS`). */
    private val BIDI_CONTROLS = Regex("[‪-‮⁦-⁩]")

    /** Whitespace in the JS sense: Java's `\s` is ASCII only, so the Unicode separators and the BOM are named. */
    private val WHITESPACE = Regex("[\\s\\p{Z}﻿]+")

    /** `CONTROL_CHARS`: what survives the whitespace collapse and is still not text. */
    private val CONTROL_CHARS = Regex("[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]")

    /**
     * What draws nothing: whitespace, every format character, combining marks and variation selectors on their own, the
     * fillers Unicode files as letters and the Braille blank (`INVISIBLE`). One visible character anywhere is enough.
     */
    private val INVISIBLE = Regex(
        "[\\s\\p{Z}\\p{Cc}\\p{Cf}\\p{M}͏ᅟᅠ឴឵⠀ㅤﾠ︀-️]|[\\x{E0100}-\\x{E01EF}]",
    )

    /** Bidi controls out, whitespace collapsed, trimmed (`cleanLine`). */
    fun cleanLine(value: String): String =
        WHITESPACE.replace(BIDI_CONTROLS.replace(value, ""), " ").trim()

    private fun hasVisibleText(value: String) = INVISIBLE.replace(value, "").isNotEmpty()

    sealed interface Checked {
        /** The text as the server will store it; null is "none" (an original), only ever for an artist. */
        data class Ok(val value: String?) : Checked

        /** Nothing typed, or only spaces. */
        data object Empty : Checked

        /** Something typed that draws nothing. */
        data object Invisible : Checked

        data object Long : Checked

        /** A control character. */
        data object Invalid : Checked
    }

    fun checkTitle(raw: String): Checked {
        val value = cleanLine(raw)
        return when {
            value.isEmpty() -> Checked.Empty
            value.length > JamLimits.TITLE_MAX -> Checked.Long
            CONTROL_CHARS.containsMatchIn(value) -> Checked.Invalid
            !hasVisibleText(value) -> Checked.Invisible
            else -> Checked.Ok(value)
        }
    }

    /** Cut at the limit first, like the field's own `maxLength`, as the web does. */
    fun checkArtist(raw: String): Checked {
        val value = cleanLine(raw).take(ARTIST_MAX)
        return when {
            value.isEmpty() -> Checked.Ok(null)
            CONTROL_CHARS.containsMatchIn(value) -> Checked.Invalid
            !hasVisibleText(value) -> Checked.Invisible
            else -> Checked.Ok(value)
        }
    }
}

/** What the person did to the cover in the sheet. */
sealed interface CoverChoice {
    data object Keep : CoverChoice
    data object Remove : CoverChoice
    data class New(val uploadId: String) : CoverChoice
}

sealed interface CoverOp {
    data class Set(val uploadId: String) : CoverOp
    data object Remove : CoverOp
}

/** The `PATCH /api/jam-songs/:id` body: only what changed, and `artist` explicitly null to clear it. */
data class SongPatch(val title: String? = null, val setArtist: Boolean = false, val artist: String? = null) {
    /** A hand-built object: `artist: null` is a value here (it clears the artist), which the app's JSON settings would omit. */
    fun toJson(): JsonObject = JsonObject(
        buildMap<String, kotlinx.serialization.json.JsonElement> {
            if (title != null) put("title", JsonPrimitive(title))
            if (setArtist) put("artist", artist?.let { JsonPrimitive(it) } ?: JsonNull)
        },
    )
}

data class SongEditPlan(val patch: SongPatch?, val cover: CoverOp?) {
    /** Nothing to save. */
    val empty: Boolean get() = patch == null && cover == null
}

object JamSongEdit {
    /**
     * What saving this sheet means (`planJamEdit`): only what changed is sent (a title edited back to what it was is
     * not a write and does not bump the song), the artist is cleared with null (an original), and a cover removed
     * from a song that has none is nothing.
     */
    fun plan(song: JamSongSummary, title: String, artist: String, cover: CoverChoice): SongEditPlan {
        // A row from before the server stripped bidi controls still holds them: it is compared as the server would
        // store it, so opening the sheet is not a change.
        val newTitle = (JamText.checkTitle(title) as? JamText.Checked.Ok)?.value
        val was = (JamText.checkTitle(song.title) as? JamText.Checked.Ok)?.value ?: song.title
        val titleChange = newTitle?.takeIf { it != was }
        val newArtist = JamText.checkArtist(artist) as? JamText.Checked.Ok
        val wasArtist: String? = song.artist?.let { (JamText.checkArtist(it) as? JamText.Checked.Ok)?.value }
        val artistChange = newArtist != null && newArtist.value != wasArtist
        val patch = if (titleChange != null || artistChange) {
            SongPatch(title = titleChange, setArtist = artistChange, artist = if (artistChange) newArtist?.value else null)
        } else {
            null
        }
        val op = when (cover) {
            is CoverChoice.New -> CoverOp.Set(cover.uploadId)
            CoverChoice.Remove -> if (song.coverUrl != null) CoverOp.Remove else null
            CoverChoice.Keep -> null
        }
        return SongEditPlan(patch, op)
    }
}

/** The cover's image, as numbers: what the phone does between a picked photo and the bytes it sends. */
object JamCover {
    /** `JAM_COVER_CONTENT_TYPES`: what the server accepts, and what the phone sends is always the JPEG. */
    val CONTENT_TYPES = listOf("image/jpeg", "image/png", "image/webp")
    const val SEND_TYPE = "image/jpeg"

    /** `JAM_COVER_MAX_BYTES`: 4 MiB. */
    const val MAX_BYTES = 4 * 1024 * 1024

    /** `JAM_COVER_SIZE`: the square the web sends. */
    const val SIZE = 1024

    /** The smallest side a photo may have (`JAM_COVER_MIN_SIDE`): smaller is a blur on a big tile. */
    const val MIN_SIDE = 400

    /** The JPEG qualities tried in turn until the file is under [MAX_BYTES]; the first nearly always is. */
    val QUALITIES = listOf(90, 82, 74, 66)

    sealed interface Verdict {
        data object Ok : Verdict
        data object Unreadable : Verdict
        data class Small(val width: Int, val height: Int) : Verdict
    }

    /** Looked at BEFORE the picture is decoded in full: an image of no size, or too small to be a cover, is refused in words. */
    fun check(width: Int, height: Int): Verdict = when {
        width <= 0 || height <= 0 -> Verdict.Unreadable
        min(width, height) < MIN_SIDE -> Verdict.Small(width, height)
        else -> Verdict.Ok
    }

    /** The centred square of a [width] x [height] picture: left, top, side. */
    fun centredSquare(width: Int, height: Int): Triple<Int, Int, Int> {
        val side = min(width, height)
        return Triple((width - side) / 2, (height - side) / 2, side)
    }

    /**
     * The power-of-two subsample that keeps a decode small without going under the [SIZE] square it ends as: a 48 MP
     * photo is read at a quarter of its size, not held whole.
     */
    fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        val side = min(width, height)
        while (side / (sample * 2) >= SIZE) sample *= 2
        return max(1, sample)
    }
}
