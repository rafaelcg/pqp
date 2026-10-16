package gg.pqp.app.stories

import android.os.SystemClock
import android.util.Log
import gg.pqp.app.BuildConfig
import java.util.concurrent.ConcurrentHashMap

/**
 * Stopwatch marks for the three numbers that decide whether Stories feel fast:
 * Post tap to composer closed, Post tap to live, and tap-next to first frame.
 *
 * Debug builds only: a release build never reads the clock or writes a line, so
 * this is a measuring aid for whoever throttles an emulator, not telemetry.
 * Read it with `adb logcat -s pqp.perf`.
 */
object StoryPerf {
    private const val TAG = "pqp.perf"
    private val marks = ConcurrentHashMap<String, Long>()

    fun mark(name: String) {
        if (BuildConfig.DEBUG) marks[name] = SystemClock.elapsedRealtime()
    }

    /** Logs how long ago [name] was marked, under [event]. [clear] makes it once per mark. */
    fun since(name: String, event: String, clear: Boolean = true) {
        if (!BuildConfig.DEBUG) return
        val at = (if (clear) marks.remove(name) else marks[name]) ?: return
        Log.i(TAG, "$event=${SystemClock.elapsedRealtime() - at}ms")
    }

    private val readyAt = ConcurrentHashMap<String, Long>()
    private val currentAt = ConcurrentHashMap<String, Long>()

    /** A story's first frame is on screen (a picture decoded, or a clip's first frame rendered). */
    fun frameReady(storyId: String, kind: String) {
        if (!BuildConfig.DEBUG) return
        val now = SystemClock.elapsedRealtime()
        readyAt.putIfAbsent(storyId, now)
        currentAt.remove(storyId)?.let { Log.i(TAG, "tap_to_first_frame_$kind story=${storyId.take(6)}=${now - it}ms") }
    }

    /**
     * A story became the one on screen. If its first frame is already there (preloaded, or composed
     * beside the current page) the answer is zero; otherwise [frameReady] says how long the wait was.
     */
    fun becameCurrent(storyId: String) {
        if (!BuildConfig.DEBUG) return
        if (readyAt.containsKey(storyId)) {
            Log.i(TAG, "tap_to_first_frame story=${storyId.take(6)}=0ms (ready before the tap)")
        } else {
            currentAt[storyId] = SystemClock.elapsedRealtime()
        }
    }

    /**
     * Debug builds only: a pause per 16 KB chunk of an upload when `files/slow-upload` holds a number of
     * milliseconds. An emulator acknowledges a socket far faster than any link behind it, so the ring
     * would jump to its cap; this paces the writes so the ring can be watched filling.
     */
    fun uploadPaceMs(filesDir: java.io.File): Long {
        if (!BuildConfig.DEBUG) return 0L
        return runCatching { java.io.File(filesDir, "slow-upload").readText().trim().toLong() }.getOrDefault(0L)
    }

    /** Between measured runs. */
    fun reset() {
        readyAt.clear()
        currentAt.clear()
    }

    /**
     * Debug builds only: whether the preloader is switched off by a marker file
     * (`adb shell run-as gg.pqp.app.debug touch files/no-preload`), so a
     * before and after can be measured on one build.
     */
    fun preloadOff(filesDir: java.io.File): Boolean = BuildConfig.DEBUG && java.io.File(filesDir, "no-preload").exists()
}
