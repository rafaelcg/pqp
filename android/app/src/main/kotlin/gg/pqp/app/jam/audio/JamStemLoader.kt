package gg.pqp.app.jam.audio

import android.content.Context
import android.util.Log
import gg.pqp.app.jam.JamTrack
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * One stem from its presigned URL to PCM the mixer can read: download, decode,
 * resample (`JamDecoder`), all in the app's cache directory, all off the main
 * thread, two decodes at a time (a 10-minute FLAC is real work and a phone has
 * to stay cool).
 *
 * A stem the platform cannot decode is a [Result.Unplayable], not an exception:
 * the song screen shows that one row as "can't play this one" and the rest of
 * the mix keeps playing.
 *
 * Results are cached for the life of the loader and the work is shared: two
 * callers asking for one track wait on one decode, and a caller that goes away
 * (a screen closed) cancels only its own wait.
 */
class JamStemLoader(
    context: Context,
    private val http: OkHttpClient,
) {
    sealed interface Result {
        class Ready(val pcm: PcmSource, val frames: Long, val mime: String) : Result
        class Unplayable(val reason: String) : Result
    }

    private val dir = File(context.cacheDir, "jam").also { it.mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val decodes = Semaphore(2)
    private val inflight = HashMap<String, Deferred<Result>>()
    private val done = HashMap<String, Result>()

    init {
        pruneOld()
    }

    suspend fun load(track: JamTrack): Result {
        val key = "${track.id}-${track.audioBytes}"
        val job = synchronized(this) {
            done[key]?.let { return it }
            inflight.getOrPut(key) {
                scope.async {
                    val result = decodes.withPermit { fetchAndDecode(track, key) }
                    synchronized(this@JamStemLoader) {
                        done[key] = result
                        inflight.remove(key)
                    }
                    result
                }
            }
        }
        return job.await()
    }

    private suspend fun fetchAndDecode(track: JamTrack, key: String): Result = withContext(Dispatchers.IO) {
        val source = File(dir, "$key.src")
        val pcm = File(dir, "$key.pcm")
        try {
            if (!pcm.isFile || pcm.length() < 2) {
                if (!(source.isFile && source.length() > 0)) download(track.audioUrl, source)
                JamDecoder.decode(source, pcm) { !isActive }
            }
            val mapped = MappedPcm(pcm)
            if (mapped.frames <= 0) {
                mapped.close()
                pcm.delete()
                return@withContext Result.Unplayable("empty")
            }
            // The compressed original is no longer needed once there is PCM.
            source.delete()
            Result.Ready(mapped, mapped.frames, track.audioContentType)
        } catch (e: JamDecoder.UnplayableStem) {
            Log.w(TAG, "stem ${track.id} (${track.audioContentType}) is unplayable: ${e.message}")
            source.delete()
            Result.Unplayable(e.message ?: "unplayable")
        } catch (e: java.io.IOException) {
            Log.w(TAG, "stem ${track.id} did not download: ${e.message}")
            Result.Unplayable(e.message ?: "download failed")
        }
    }

    private suspend fun download(url: String, to: File) {
        val absolute = gg.pqp.app.core.Backend.absolute(url) ?: throw java.io.IOException("no url")
        val call = http.newCall(Request.Builder().url(absolute).get().build())
        val handle = currentCoroutineContext()[Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        val partial = File(to.parentFile, to.name + ".part")
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw java.io.IOException("HTTP ${response.code}")
                partial.outputStream().use { out ->
                    val body = response.body.byteStream()
                    val buffer = ByteArray(1 shl 16)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = body.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                    }
                }
            }
            if (!partial.renameTo(to)) throw java.io.IOException("could not store the download")
        } finally {
            handle?.dispose()
            partial.delete()
        }
    }

    /** Stops the work and releases every mapped file. Call when the song screen is gone. */
    fun close() {
        scope.cancel()
        synchronized(this) {
            done.values.filterIsInstance<Result.Ready>().forEach { it.pcm.close() }
            done.clear()
            inflight.clear()
        }
        dir.listFiles()?.forEach { if (it.name.endsWith(".pcm") || it.name.endsWith(".raw") || it.name.endsWith(".part")) it.delete() }
    }

    /** Anything a crashed session left behind is gone after a few hours. */
    private fun pruneOld() {
        val cutoff = System.currentTimeMillis() - 3 * 60 * 60 * 1000
        dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    private companion object {
        const val TAG = "pqp.jam"
    }
}
