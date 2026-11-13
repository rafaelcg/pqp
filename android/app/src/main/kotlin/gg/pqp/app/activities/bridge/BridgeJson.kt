package gg.pqp.app.activities.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The small JSON helpers the bridge needs: the RFC 7396 merge patch the state
 * is written with, the size and shape rules a value crossing the bridge must
 * meet (`jsonProblem` and `jsonByteLength` in `packages/shared/src/apps/common.ts`),
 * and the token bucket every limit is built on. All pure, all JVM-testable.
 */

/** Deepest nesting of a JSON value that crosses the bridge or a frame (`APP_JSON_MAX_DEPTH`). */
const val JSON_MAX_DEPTH = 32

/**
 * RFC 7396. A non-object patch replaces the target; an object patch merges key
 * by key and a `null` value deletes the key.
 */
fun applyMergePatch(target: JsonElement?, patch: JsonElement): JsonElement {
    if (patch !is JsonObject) return patch
    val out = LinkedHashMap<String, JsonElement>()
    if (target is JsonObject) out.putAll(target)
    for ((key, value) in patch) {
        if (value is JsonNull) {
            out.remove(key)
        } else {
            out[key] = applyMergePatch(out[key], value)
        }
    }
    return JsonObject(out)
}

/** Serialized size in UTF-8 bytes of the compact JSON. */
fun jsonByteLength(value: JsonElement): Int = value.toString().toByteArray(Charsets.UTF_8).size

/** What the state would weigh, in compact UTF-8 bytes, after [patch]. */
fun stateBytesAfter(current: JsonElement, patch: JsonElement): Int = jsonByteLength(applyMergePatch(current, patch))

/**
 * Why a value is not acceptable across the bridge, or null when it is: nesting
 * past [JSON_MAX_DEPTH], or a string holding U+0000 (the server's jsonb cannot
 * store one, and it refuses it there, so the phone says so first). Numbers are
 * finite by construction: the parser has no literal for NaN or Infinity.
 */
fun jsonProblem(value: JsonElement, depth: Int = 0): String? {
    if (value is JsonPrimitive) {
        return if (value.isString && value.content.indexOf('\u0000') >= 0) "a string holds U+0000" else null
    }
    if (depth >= JSON_MAX_DEPTH) return "nesting is deeper than $JSON_MAX_DEPTH"
    if (value is JsonArray) {
        for (element in value) jsonProblem(element, depth + 1)?.let { return it }
        return null
    }
    if (value is JsonObject) {
        for ((key, element) in value) {
            if (key.indexOf('\u0000') >= 0) return "a key holds U+0000"
            jsonProblem(element, depth + 1)?.let { return it }
        }
    }
    return null
}

/**
 * A token bucket, [ratePerSecond] refilled continuously up to [burst]. A rate
 * of 0 refuses everything (`events.maxPerSecond = 0` is an app that sends none).
 */
class TokenBucket(
    private val ratePerSecond: Double,
    private val burst: Int,
    private val now: () -> Long,
) {
    private var tokens: Double = burst.toDouble()
    private var last: Long = now()

    @Synchronized
    fun take(): Boolean {
        val t = now()
        tokens = minOf(burst.toDouble(), tokens + (t - last) / 1000.0 * ratePerSecond)
        last = t
        if (tokens < 1.0) return false
        tokens -= 1.0
        return true
    }
}
