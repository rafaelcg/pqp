package gg.pqp.app.stories

import gg.pqp.app.core.PqpJson
import java.io.File
import kotlinx.serialization.Serializable

/** One file a draft will upload: the base picture or clip, or a photo or drawing layer. */
@Serializable
data class DraftFile(
    /** Where it sits in the story: [BASE], or the layer's own id. */
    val key: String,
    val contentType: String,
    val size: Long,
    /** Name inside the draft's folder. */
    val name: String,
) {
    companion object {
        const val BASE = "base"
    }
}

/**
 * Everything needed to post a story again, and nothing about the screen that
 * made it: the request exactly as it will be sent, and the files it names. A
 * retry, or a launch after the process died mid-post, resends this and never
 * asks the person to remake anything.
 */
@Serializable
data class StoryDraft(
    /** Also the request id: the same on every attempt, so a lost answer never posts the story twice. */
    val id: String,
    val userId: String,
    val request: CreateStoryRequest,
    val files: List<DraftFile>,
    /** Strips to read again once it is live: "server:<id>" or "friends". */
    val refreshKeys: List<String> = emptyList(),
    val createdAt: Long = 0L,
)

/**
 * The drafts on disk, one folder each under [root]: `draft.json` and the files
 * beside it. A draft is written whole before anything is sent and deleted only
 * when the story is live or the person discards it, so "kept until posted or
 * discarded" is a property of this folder, not of a screen or a process.
 *
 * Plain `java.io`, so the round trip is a JVM test.
 */
class StoryDraftStore(private val root: File) {

    private fun dir(id: String) = File(root, id)

    /** Write the draft folder, [files] by name. Replaces a folder of the same id. */
    fun write(draft: StoryDraft, files: Map<String, ByteArray>) {
        val folder = dir(draft.id)
        folder.deleteRecursively()
        check(folder.mkdirs() || folder.isDirectory) { "Cannot create ${folder.path}" }
        files.forEach { (name, bytes) -> File(folder, name).writeBytes(bytes) }
        // The manifest goes last and through a rename: a folder with a manifest is a complete draft.
        val temp = File(folder, "draft.json.tmp")
        temp.writeText(PqpJson.encodeToString(StoryDraft.serializer(), draft))
        check(temp.renameTo(File(folder, MANIFEST))) { "Cannot finish ${draft.id}" }
    }

    fun file(id: String, name: String): File = File(dir(id), name)

    /** Every complete draft; a half-written folder (no manifest) or an unreadable one is cleaned away. */
    fun list(): List<StoryDraft> {
        val folders = root.listFiles { f -> f.isDirectory } ?: return emptyList()
        return folders.mapNotNull { folder ->
            val manifest = File(folder, MANIFEST)
            val draft = if (manifest.isFile) {
                runCatching { PqpJson.decodeFromString(StoryDraft.serializer(), manifest.readText()) }.getOrNull()
            } else {
                null
            }
            if (draft == null || draft.id != folder.name) folder.deleteRecursively()
            draft
        }.sortedBy { it.createdAt }
    }

    fun delete(id: String) {
        dir(id).deleteRecursively()
    }

    private companion object {
        const val MANIFEST = "draft.json"
    }
}
