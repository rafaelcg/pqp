package gg.pqp.app.jam.audio

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A stored stem to mono 16-bit PCM at [MIX_RATE], in a file the mixer maps.
 *
 * `MediaExtractor` + `MediaCodec` is the platform's own decoder for every
 * format the server accepts (FLAC, Opus in Ogg or WebM, AAC in MP4, MP3) plus
 * WAV, so no codec is bundled. What each of them does to TIME (the leading
 * silence an encoder adds, and whether the platform removes it) is measured, not
 * assumed: `JamCodecAlignmentTest` (instrumented) decodes the same impulse
 * encoded every way and reports where it lands, and the table is in
 * `docs/ANDROID.md`, section "Jam".
 *
 * Stereo or wider is averaged to mono: a jam stem is mono on the web, and a file
 * from anywhere else is a stem, not a mix to be kept in stereo.
 */
object JamDecoder {
    class Decoded(
        val file: File,
        /** Frames at [MIX_RATE]. */
        val frames: Long,
        val sourceRate: Int,
        val sourceChannels: Int,
        val mime: String,
        /** Frames the platform removed from the head (encoder delay) according to the format, at the source rate. */
        val delayFrames: Int,
    )

    class UnplayableStem(message: String, cause: Throwable? = null) : Exception(message, cause)

    /**
     * Decodes [input] into [output]. Blocking, for a worker thread; [cancelled]
     * is polled between buffers so a screen that went away stops the work.
     */
    fun decode(input: File, output: File, cancelled: () -> Boolean = { false }): Decoded {
        val raw = File(output.parentFile, output.name + ".raw")
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(input.path)
            val trackIndex = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: throw UnplayableStem("no audio track")
            extractor.selectTrack(trackIndex)
            val format = extractor.getTrackFormat(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: throw UnplayableStem("no mime")

            var rate = format.intOrZero(MediaFormat.KEY_SAMPLE_RATE)
            var channels = format.intOrZero(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
            var float = false
            var delay = format.intOrZero(MediaFormat.KEY_ENCODER_DELAY)
            var written = 0L

            val codec = try {
                MediaCodec.createDecoderByType(mime)
            } catch (e: Exception) {
                throw UnplayableStem("no decoder for $mime", e)
            }
            try {
                codec.configure(format, null, null, 0)
                codec.start()
                val info = MediaCodec.BufferInfo()
                var inputDone = false
                var outputDone = false
                BufferedOutputStream(FileOutputStream(raw), 1 shl 16).use { sink ->
                    var bytes = ByteArray(1 shl 14)
                    while (!outputDone) {
                        if (cancelled()) throw InterruptedException("cancelled")
                        if (!inputDone) {
                            val index = codec.dequeueInputBuffer(TIMEOUT_US)
                            if (index >= 0) {
                                val buffer = codec.getInputBuffer(index)!!
                                val size = extractor.readSampleData(buffer, 0)
                                if (size < 0) {
                                    codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    inputDone = true
                                } else {
                                    codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
                                    extractor.advance()
                                }
                            }
                        }
                        val out = codec.dequeueOutputBuffer(info, TIMEOUT_US)
                        when {
                            out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                                val changed = codec.outputFormat
                                rate = changed.intOrZero(MediaFormat.KEY_SAMPLE_RATE).takeIf { it > 0 } ?: rate
                                channels = changed.intOrZero(MediaFormat.KEY_CHANNEL_COUNT).takeIf { it > 0 } ?: channels
                                float = changed.intOrZero(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT
                            }
                            out >= 0 -> {
                                if (info.size > 0) {
                                    val buffer = codec.getOutputBuffer(out)!!
                                    buffer.position(info.offset)
                                    buffer.limit(info.offset + info.size)
                                    val frames = info.size / ((if (float) 4 else 2) * channels)
                                    if (bytes.size < frames * 2) bytes = ByteArray(frames * 2)
                                    monoLittleEndian(buffer, frames, channels, float, bytes)
                                    sink.write(bytes, 0, frames * 2)
                                    written += frames
                                }
                                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                                codec.releaseOutputBuffer(out, false)
                            }
                        }
                    }
                }
            } finally {
                runCatching { codec.stop() }
                codec.release()
            }
            if (rate <= 0) throw UnplayableStem("no sample rate")
            if (written == 0L) throw UnplayableStem("decoded nothing")

            if (rate == MIX_RATE) {
                if (!raw.renameTo(output)) {
                    raw.copyTo(output, overwrite = true)
                    raw.delete()
                }
                return Decoded(output, written, rate, channels, mime, delay)
            }
            val source = MappedPcm(raw)
            try {
                var produced = 0L
                BufferedOutputStream(FileOutputStream(output), 1 shl 16).use { sink ->
                    val bytes = ByteArray(8192 * 2)
                    JamResampler.resample(source, rate, MIX_RATE) { block, count ->
                        if (cancelled()) throw InterruptedException("cancelled")
                        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                        for (i in 0 until count) bb.putShort(i * 2, block[i])
                        sink.write(bytes, 0, count * 2)
                        produced += count
                    }
                }
                return Decoded(output, produced, rate, channels, mime, delay)
            } finally {
                source.close()
                raw.delete()
            }
        } catch (e: UnplayableStem) {
            raw.delete()
            throw e
        } catch (e: InterruptedException) {
            raw.delete()
            output.delete()
            throw e
        } catch (e: Exception) {
            raw.delete()
            output.delete()
            throw UnplayableStem(e.message ?: "decode failed", e)
        } finally {
            extractor.release()
        }
    }

    /** One codec buffer to mono 16-bit little-endian bytes. */
    internal fun monoLittleEndian(buffer: ByteBuffer, frames: Int, channels: Int, float: Boolean, out: ByteArray) {
        val view = buffer.order(ByteOrder.nativeOrder())
        val target = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        if (float) {
            val samples = view.asFloatBuffer()
            for (f in 0 until frames) {
                var sum = 0f
                for (c in 0 until channels) sum += samples.get(f * channels + c)
                val v = Math.round(sum / channels * 32768f).coerceIn(-32768, 32767)
                target.putShort(f * 2, v.toShort())
            }
        } else {
            val samples = view.asShortBuffer()
            for (f in 0 until frames) {
                var sum = 0
                for (c in 0 until channels) sum += samples.get(f * channels + c)
                target.putShort(f * 2, (sum / channels).toShort())
            }
        }
    }

    private fun MediaFormat.intOrZero(key: String): Int =
        if (containsKey(key)) runCatching { getInteger(key) }.getOrDefault(0) else 0

    private const val TIMEOUT_US = 10_000L
}
