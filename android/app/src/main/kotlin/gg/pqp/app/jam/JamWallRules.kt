package gg.pqp.app.jam

import kotlin.math.max
import kotlin.math.min

/*
 * THE WALL'S RULES, PURE. What a tile says it needs, which filter shows it,
 * where it sits in the mosaic, what a live frame does to the list, and what
 * "unread" means for a channel that carries no messages. None of it touches the
 * network or a view, so each is a test (`JamWallRulesTest`). Where a choice is
 * arbitrary it is the iOS client's (`JamWallRules.swift`), so the two phones
 * agree.
 */

// --- What a song needs ---

/**
 * The one line a tile carries about the song's state. The wire gives a join
 * mode, a wanted list and the instruments present; this is what a person reads
 * off them ("falta voz", "qualquer um entra", "pronta").
 */
sealed interface JamNeed {
    /** The author is looking for these, and nobody has played them yet. */
    data class Missing(val instruments: List<JamInstrument>) : JamNeed

    /** Anybody may add any instrument. */
    data object Open : JamNeed

    /** Nothing more is being asked for. */
    data object Ready : JamNeed

    /** No track yet. */
    data object Empty : JamNeed

    /**
     * Whether somebody could still step in: the "Falta alguém" filter. An open
     * song counts, because a person browsing for where to play wants it too.
     */
    val wantsSomeone: Boolean get() = this !is Ready

    companion object {
        fun of(song: JamSongSummary): JamNeed {
            if (song.trackCount == 0) return Empty
            return when (song.joinMode) {
                JamJoinMode.Open -> Open
                JamJoinMode.Closed -> Ready
                JamJoinMode.Wanted -> {
                    // The server says what is still missing (`missingInstruments`); an older one does not, and then
                    // it is worked out from what the song lists and what the author wants. Same answer either way.
                    val missing = song.missingInstruments ?: song.wantedInstruments.filter { it !in song.instruments.toSet() }
                    if (missing.isEmpty()) Ready else Missing(missing)
                }
            }
        }
    }
}

enum class JamWallFilter {
    All,
    Missing,
    Finished,
    ;

    fun matches(song: JamSongSummary): Boolean = when (this) {
        All -> true
        Missing -> JamNeed.of(song).wantsSomeone
        Finished -> JamNeed.of(song) == JamNeed.Ready
    }
}

// --- Who is on it ---

object JamWho {
    /**
     * "rafa, duda, leo" or "rafa, duda +2". [contributors] is the list of
     * people with a track once the detail has been read; before that the author
     * stands in for the rest, with the count the summary carries.
     */
    fun line(song: JamSongSummary, contributors: List<String>?, maxNames: Int = 3): String {
        val names = contributors.orEmpty().filter { it.isNotEmpty() }
        if (names.isEmpty()) {
            val author = song.authorName.orEmpty()
            val rest = max(0, song.contributorCount - (if (song.authorName == null) 0 else 1))
            if (author.isEmpty()) return if (rest > 0) "+$rest" else ""
            return if (rest > 0) "$author +$rest" else author
        }
        // The summary lists at most four people while `contributorCount` is the full number: "+N" counts the rest.
        val total = max(song.contributorCount, names.size)
        if (total <= maxNames) return names.joinToString(", ")
        val shown = names.take(maxNames - 1)
        return shown.joinToString(", ") + " +${total - shown.size}"
    }

    /** The instruments in picker order. */
    fun instruments(song: JamSongSummary): List<JamInstrument> =
        JamInstrument.entries.filter { it in song.instruments }
}

// --- What a tile draws, from the summary when the server sends the preview, from the detail when it does not ---

/**
 * One tile's data, from the two places it can come from.
 *
 * A server that sends the preview (`previewPeaks`, `hasVideo`, `contributors`, `missingInstruments` on every
 * summary, in the list, the detail and the song frames) answers a whole wall from the list alone: no request per
 * tile, and a tile never differs from what a frame says. The ONE thing a summary cannot give is a video's URL, so
 * a poster still reads the detail, only for a tile with `hasVideo`, and only when it is on or near the screen.
 * A server that does not send them (an older deployment) leaves them null, and every tile reads its detail, lazily,
 * exactly as before.
 */
