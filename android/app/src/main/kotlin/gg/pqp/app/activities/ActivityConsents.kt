package gg.pqp.app.activities

import android.content.Context
import gg.pqp.app.core.ApiClient
import kotlinx.coroutines.CancellationException

/**
 * What this person accepted, per app (`GET /api/me/app-consents`, `consents.ts`
 * on the web). The join sheet shows the first time per app per person; after
 * that Entrar goes straight in. "After that" is read from here: a consent on
 * file that is not STALE (a newer version of the app asking for something
 * different) skips the sheet. Whatever cannot be read, the list has not landed
 * or the request failed, is "not accepted": asking twice is the safe way to be
 * wrong.
 */
class ActivityConsents(
    private val read: suspend () -> List<ActivityConsent>,
    private val write: suspend (appId: String, identityGranted: Boolean) -> Unit,
) {
    @Volatile
    private var cached: List<ActivityConsent>? = null

    /** The list, read once and kept; a failed read keeps what was there and reports it as null. */
    suspend fun load(force: Boolean = false): List<ActivityConsent>? {
        if (!force) cached?.let { return it }
        return try {
            read().also { cached = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            cached
        }
    }

    /** Whether [appId] has an acceptance on file that still covers what the app asks. */
    suspend fun accepted(appId: String): Boolean = hasValid(load(), appId)

    /** Records the acceptance; throws when the server did not take it. */
    suspend fun accept(appId: String, identityGranted: Boolean) {
        write(appId, identityGranted)
        load(force = true)
    }

    companion object {
        fun hasValid(consents: List<ActivityConsent>?, appId: String): Boolean =
            consents?.any { it.appId == appId && !it.stale } == true

        /** Whether the join sheet adds "keeps things on this device": the manifest declares a device store. */
        fun keepsOnDevice(app: ActivityApp?): Boolean = app?.capabilities?.deviceStore?.allowed == true

        /** Whether the sheet offers the id box: the manifest asks for the per-app id. */
        fun asksForId(app: ActivityApp?): Boolean = app?.capabilities?.identity == "user-id"

        fun of(api: ApiClient): ActivityConsents = ActivityConsents(
            read = { api.activityConsents() },
            write = { appId, identity -> api.acceptActivity(appId, identity) },
        )
    }
}

/**
 * The first-run hint's "seen" flag: a per-device convenience (losing it costs
 * one card), plain preferences with every access guarded.
 */
class ActivitiesHintStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("pqp.activities", Context.MODE_PRIVATE)

    fun seen(): Boolean = runCatching { prefs.getBoolean(KEY, false) }.getOrDefault(false)

    fun markSeen() {
        runCatching { prefs.edit().putBoolean(KEY, true).apply() }
    }

    private companion object {
        const val KEY = "hint.seen"
    }
}
