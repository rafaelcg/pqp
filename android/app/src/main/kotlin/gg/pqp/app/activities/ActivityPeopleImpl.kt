package gg.pqp.app.activities

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import gg.pqp.app.activities.bridge.ActivityPeople
import gg.pqp.app.core.Backend
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.net.URI

/**
 * Who a seat is, for an app: a name and a small avatar as a data URL
 * ([ActivityPeople]; `AvatarCache` and `cleanDisplayName` on the web).
 *
 * The avatar goes to the app as bytes the PHONE fetched, never as a link the
 * app could load (its frame has no network), and from a place the phone
 * trusts: a person can set their avatar URL to anything, so only the API's own
 * origin is fetched, and only the API's avatar route may redirect (it answers
 * 302 to the uploaded object in our bucket). Every other URL is not fetched and
 * the app draws its own fallback. The picture is shrunk to a small square
 * before it is encoded, so a roster of many people stays small.
 */
class StoreActivityPeople(
    private val store: ActivitiesStore,
    private val serverId: String,
    private val http: OkHttpClient,
) : ActivityPeople {
    private val noRedirects: OkHttpClient by lazy { http.newBuilder().followRedirects(false).followSslRedirects(false).build() }

    override suspend fun describe(userId: String): ActivityPeople.Person? {
        val member = store.resolveMember(serverId, userId) ?: return null
        val name = ActivityRules.nameOf(member) ?: return null
        return ActivityPeople.Person(name, avatarDataUrl(member.avatarUrl))
    }

    private suspend fun avatarDataUrl(raw: String?): String? {
        val url = Backend.absolute(raw) ?: return null
        cache.get(url)?.let { return it.takeUnless { v -> v == MISSING } }
        val result = withContext(Dispatchers.IO) { fetch(url) }
        cache.put(url, result ?: MISSING)
        return result
    }

    private fun fetch(url: String): String? = runCatching {
        val viaApi = sameOrigin(url, Backend.apiUrl)
        if (!viaApi) return null
        val isAvatarRoute = runCatching { URI(url).path.startsWith("/api/avatars/") }.getOrDefault(false)
        val client = if (isAvatarRoute) http else noRedirects
        client.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body
            if (body.contentLength() > MAX_FETCH_BYTES) return null
            val bytes = body.source().readByteArray(MAX_FETCH_BYTES + 1)
            if (bytes.size > MAX_FETCH_BYTES) return null
            encode(bytes)
        }
    }.getOrNull()

    private fun encode(bytes: ByteArray): String? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        // Sized by the LARGER side, so a very wide strip of a picture cannot decode at full size.
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= TARGET_PX) sample *= 2
        // and whatever it still weighs once sampled is bounded in pixels, not only in compressed bytes
        if ((bounds.outWidth / sample).toLong() * (bounds.outHeight / sample) > MAX_DECODED_PIXELS) return null
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val scaled = Bitmap.createScaledBitmap(decoded, TARGET_PX, TARGET_PX, true)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
        if (scaled !== decoded) decoded.recycle()
        scaled.recycle()
        val text = "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        return text.takeIf { it.length <= MAX_DATA_URL_CHARS }
    }

    private companion object {
        const val TARGET_PX = 96
        const val MAX_FETCH_BYTES = 2L * 1024 * 1024
        const val MAX_DECODED_PIXELS = 1_000_000L
        const val MAX_DATA_URL_CHARS = 60_000
        const val MISSING = ""
        val cache = LruCache<String, String>(64)

        fun sameOrigin(url: String, origin: String): Boolean = runCatching {
            val a = URI(url)
            val b = URI(origin)
            a.scheme.equals(b.scheme, true) && a.host.equals(b.host, true) && port(a) == port(b)
        }.getOrDefault(false)

        fun port(u: URI): Int = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80
    }
}
