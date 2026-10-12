package gg.pqp.app.forum

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Per-forum conveniences kept on this phone: the filters the reader left on
 * (UX §2.2 #11, "filters and sort persist per forum") and the composer's draft
 * (#36, "drafts save automatically per forum"). Neither is shared or synced:
 * they are this reader's, on this device, like the web keeps them in
 * `localStorage`.
 *
 * A miss or a malformed value reads as "nothing saved"; nothing here may stop
 * a forum from opening.
 *
 * Drafts and pending nonces are keyed by account as well as forum (the
 * composer passes `<userId>.<forumId>`): unpublished words must not open in
 * somebody else's composer after a sign-out on a shared phone. Nothing in this
 * file reaches a backup: `sharedpref` is excluded in both backup rule files.
 */
class ForumPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("forum", Context.MODE_PRIVATE)

    /** Null when the reader never chose anything here. */
    fun filters(forumId: String): SavedForumFilters? {
        val raw = prefs.getString("filters.$forumId", null) ?: return null
        return decodeFilters(raw)
    }

    fun saveFilters(forumId: String, saved: SavedForumFilters) {
        prefs.edit { putString("filters.$forumId", encodeFilters(saved)) }
    }

    fun draft(forumId: String): ForumDraft? =
        prefs.getString("draft.$forumId", null)?.let(::decodeDraft)?.takeUnless { it.isEmpty }

    fun saveDraft(forumId: String, draft: ForumDraft) {
        if (draft.isEmpty) {
            clearDraft(forumId)
        } else {
            prefs.edit { putString("draft.$forumId", encodeDraft(draft)) }
        }
    }

    fun clearDraft(forumId: String) {
        prefs.edit { remove("draft.$forumId") }
    }

    /**
     * The nonce of a create that left without an answer (the composer was
     * closed mid-request). Kept with the draft so the retry is the SAME post
     * to the server, which answers a known nonce with the post it already
     * made instead of a second one.
     */
    fun pendingNonce(key: String): String? = prefs.getString("nonce.$key", null)

    fun savePendingNonce(key: String, nonce: String) {
        prefs.edit { putString("nonce.$key", nonce) }
    }

    fun clearPendingNonce(key: String) {
        prefs.edit { remove("nonce.$key") }
    }

    companion object {
        private const val SEP = '\u001F'

        /**
         * Sort, status, mine and tags; never the search, which is a question
         * of the moment and not a setting.
         */
        /** An empty sort is "the forum's default", which staff can change later. */
        internal fun encodeFilters(saved: SavedForumFilters): String = listOf(
            if (saved.sortExplicit) saved.filters.sort.wire else "",
            saved.filters.status?.wire.orEmpty(),
            if (saved.filters.mine) "1" else "",
            saved.filters.tagIds.joinToString(","),
        ).joinToString(SEP.toString())

        internal fun decodeFilters(raw: String): SavedForumFilters? {
            val parts = raw.split(SEP)
            if (parts.size != 4) return null
            val sort = ForumSort.fromWire(parts[0])
            return SavedForumFilters(
                filters = ForumFilters(
                    sort = sort ?: ForumSort.Activity,
                    status = ForumStatus.fromWire(parts[1]),
                    mine = parts[2] == "1",
                    tagIds = parts[3].split(',').filter { it.isNotBlank() }.take(ForumLimits.MAX_TAGS_PER_POST),
                ),
                sortExplicit = sort != null,
            )
        }

        internal fun encodeDraft(draft: ForumDraft): String = listOf(
            draft.title,
            draft.tagIds.joinToString(","),
            draft.body,
        ).joinToString(SEP.toString())

        internal fun decodeDraft(raw: String): ForumDraft? {
            val parts = raw.split(SEP, limit = 3)
            if (parts.size != 3) return null
            return ForumDraft(
                title = parts[0],
                tagIds = parts[1].split(',').filter { it.isNotBlank() },
                body = parts[2],
            )
        }
    }
}

/** The filters, and whether the sort was the reader's choice or the forum's default. */
data class SavedForumFilters(val filters: ForumFilters, val sortExplicit: Boolean)

/** What the composer keeps between visits. Attachments are not kept: their upload rows expire. */
data class ForumDraft(
    val title: String = "",
    val body: String = "",
    val tagIds: List<String> = emptyList(),
) {
    val isEmpty: Boolean get() = title.isBlank() && body.isBlank() && tagIds.isEmpty()
}
