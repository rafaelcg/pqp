package gg.pqp.app.protocol

import gg.pqp.app.core.Attachment
import gg.pqp.app.ui.media.GifLinks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app is willing to draw, against what the server is willing to store.
 *
 * Read `RepoSources` first. Both facts pinned here are hand-copied from
 * `packages/shared`, and both fail silently when they drift:
 *
 *  - A MIME type added to the upload allowlist that Android does not classify
 *    is not a crash, it is an attachment that quietly renders as a download
 *    chip forever. That is how `video/mp4` reached a shipped build with no
 *    player behind it.
 *  - A **host** added to the GIF allowlist that Android does not know is a GIF
 *    that animates on the web and reads as a URL on the phone. A host *removed*
 *    from it and left here is worse: it is this client drawing a picture from a
 *    host the rest of the product has decided not to trust.
 */
class MediaContractTest {

    private val gifs = "packages/shared/src/gifs.ts"
    private val attachments = "packages/shared/src/attachments.ts"

    private fun attachment(contentType: String) = Attachment(
        id = "att_1",
        filename = "file",
        contentType = contentType,
        url = "https://storage.example/file",
    )

    /** Every entry of `ATTACHMENT_MIME_ALLOWLIST`, in source order. */
    private fun allowlist(): List<String> {
        val block = Regex(
            """ATTACHMENT_MIME_ALLOWLIST\s*=\s*\[(.*?)]""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(RepoSources.read(attachments))?.groupValues?.get(1)
            ?: error("No ATTACHMENT_MIME_ALLOWLIST in $attachments")
        return Regex(""""([^"]+)"""").findAll(block).map { it.groupValues[1] }.toList()
    }

    /** Every entry of `INLINE_IMAGE_CONTENT_TYPES`, in source order. */
    private fun inlineImages(): List<String> {
        val block = Regex(
            """INLINE_IMAGE_CONTENT_TYPES[^=]*=\s*\[(.*?)]""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(RepoSources.read(attachments))?.groupValues?.get(1)
            ?: error("No INLINE_IMAGE_CONTENT_TYPES in $attachments")
        return Regex(""""([^"]+)"""").findAll(block).map { it.groupValues[1] }.toList()
    }

    @Test
    fun `the parser still finds the two lists it reasons about`() {
        // A guard on the regexes, not on the contract. Without it every
        // assertion below would pass vacuously the day shared is reformatted.
        assertTrue(
            "Parsed no MIME types out of $attachments",
            allowlist().size > 5,
        )
        assertTrue(
            "Parsed no inline image types out of $attachments",
            inlineImages().size > 2,
        )
    }

    @Test
    fun `every uploadable type lands in exactly one branch of the renderer`() {
        // `MessageAttachment` switches on isVideo, then isImage, then falls
        // through to the chip. Two predicates that are both true would make
        // the order of that `when` load-bearing by accident.
        val overlapping = allowlist().filter { type ->
            val row = attachment(type)
            row.isVideo && row.isImage
        }
        assertEquals(
            "These types answer to both predicates, so which renderer they get " +
                "depends on the order of a `when` rather than on a decision.",
            emptyList<String>(),
            overlapping,
        )
    }

    @Test
    fun `Android agrees with shared about which types render inline as images`() {
        val expected = inlineImages().toSet()
        val actual = allowlist().filter { attachment(it).isImage }.toSet()
        assertEquals(
            "Android's `Attachment.isImage` is a `image/` prefix test and shared's " +
                "`isImageContentType` is a list. They currently agree across the " +
                "whole allowlist; when they stop, the prefix test is the one that " +
                "is wrong, because it would hand Coil a format nothing decodes.",
            expected,
            actual,
        )
    }

    @Test
    fun `every video type the server signs an upload for gets the player`() {
        val videos = allowlist().filter { it.startsWith("video/") }
        assertTrue("Shared no longer allows any video upload at all", videos.isNotEmpty())
        videos.forEach { type ->
            assertTrue(
                "$type is uploadable and would render as a download chip, which is " +
                    "exactly the state this module was in before ui/media existed.",
                attachment(type).isVideo,
            )
        }
    }

    @Test
    fun `audio is deliberately still a chip`() {
        // Not an oversight, and worth pinning so it is not read as one. The web
        // renders an `<audio>` element with `preload="none"`; Android has no
        // audio player yet, and a chip that downloads is an honest stop rather
        // than a half-built one. See docs/ANDROID.md.
        allowlist().filter { it.startsWith("audio/") }.forEach { type ->
            val row = attachment(type)
            assertFalse("$type now claims to be video", row.isVideo)
            assertFalse("$type now claims to be an image", row.isImage)
        }
    }

