package gg.pqp.app.jam.record

import android.content.Context
import gg.pqp.app.core.PqpJson
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** The two calls the store needs from preferences, so a JVM test can hold them in a map. */
interface KeyValue {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

class PrefsKeyValue(context: Context) : KeyValue {
    private val prefs = context.applicationContext.getSharedPreferences("pqp.jam", Context.MODE_PRIVATE)
    override fun get(key: String): String? = runCatching { prefs.getString(key, null) }.getOrNull()
    override fun put(key: String, value: String) {
        runCatching { prefs.edit().putString(key, value).apply() }
    }

    override fun remove(key: String) {
        runCatching { prefs.edit().remove(key).apply() }
    }
}

/**
 * Calibrations per audio route, a per-device convenience. Every access is
 * guarded because preferences can fail and losing a calibration costs a re-run
 * of a seven second measurement, never a take.
 */
class JamLatencyStore(private val kv: KeyValue) {
    private val serializer = MapSerializer(String.serializer(), ListSerializer(LatencyResult.serializer()))

    private fun readAll(): Map<String, List<LatencyResult>> =
        runCatching { kv.get(KEY)?.let { PqpJson.decodeFromString(serializer, it) } }.getOrNull().orEmpty()

    fun get(routeKey: String): List<LatencyResult> = readAll()[routeKey].orEmpty()

    /** The newest result per method is kept for a route, so a failed re-measure never replaces a good one. */
    fun save(routeKey: String, result: LatencyResult) {
        if (!result.usable) return
        val all = readAll().toMutableMap()
        all[routeKey] = all[routeKey].orEmpty().filter { it.method != result.method } + result
        runCatching { kv.put(KEY, PqpJson.encodeToString(serializer, all)) }
    }

    fun clear(routeKey: String) {
        val all = readAll().toMutableMap()
        all.remove(routeKey)
        runCatching { kv.put(KEY, PqpJson.encodeToString(serializer, all)) }
    }

    private companion object {
        const val KEY = "latency.v1"
    }
}
