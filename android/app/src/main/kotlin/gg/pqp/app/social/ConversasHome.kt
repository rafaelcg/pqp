package gg.pqp.app.social

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Conversas switches and the phone's last tab, for the whole process.
 *
 * `GET /api/dms/config` answers two runtime flags the operator flips without a
 * deploy. The last answer is kept on the device, so a cold start draws the
 * layout the flags asked for last time instead of drawing today's and
 * swapping it a second later. The fresh answer then wins.
 *
 * The last tab is a per-device convenience (the web keeps it in
 * `localStorage`): losing it costs one tap, so it lives in plain
 * SharedPreferences and nothing depends on it.
 */
class ConversasHome internal constructor(private val prefs: SharedPreferences) {

    private val _config = MutableStateFlow(
        normalized(DmsConfig(prefs.getBoolean(KEY_HOME, false), prefs.getBoolean(KEY_TABS, false))),
    )
    val config: StateFlow<DmsConfig> = _config.asStateFlow()

    private var fetchedAt = 0L

    /**
     * Ask the server again, at most every few minutes. A refusal that is not a
     * 404 (no network, a 500) keeps what is on screen: flipping the layout back
     * because a tunnel ate one request would be worse than a stale flag.
     */
    suspend fun refresh(api: ApiClient, force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && fetchedAt != 0L && now - fetchedAt < REFRESH_MS) return
        val next = fetch(api) ?: return
        fetchedAt = now
        apply(next)
    }

    internal fun apply(next: DmsConfig) {
        val value = normalized(next)
        _config.value = value
        prefs.edit()
            .putBoolean(KEY_HOME, value.home)
            .putBoolean(KEY_TABS, value.phoneTabs)
            .apply()
    }

    fun landingTab(): PhoneTab = ConversationList.landingTab(prefs.getString(KEY_TAB, null))

    fun rememberTab(tab: PhoneTab) {
        prefs.edit().putString(KEY_TAB, tab.name).apply()
    }

    companion object {
        private const val PREFS = "pqp.conversas"
        private const val KEY_HOME = "home"
        private const val KEY_TABS = "phoneTabs"
        private const val KEY_TAB = "lastTab"
        private const val REFRESH_MS = 5 * 60_000L

        /** `phoneTabs` without `home` is not a state the server sends; never draw it. */
        internal fun normalized(config: DmsConfig): DmsConfig =
            if (config.home) config else DmsConfig()

        /**
         * The answer, or null when there is none to act on. A 404 is an answer
         * (a server that predates the route: off); anything else is not.
         */
        internal suspend fun fetch(api: ApiClient): DmsConfig? = try {
            api.dmsConfig()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: ApiException) {
            if (failure.status == 404) DmsConfig() else null
        } catch (_: Exception) {
            null
        }

        @Volatile
        private var instance: ConversasHome? = null

        fun of(context: Context): ConversasHome =
            instance ?: synchronized(this) {
                instance ?: ConversasHome(
                    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
                ).also { instance = it }
            }
    }
}
