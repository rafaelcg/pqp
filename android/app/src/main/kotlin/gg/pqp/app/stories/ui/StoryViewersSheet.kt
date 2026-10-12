package gg.pqp.app.stories.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoriesStore
import gg.pqp.app.stories.Story
import gg.pqp.app.stories.StoryViewersPage
import gg.pqp.app.stories.storyViewers
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * Who saw my story, with each person's reaction and whether they replied.
 * The author's alone; nobody else ever sees this list. Re-read when the
 * server says the counts moved (`stories-update` scope `own`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StoryViewersSheet(
    session: SessionStore,
    store: StoriesStore,
    story: Story,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    val version by store.ownVersion.collectAsStateWithLifecycle()
    var page by remember(story.id) { mutableStateOf<StoryViewersPage?>(null) }
    LaunchedEffect(story.id, version) {
        runCatching { session.api.storyViewers(story.id) }.onSuccess { page = it }
    }
    val now = System.currentTimeMillis()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("stories.viewers"),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter),
        ) {
            val loaded = page
            Text(
                stringResource(R.string.stories_viewers_title, loaded?.viewCount ?: story.own?.viewCount ?: 0),
                style = MaterialTheme.typography.titleLarge,
            )
            val reactions = loaded?.reactionCount ?: story.own?.reactionCount ?: 0
            Text(
                androidx.compose.ui.res.pluralStringResource(
                    R.plurals.stories_viewers_meta,
                    reactions,
                    reactions,
                    StoriesRules.left(story.expiresAt, now) ?: "",
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.padding(vertical = Spacing.md)) {
                OutlinedButton(onClick = onDelete, modifier = Modifier.testTag("stories.viewers.delete")) {
                    Icon(PqpIcons.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(Spacing.xs))
                    Text(stringResource(R.string.stories_own_delete), color = MaterialTheme.colorScheme.error)
                }
            }
            val viewers = loaded?.viewers.orEmpty()
            if (loaded != null && viewers.isEmpty()) {
                Text(
                    stringResource(R.string.stories_viewers_none),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = Spacing.lg),
                )
            }
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(viewers, key = { it.user.id }) { row ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = Spacing.sm)
                            .testTag("stories.viewers.row"),
                    ) {
                        AuthorAvatar(row.user, 40.dp)
                        Spacer(Modifier.width(Spacing.md))
                        Column(Modifier.weight(1f)) {
                            Text(row.user.displayName, style = MaterialTheme.typography.titleSmall)
                            val ago = StoriesRules.age(row.viewedAt, now).orEmpty()
                            Text(
                                if (row.replied) "$ago · ${stringResource(R.string.stories_viewers_replied)}" else ago,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        row.reaction?.let {
                            Text(StoriesRules.reactionGlyph(it), style = MaterialTheme.typography.titleMedium)
                        }
                    }
                }
            }
            Spacer(Modifier.size(Spacing.lg))
        }
    }
}