    /**
     * The regression this whole change exists to undo.
     *
     * Nothing about a missing decoder fails: Coil answers a GIF with its first
     * frame and no warning, so the app looked correct in every screenshot ever
     * taken of it and was wrong on every phone. A source assertion is the only
     * place that can notice, because there is no runtime behaviour to assert
     * on that does not need an animated file and a device to draw it.
     */
    @Test
    fun `the image loader still registers an animated decoder`() {
        val application = RepoSources.androidSources["PqpApplication.kt"]
            ?: error("PqpApplication.kt is no longer where the sources walk finds it")

        assertTrue(
            "The Coil components block no longer registers AnimatedImageDecoder. " +
                "Without an animated decoder Coil draws a GIF's first frame and " +
                "stops, which is not an error anywhere: it is the GIF picker " +
                "arriving on Android as a still picture.",
            application.contains("AnimatedImageDecoder.Factory()"),
        )
        assertTrue(
            "AnimatedImageDecoder is @RequiresApi(28) and minSdk here is 26, so " +
                "GifDecoder has to stay as the fallback for API 26 and 27.",
            application.contains("GifDecoder.Factory()"),
        )

        val gradle = RepoSources.read("android/app/build.gradle.kts")
        assertTrue(
            "The coil-gif artifact is gone, so neither decoder above can resolve.",
            gradle.contains("libs.coil.gif"),
        )
        assertTrue(
            "media3-exoplayer is gone, and it is the only thing in the module " +
                "that can play a video.",
            gradle.contains("libs.media3.exoplayer"),
        )
    }

    @Test
    fun `the GIF host allowlist is the one shared publishes`() {
        val source = RepoSources.read(gifs)
        val hosts = Regex("""/\^([^/]+)\$/""").findAll(source)
            .map { it.groupValues[1] }
            .toList()
        assertEquals(
            "Parsed the wrong number of host patterns out of $gifs",
            5,
            hosts.size,
        )

        // Each shared pattern, exercised through the Kotlin copy with a URL
        // built for it. A regex-to-regex comparison would only prove the two
        // strings match; this proves the two *decisions* match.
        val samples = mapOf(
            """static\.klipy\.com""" to "https://static.klipy.com/ii/a/b/c/d.gif",
            """media\d*\.giphy\.com""" to "https://media3.giphy.com/media/a/giphy.gif",
            """i\.giphy\.com""" to "https://i.giphy.com/a.gif",
            """media\d*\.tenor\.com""" to "https://media.tenor.com/a/b.gif",
            """c\.tenor\.com""" to "https://c.tenor.com/a/b.gif",
        )
        assertEquals(
            "The host allowlist in $gifs changed. Update GifLinks.MEDIA_HOSTS and " +
                "the samples here together, or Android will draw pictures from a " +
                "host the rest of the product no longer trusts.",
            samples.keys.sorted(),
            hosts.sorted(),
        )
        samples.values.forEach { url ->
            assertTrue("$url should be media", GifLinks.isMediaUrl(url))
        }
    }

    @Test
    fun `the GIF extension allowlist is the one shared publishes`() {
        val source = RepoSources.read(gifs)
        val block = Regex(
            """GIF_MEDIA_EXTENSIONS\s*=\s*\[(.*?)]""",
            RegexOption.DOT_MATCHES_ALL,
        ).find(source)?.groupValues?.get(1)
            ?: error("No GIF_MEDIA_EXTENSIONS in $gifs")
        val extensions = Regex(""""([^"]+)"""").findAll(block).map { it.groupValues[1] }.toList()

        assertTrue("Parsed no extensions out of $gifs", extensions.isNotEmpty())
        extensions.forEach { extension ->
            assertTrue(
                "$extension is media on the web and is not here",
                GifLinks.isMediaUrl("https://media.giphy.com/media/a/giphy$extension"),
            )
        }
        // And the one shared deliberately leaves out, because a video body is
        // not something either client draws as a picture.
        assertFalse(
            "`.mp4` became media, which no client renders with an image loader",
            GifLinks.isMediaUrl("https://media.giphy.com/media/a/giphy.mp4"),
        )
    }
}