object JamTileInfo {
    /** The waveform a tile draws: the summary's, else the one worked out from the detail's peaks. */
    fun envelope(song: JamSongSummary, preview: JamPreview?): List<Double> =
        song.previewPeaks ?: preview?.envelope.orEmpty()

    /** The people on it by name: the summary's list, else the detail's. Null when neither is known yet. */
    fun contributorNames(song: JamSongSummary, preview: JamPreview?): List<String>? =
        song.contributors?.mapNotNull { it.name } ?: preview?.contributors

    fun hasVideo(song: JamSongSummary, preview: JamPreview?): Boolean =
        song.hasVideo ?: (preview?.hasVideo == true)

    /** Whether the waveform is there to draw (so it can draw in): the summary has it, or the detail has been read. */
    fun hasEnvelope(song: JamSongSummary, preview: JamPreview?): Boolean = song.previewPeaks != null || preview != null

    /**
     * Whether this tile has to read the song's detail. Never for a song with nothing on it. With the preview on the
     * summary, only for a poster (a tile with video); without it, always, for everything the summary lacks.
     */
    fun needsDetail(song: JamSongSummary): Boolean = when {
        song.trackCount == 0 -> false
        song.hasPreview -> song.hasVideo == true
        else -> true
    }
}

// --- The mosaic ---

/** One tile's cell: a column, a row and a span, on a grid [columns] wide. */
data class JamCell(val index: Int, val column: Int, val row: Int, val columns: Int, val rows: Int)

enum class JamTileSize(val columns: Int, val rows: Int) {
    Small(1, 1),
    Wide(2, 1),
    Hero(2, 2),
}

object JamMosaic {
    /**
     * What a song would like to be, before the grid says what fits: the first
     * (the newest or most active, the list is sorted that way) is the only
     * hero; a song with video or four or more tracks wants a wide tile; a
     * three-track one is wide on alternate places; everything else is small. The
     * mix of sizes keeps a column of identical squares from reading as a
     * settings list, and the grid steps a wide tile down when only one cell is
     * left in its row.
     */
    fun desiredSize(index: Int, song: JamSongSummary, hasVideo: Boolean): JamTileSize = when {
        // A song nobody has recorded on has nothing to show big: it never takes the hero's place or a wide tile.
        song.trackCount == 0 -> JamTileSize.Small
        index == 0 -> JamTileSize.Hero
        hasVideo || song.trackCount >= 4 -> JamTileSize.Wide
        song.trackCount >= 3 && index % 2 == 1 -> JamTileSize.Wide
        else -> JamTileSize.Small
    }

    /**
     * Dense first-fit. Every tile goes in the first free cell in reading order,
     * at the largest size up to what it wants that fits there, so a hole is
     * never left behind a tile that was placed later: 1 x 1 always fits, and the
     * first free cell is always where the next tile goes.
     */
    fun layout(sizes: List<JamTileSize>, columns: Int): List<JamCell> {
        val cols = max(1, columns)
        val occupied = ArrayList<BooleanArray>()

        fun free(row: Int, column: Int) = row >= occupied.size || !occupied[row][column]
        fun fits(row: Int, column: Int, w: Int, h: Int): Boolean {
            if (column + w > cols) return false
            for (r in row until row + h) for (c in column until column + w) if (!free(r, c)) return false
            return true
        }
        fun occupy(row: Int, column: Int, w: Int, h: Int) {
            while (occupied.size < row + h) occupied.add(BooleanArray(cols))
            for (r in row until row + h) for (c in column until column + w) occupied[r][c] = true
        }

        val placements = ArrayList<JamCell>(sizes.size)
        var cursorRow = 0
        sizes.forEachIndexed { index, size ->
            var row = cursorRow
            var column = 0
            search@ while (true) {
                for (c in 0 until cols) {
                    if (free(row, c)) {
                        column = c
                        break@search
                    }
                }
                row += 1
            }
            cursorRow = row
            var w = min(size.columns, cols)
            var h = size.rows
            // Step down until it fits where it is: hero, then wide, then small.
            while (!fits(row, column, w, h)) {
                if (h > 1) {
                    h = 1
                    w = min(2, cols)
                } else if (w > 1) {
                    w = 1
                } else {
                    break
                }
            }
            occupy(row, column, w, h)
            placements += JamCell(index, column, row, w, h)
        }
        return placements
    }

