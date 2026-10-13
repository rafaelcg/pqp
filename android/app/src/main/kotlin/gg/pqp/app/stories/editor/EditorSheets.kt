package gg.pqp.app.stories.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/** One row of a sheet: an icon, a label, one tap. */
@Composable
private fun SheetAction(icon: ImageVector, label: String, tag: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag(tag),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant),
        ) { Icon(icon, contentDescription = null) }
        Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = Spacing.md))
    }
}

/** The stickers tray: the call card and a mention today, room for more. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StickerTraySheet(onCall: () -> Unit, onMention: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("stories.editor.tray"),
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Spacing.md)) {
            Text(
                stringResource(R.string.stories_editor_tray_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            )
            SheetAction(PqpIcons.Listening, stringResource(R.string.stories_editor_tray_call), "stories.editor.tray.call", onCall)
            SheetAction(PqpIcons.Handle, stringResource(R.string.stories_editor_tray_mention), "stories.editor.tray.mention", onMention)
        }
    }
}

/** Where a photo layer comes from: the gallery, or a shot taken now. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotoSourceSheet(onGallery: () -> Unit, onCamera: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("stories.editor.photoSource"),
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Spacing.md)) {
            Text(
                stringResource(R.string.stories_editor_photo_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            )
            SheetAction(PqpIcons.Image, stringResource(R.string.stories_editor_photo_gallery), "stories.editor.photo.gallery", onGallery)
            SheetAction(PqpIcons.Camera, stringResource(R.string.stories_editor_photo_camera), "stories.editor.photo.camera", onCamera)
        }
    }
}

/** A voice room the author can put a call card on. */
data class CallRoomOption(
    val serverId: String,
    val serverName: String,
    val channelId: String,
    val channelName: String,
)

/**
 * Picking the room for a call card. The explanation and the rooms scroll
 * apart: the header is fixed and only the list moves, so a longer message can
 * never push a room out of reach (the old picker was one fixed-height scroll
 * where the "you are not in the room" line shoved the second room under the
 * edge). Each room says who is in it now, and which one is the author's.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallRoomSheet(
    rooms: List<CallRoomOption>?,
    occupancy: Map<String, List<VoiceParticipant>>,
    meId: String?,
    selectedChannelId: String?,
    onPick: (CallRoomOption) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("stories.editor.callSheet"),
    ) {
        Column(Modifier.navigationBarsPadding()) {
            Column(Modifier.padding(horizontal = Spacing.gutter)) {
                Text(stringResource(R.string.stories_editor_call_title), style = MaterialTheme.typography.titleLarge)
                Text(
                    stringResource(R.string.stories_call_picker_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.sm),
                )
            }
            when {
                rooms == null -> Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
                rooms.isEmpty() -> Text(
                    stringResource(R.string.stories_call_picker_none),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(Spacing.gutter),
                )
                else -> LazyColumn(Modifier.heightIn(max = 420.dp).testTag("stories.editor.callSheet.list")) {
                    items(rooms, key = { it.channelId }) { room ->
                        CallRoomRow(
                            room = room,
                            people = occupancy[room.channelId].orEmpty(),
                            meIn = meId != null && occupancy[room.channelId].orEmpty().any { it.userId == meId },
                            selected = room.channelId == selectedChannelId,
                            onClick = { onPick(room) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CallRoomRow(room: CallRoomOption, people: List<VoiceParticipant>, meIn: Boolean, selected: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .semantics {
                role = Role.RadioButton
                this.selected = selected
            }
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .testTag("stories.editor.callSheet.room"),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(if (selected) Palette.Signal else MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Icon(
                if (selected) PqpIcons.Confirm else PqpIcons.VoiceChannel,
                contentDescription = null,
                tint = if (selected) Palette.Ink else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(Modifier.weight(1f).padding(horizontal = Spacing.md)) {
            Text(room.channelName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                room.serverName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (people.isEmpty()) {
                    stringResource(R.string.stories_editor_call_empty_room)
                } else {
                    pluralStringResource(R.plurals.stories_editor_call_in_room, people.size, people.size)
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (people.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else Palette.Success,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
            people.take(3).forEach { Avatar(name = it.displayName, url = it.avatarUrl, seed = it.userId, size = 28.dp) }
        }
    }
}

/** Somebody who can be mentioned: a friend, or a member of a server the story goes to. */
data class MentionPerson(val userId: String, val name: String, val username: String?, val avatarUrl: String?)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MentionSheet(people: List<MentionPerson>?, onPick: (MentionPerson) -> Unit, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val shown = people?.filter {
        query.isBlank() || it.name.contains(query, ignoreCase = true) || it.username?.contains(query, ignoreCase = true) == true
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("stories.editor.mentionSheet"),
    ) {
        Column(Modifier.navigationBarsPadding()) {
            Column(Modifier.padding(horizontal = Spacing.gutter)) {
                Text(stringResource(R.string.stories_editor_mention_title), style = MaterialTheme.typography.titleLarge)
                Text(
                    stringResource(R.string.stories_editor_mention_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.sm),
                )
                TextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.stories_editor_mention_search)) },
                    singleLine = true,
                    leadingIcon = { Icon(PqpIcons.Search, contentDescription = null) },
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    ),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().testTag("stories.editor.mentionSheet.search"),
                )
            }
            when {
                shown == null -> Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
                shown.isEmpty() -> Text(
                    stringResource(R.string.stories_editor_mention_none),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(Spacing.gutter),
                )
                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(shown, key = { it.userId }) { person ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(person) }
                                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                                .testTag("stories.editor.mentionSheet.person"),
                        ) {
                            Avatar(name = person.name, url = person.avatarUrl, seed = person.userId, size = 40.dp)
                            Column(Modifier.padding(start = Spacing.md)) {
                                Text(person.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                person.username?.let {
                                    Text(
                                        "@$it",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
