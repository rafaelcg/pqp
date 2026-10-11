package gg.pqp.app.ui.screens.channels

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import gg.pqp.app.core.ApiClient
import gg.pqp.app.social.getJson
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retry

/**
 * Unread counts for every channel of a server this account can see, the
 * route the web sidebar and the iOS list already read.
 */
suspend fun ApiClient.serverUnread(serverId: String): Map<String, ChannelUnread> =
    getJson<ServerUnreadResponse>("/api/servers/$serverId/unread")
        .unread
        .associateBy { it.channelId }

/**
 * The channels this person silenced, read fresh from `GET /api/me` when a
 * server is opened: a channel muted on the web a minute ago should be dimmed
 * here without relaunching the app. Empty on any failure, which draws every
 * row at full strength, the same as before this existed.
 */
suspend fun ApiClient.mutedChannels(): Set<String> =
    mutedChannelIds(me().preferences?.notifications?.channels)

private val Context.channelListDataStore by preferencesDataStore(name = "channel_list")

/**
 * Which categories this person folded, per server, on this device.
 *
 * Device-local on purpose: folding is how somebody arranges their own screen,
 * and a phone and a desktop have different amounts of room for the same list.
 */
class FoldedCategoriesStore(private val context: Context) {

    private fun key(serverId: String) = stringSetPreferencesKey("folded:$serverId")

    fun folded(serverId: String): Flow<Set<String>> = context.channelListDataStore.data
        .retry(retries = 3) { error -> error is IOException }
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> prefs[key(serverId)].orEmpty() }

    suspend fun setFolded(serverId: String, categoryId: String, folded: Boolean) {
        runCatching {
            context.channelListDataStore.edit { prefs ->
                val current = prefs[key(serverId)].orEmpty()
                prefs[key(serverId)] = if (folded) current + categoryId else current - categoryId
            }
        }
    }
}