    /** The height of the grid in rows. */
    fun rowCount(placements: List<JamCell>): Int = placements.maxOfOrNull { it.row + it.rows } ?: 0
}

/** One tile of a band: the song and the cell the mosaic gave it. */
data class JamBandTile(val song: JamSongSummary, val cell: JamCell)

/** The tiles that START on one grid row; a hero's band is two rows tall. */
data class JamBand(val row: Int, val rows: Int, val tiles: List<JamBandTile>) {
    /** Stable across a reflow: the first song in the band. */
    val key: String get() = "band-${tiles.first().song.id}"
}

object JamBands {
    /**
     * The mosaic as lazy-list items. With two columns a tile that spans two rows
     * spans both columns too, so nothing can start beside it on its second row
     * and every band is independent: a list item per band, no overlap, no hole.
     */
    fun build(all: List<JamSongSummary>, hasVideo: (JamSongSummary) -> Boolean, columns: Int = 2): List<JamBand> {
        // The hero is the first song that has something on it. Songs nobody has recorded on yet are small and do not
        // count in the rhythm, and they do not push the hero down: one that sits above it in the server's order goes
        // after it, where a hole it would leave beside a small tile cannot swallow the hero's place.
        val firstWithTracks = all.indexOfFirst { it.trackCount > 0 }
        val songs = if (firstWithTracks > 0) listOf(all[firstWithTracks]) + all.filterIndexed { i, _ -> i != firstWithTracks } else all
        var rank = 0
        val sizes = songs.map { song ->
            if (song.trackCount == 0) JamTileSize.Small else JamMosaic.desiredSize(rank++, song, hasVideo(song))
        }
        val cells = JamMosaic.layout(sizes, columns)
        return cells
            .map { JamBandTile(songs[it.index], it) }
            .groupBy { it.cell.row }
            .toSortedMap()
            .map { (row, tiles) -> JamBand(row, tiles.maxOf { it.cell.rows }, tiles.sortedBy { it.cell.column }) }
    }
}

// --- The list a wall holds ---

/**
 * The wall's songs, kept in the order the server sorts them (activity: the
 * newest bump first), and what a live frame does to them. Applying a frame is
 * idempotent by id, because a change reaches the writer's own socket too.
 */
data class JamWallState(
    val songs: List<JamSongSummary> = emptyList(),
    /** Ids that arrived live after the first page, so the tile can say "novo" and animate in. */
    val fresh: Set<String> = emptySet(),
    val nextCursor: String? = null,
) {
    val isEmpty: Boolean get() = songs.isEmpty()

    fun replace(page: JamSongListResponse) = JamWallState(page.songs, emptySet(), page.nextCursor)

    fun append(page: JamSongListResponse): JamWallState {
        val known = songs.mapTo(HashSet()) { it.id }
        return copy(songs = songs + page.songs.filter { it.id !in known }, nextCursor = page.nextCursor)
    }

    fun clearFresh(id: String) = copy(fresh = fresh - id)

    /** Insert or replace one song, then put it where its bump says. A song the list did not hold is fresh. */
    fun upsert(song: JamSongSummary, markFresh: Boolean = true): JamWallState {
        val index = songs.indexOfFirst { it.id == song.id }
        val next = if (index >= 0) songs.toMutableList().also { it[index] = song } else songs + song
        val sorted = next.sortedWith(compareByDescending<JamSongSummary> { it.updatedAtMs }.thenBy { it.id })
        val nextFresh = if (index < 0 && markFresh) fresh + song.id else fresh
        return copy(songs = sorted, fresh = nextFresh)
    }

    fun remove(songId: String) = copy(songs = songs.filter { it.id != songId }, fresh = fresh - songId)

    /** One frame; the same state back when it was not for this channel or changes nothing the wall draws. */
    fun apply(frame: JamFrame, channelId: String): JamWallState {
        if (frame.channelId != channelId) return this
        return when (frame) {
            is JamFrame.SongCreated -> upsert(frame.song)
            is JamFrame.SongUpdated -> upsert(frame.song)
            is JamFrame.TrackAdded -> upsert(frame.song)
            is JamFrame.TrackUpdated -> upsert(frame.song)
            is JamFrame.TrackDeleted -> upsert(frame.song)
            is JamFrame.SongDeleted -> remove(frame.songId)
            // A vote moves a count the wall does not draw.
            is JamFrame.TrackVotes -> this
        }
    }
}

