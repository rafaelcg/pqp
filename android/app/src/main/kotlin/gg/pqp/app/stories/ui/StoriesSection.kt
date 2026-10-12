package gg.pqp.app.stories.ui

import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.StoriesStore
import gg.pqp.app.ui.theme.Spacing

/**
 * One story strip with everything it opens: the viewer, the composer, the
 * one-time "staff removed your story" notice. Drop it where the strip goes;
 * it draws nothing while stories are off for this scope.
 *
 * [serverId] null is the friends strip (Conversas), which follows the global
 * flag; a server strip follows that server's flag. Both answer through their
 * own route, so a phone never shows a strip the server would not serve.
 */
@Composable
fun StoriesSection(
    session: SessionStore,
    serverId: String?,
    /** What the viewer header says this was seen through: the server's name, or Amigos. */
    contextLabel: String,
    onJoinCall: (serverId: String, channelId: String, channelName: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val store = remember(session) { StoriesStore.of(session) }
    val key = serverId?.let(store::serverKey) ?: StoriesStore.FRIENDS
    val strips by store.strips.collectAsStateWithLifecycle()
    val notice by store.notice.collectAsStateWithLifecycle()
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me
    val context = LocalContext.current
    val posted = stringResource(R.string.stories_upload_posted)

    LaunchedEffect(key) { store.refreshConfig() }
    LifecycleResumeEffect(key) {
        store.refresh(key)
        onPauseOrDispose { }
    }

    var viewing by remember { mutableStateOf<Pair<List<StoryDeck>, Int>?>(null) }
    var composing by remember { mutableStateOf(false) }

    val strip = strips[key]
    if (strip != null && strip.enabled) {
        val nothingLive = strip.items.isEmpty() && strip.own == null
        Column(modifier) {
            when {
                nothingLive && strip.firstRunHint && strip.canPost ->
                    StoryFirstRunRow(me = me, onPost = { composing = true }, modifier = Modifier.padding(vertical = Spacing.sm))
                // The server strip only appears with a story on it; an empty
                // bubble would cost the top of every server screen forever.
                nothingLive && serverId != null -> Unit
                nothingLive && !strip.canPost -> Unit
                else -> StoryStripRow(
                    strip = strip,
                    me = me,
                    onOpenAuthor = { index ->
                        viewing = strip.items.map { StoryDeck(it.author, it.storyIds) } to index
                    },
                    onOpenOwn = {
                        strip.own?.let { own -> viewing = listOf(StoryDeck(own.author, own.storyIds)) to 0 }
                    },
                    onCompose = { composing = true },
                    modifier = Modifier.padding(vertical = Spacing.sm),
                )
            }
        }
    }

    viewing?.let { (decks, start) ->
        StoryViewer(
            session = session,
            store = store,
            decks = decks,
            startDeck = start,
            contextLabel = contextLabel,
            contextServerId = serverId,
            onDismiss = { viewing = null },
            onJoinCall = onJoinCall,
        )
    }

    if (composing) {
        StoryComposer(
            session = session,
            store = store,
            contextServerId = serverId,
            onDismiss = { composing = false },
            onPosted = {
                composing = false
                Toast.makeText(context, posted, Toast.LENGTH_SHORT).show()
            },
        )
    }

    notice?.let { removed ->
        AlertDialog(
            onDismissRequest = store::dismissNotice,
            title = { Text(stringResource(R.string.stories_removed_title, removed.serverName.orEmpty())) },
            text = {
                Text(
                    stringResource(
                        R.string.stories_removed_body,
                        removed.reason?.takeIf { it.isNotBlank() } ?: stringResource(R.string.stories_removed_no_reason),
                    ),
                )
            },
            confirmButton = { TextButton(onClick = store::dismissNotice) { Text(stringResource(R.string.ok)) } },
        )
    }
}
