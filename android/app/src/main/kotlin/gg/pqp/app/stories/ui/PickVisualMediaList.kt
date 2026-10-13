package gg.pqp.app.stories.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts

/**
 * The system photo picker, asked for one item, answering with everything that
 * came back. The picker lets a long press on a thumbnail start selecting
 * several (a "Done" button and a count), whatever the request said, and the
 * stock single-item contract keeps the first and drops the rest without a word.
 * This one hands them all over so the caller can use the first and say so, or
 * make each a layer.
 */
class PickVisualMediaList : ActivityResultContract<PickVisualMediaRequest, List<Uri>>() {
    private val single = ActivityResultContracts.PickVisualMedia()

    override fun createIntent(context: Context, input: PickVisualMediaRequest): Intent = single.createIntent(context, input)

    override fun parseResult(resultCode: Int, intent: Intent?): List<Uri> {
        if (intent == null || resultCode != Activity.RESULT_OK) return emptyList()
        val uris = LinkedHashSet<Uri>()
        intent.data?.let(uris::add)
        intent.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
        }
        return uris.toList()
    }
}