// --- Unread, for a channel with no messages ---

/**
 * A jam channel carries no messages, so the sidebar's ordinary unread cursor
 * does not exist for it. What a person means by "something new in there" is a
 * song, or a track on one, that somebody ELSE made since they last looked. The
 * server has no per-person cursor for that yet (`docs/JAM.md` lists the sidebar
 * dot as not built), so this keeps one on the device: the newest bump seen when
 * the wall was last opened.
 */
object JamUnread {
    fun isUnread(newestBumpMs: Long?, lastSeenMs: Long?, newestBumpIsMine: Boolean): Boolean {
        if (newestBumpMs == null || newestBumpMs <= 0) return false
        // Never opened: new to this person, unless it is only theirs.
        if (lastSeenMs == null) return !newestBumpIsMine
        return newestBumpMs > lastSeenMs && !newestBumpIsMine
    }
}

/** What the channel row shows: the song count and whether there is news. */
data class JamRowSummary(
    /** Songs on the first page. A full page reads "50+": the list has no total, and a made-up one would be a lie. */
    val songCount: Int,
    val hasMore: Boolean,
    val isUnread: Boolean,
) {
    val countText: String get() = if (hasMore) "$songCount+" else "$songCount"

    companion object {
        /**
         * From the first page of a channel's songs. A song counts as the
         * viewer's own news-less bump only when they made it and nothing has
         * touched it since (`updatedAt == createdAt`).
         */
        fun of(page: JamSongListResponse, viewerId: String?, lastSeenMs: Long?): JamRowSummary {
            // Any song on the page can be the news, not only the newest: the viewer's own untouched song at the
            // top must not hide somebody else's bump just under it.
            val unread = page.songs.any { song ->
                val mine = viewerId != null && song.authorId == viewerId && song.updatedAt == song.createdAt
                JamUnread.isUnread(song.updatedAtMs, lastSeenMs, mine)
            }
            return JamRowSummary(
                songCount = page.songs.size,
                hasMore = page.nextCursor != null,
                isUnread = unread,
            )
        }
    }
}

// --- Peaks ---

object JamPeaks {
    /**
     * [bars] values in 0..1 across the SONG's mix, for a tile's waveform. Each
     * in-mix track contributes its own envelope where it plays (peaks cover the
     * whole recording, trims and offset are applied here), and the louder one
     * wins, so a song reads as the loudest thing anyone does.
     */
    fun mixEnvelope(tracks: List<JamTrack>, bars: Int): List<Double> {
        if (bars <= 0) return emptyList()
        val active = tracks.filter { it.inMix && it.peaks.isNotEmpty() && it.playedMs > 0 }
        if (active.isEmpty()) return List(bars) { 0.0 }
        val start = active.minOf { it.startMs }
        val end = active.maxOf { it.endMs }
        val span = max(1.0, end - start)
        return List(bars) { i ->
            val t = start + (i + 0.5) / bars * span
            active.fold(0.0) { loudest, track -> max(loudest, track.peakAt(t)) }
        }
    }

    /** [bars] values across one track's PLAYED slice, for its own row. */
    fun trackBars(track: JamTrack, bars: Int): List<Double> {
        if (bars <= 0) return emptyList()
        return List(bars) { i -> track.peakAt(track.startMs + (i + 0.5) / bars * track.playedMs) }
    }
}
