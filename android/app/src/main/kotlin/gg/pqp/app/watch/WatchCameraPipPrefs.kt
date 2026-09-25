package gg.pqp.app.watch

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retry
import java.io.IOException

private val Context.watchCameraPipDataStore by preferencesDataStore(name = "watch_camera_pip")

private val CORNER_KEY = stringPreferencesKey("corner")
private val LAYOUT_KEY = stringPreferencesKey("layout")

/**
 * Where [CameraPipPref] lives between watches.
 *
 * One phone, one preference: a whole-party choice remembered per device, the
 * same way web keeps one `localStorage` entry (`pqp:watch-camera-pip`)
 * rather than one per channel. Built from the application context so it
 * outlives any one `WatchPane` composition.
 *
 * A PER-VIEWER CONVENIENCE, NOT STATE ANYTHING DEPENDS ON — same rule web's
 * own `readCameraPipPref`/`writeCameraPipPref` state about `localStorage`,
 * and for the same reason here: a corrupted store, a full disk, or any other
 * `IOException` DataStore can throw must lose the remembered corner, never
 * the watch party itself. Writes are fire-and-forget from the caller's own
 * `rememberCoroutineScope`, so a failure there is swallowed here rather than
 * left to crash whatever launched the coroutine.
 *
 * READS RETRY BEFORE THEY GIVE UP. [Flow.catch] only intercepts the
 * exception that ends the upstream flow; simply emitting a fallback value
 * from inside it does not resume collecting `.data`, it ends this flow too,
 * one emission after the fallback. A collector (`WatchPane`'s
 * `collectAsState`) would then never learn about a later, successful write
 * for the rest of that composition — a transient hiccup (a momentary lock,
 * a slow disk) would look identical to a permanently broken store. [retry]
 * re-subscribes to `.data` itself, which is what actually recovers from a
 * transient failure; only once retries are exhausted does [catch] fall back
 * to the default and let the flow end.
 */
class WatchCameraPipPrefsStore(private val context: Context) {

    val pref: Flow<CameraPipPref> = context.watchCameraPipDataStore.data
        .retry(retries = 3) { error -> error is IOException }
        .catch { error ->
            if (error is IOException) emit(emptyPreferences()) else throw error
        }
        .map { prefs -> decodeCameraPipPref(prefs[CORNER_KEY], prefs[LAYOUT_KEY]) }

    suspend fun setCorner(corner: CameraPipCorner) {
        runCatching { context.watchCameraPipDataStore.edit { it[CORNER_KEY] = corner.name } }
    }

    suspend fun setLayout(layout: WatchCameraLayout) {
        runCatching { context.watchCameraPipDataStore.edit { it[LAYOUT_KEY] = layout.name } }
    }
}

/**
 * A stored corner/layout pair, read defensively.
 *
 * A value this build does not recognise — an older enum member, a store a
 * future version wrote something new into, anything corrupted — reads as
 * [CameraPipPref.DEFAULT]'s half rather than throwing and losing the whole
 * preference. Pure, so the interesting (malformed) cases are unit-tested
 * with no `Context` and no DataStore.
 */
fun decodeCameraPipPref(corner: String?, layout: String?): CameraPipPref {
    val resolvedCorner = corner
        ?.let { runCatching { CameraPipCorner.valueOf(it) }.getOrNull() }
        ?: CameraPipPref.DEFAULT.corner
    val resolvedLayout = layout
        ?.let { runCatching { WatchCameraLayout.valueOf(it) }.getOrNull() }
        ?: CameraPipPref.DEFAULT.layout
    return CameraPipPref(resolvedCorner, resolvedLayout)
}
