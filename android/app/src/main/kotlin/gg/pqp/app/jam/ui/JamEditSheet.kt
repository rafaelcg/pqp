package gg.pqp.app.jam.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.jam.CoverChoice
import gg.pqp.app.jam.CoverPicture
import gg.pqp.app.jam.CoverUpload
import gg.pqp.app.jam.EditNote
import gg.pqp.app.jam.JamBidi
import gg.pqp.app.jam.JamCover
import gg.pqp.app.jam.JamLimits
import gg.pqp.app.jam.JamNaming
import gg.pqp.app.jam.JamSongEditor
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamText
import gg.pqp.app.jam.JamWriteFailure
import gg.pqp.app.jam.PhotoProblem
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * "Editar música": a song's name, its artist and its cover photo, in one sheet. The web's `jam-edit-sheet.tsx`, in the
 * same order and words. Opened from the song screen for the people the server lets edit it (the song's author or a
 * moderator, flag on); the server decides again on every write, and a 403 here is said in words and the screen is asked
 * to read what this person may do again.
 *
 * THE PICTURE AT THE TOP IS THE TILE, LIVE: what is edited is drawn the way the song will look in the list (the photo,
 * square, and under it the name and artist as they are typed). THE PHOTO GOES UP WHEN IT IS PICKED and is CLAIMED WHEN
 * THEY SAVE, so closing the sheet leaves the old cover exactly as it was. All of that is `JamSongEditor` (tested); this
 * file is the screen and the system photo picker.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamEditSheet(song: JamSongSummary, editor: JamSongEditor, onDismiss: () -> Unit) {
    val ui by editor.ui.collectAsStateWithLifecycle()
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val reduce = rememberReduceMotion()
    val title = ui.titleEdit ?: song.title
    val artist = ui.artistEdit ?: song.artist.orEmpty()
    val plan = editor.plan(song)
    val titleChecked = JamText.checkTitle(title)
    val artistChecked = JamText.checkArtist(artist)
    val titleOk = titleChecked is JamText.Checked.Ok
    val artistOk = artistChecked is JamText.Checked.Ok
    // Empty is said as soon as it is empty (an empty title also disables Save, and a disabled button cannot be pressed to find out why).
    val showTitleError = !titleOk && (ui.touched || title != song.title)
    val showArtistError = !artistOk && (ui.touched || artist != song.artist.orEmpty())
    // Something would be lost by closing: a change Save would send, or a photo going up.
    val dirty = !plan.empty || ui.uploading
    val hasPhoto = ui.cover is CoverChoice.New || ui.uploading || (ui.cover == CoverChoice.Keep && song.coverUrl != null)
    var confirmDiscard by remember { mutableStateOf(false) }
    val dirtyNow by rememberUpdatedState(dirty || ui.saving)
    val sheet = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        // A swipe or a tap outside does not throw away what was typed or picked: it asks first, from "Cancelar" or back.
        confirmValueChange = { target -> target != SheetValue.Hidden || !dirtyNow },
    )

    fun requestClose() {
        if (ui.saving) return
        if (dirty) confirmDiscard = true else onDismiss()
    }
    LaunchedEffect(ui.done) { if (ui.done) onDismiss() }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val result = withContext(Dispatchers.Default) { JamCoverPhoto.prepare(context.contentResolver, uri) }) {
                is JamCoverPhoto.Prepared.Ready -> editor.photoReady(result.jpeg)
                is JamCoverPhoto.Prepared.Rejected -> editor.photoRejected(result.problem)
            }
        }
    }
    fun launchPicker() = pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("jam.edit")) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            // Inside the sheet's own window, so it is asked before the sheet's own back handling hides it.
            BackHandler(enabled = true) { requestClose() }
            Text(stringResource(R.string.jam_edit_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.ExtraBold)

            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(
                    stringResource(R.string.jam_edit_preview_label),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.Start),
                )
                PreviewTile(
                    song = song,
                    title = (titleChecked as? JamText.Checked.Ok)?.value ?: song.title,
                    artist = (artistChecked as? JamText.Checked.Ok)?.value,
                    cover = ui.cover,
                    preview = ui.pending ?: ui.preview,
                    uploading = ui.upload,
                    reduce = reduce,
                    onPick = ::launchPicker,
                )
                Row(Modifier.width(220.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(
                        onClick = ::launchPicker,
                        enabled = !ui.saving && !ui.uploading,
                        modifier = Modifier.weight(1f).heightIn(min = 44.dp).testTag("jam.edit.photo"),
                    ) {
                        Icon(PqpIcons.Image, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text(
                            stringResource(if (hasPhoto) R.string.jam_edit_change_photo else R.string.jam_edit_add_photo),
                            modifier = Modifier.padding(start = 8.dp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (hasPhoto) {
                        val remove = stringResource(R.string.jam_edit_remove_photo)
                        IconButton(
                            onClick = { editor.removeCover(song.coverUrl != null) },
                            enabled = !ui.saving,
                            modifier = Modifier.semantics { contentDescription = remove }.testTag("jam.edit.removePhoto"),
                        ) { Icon(PqpIcons.Delete, contentDescription = null, modifier = Modifier.size(20.dp)) }
                    }
                }
                val failed = (ui.upload as? CoverUpload.Failed)?.problem
                val note = when {
                    failed != null -> photoProblemText(failed)
                    ui.note == EditNote.Ready -> stringResource(R.string.jam_edit_ready_hint)
                    ui.note == EditNote.Removed -> stringResource(R.string.jam_edit_removed_hint)
                    else -> null
                }
                if (note != null) {
                    Text(
                        note,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (failed != null) colors.error else colors.onSurfaceVariant,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("jam.edit.note"),
                    )
                }
            }

            OutlinedTextField(
                value = title,
                onValueChange = editor::setTitle,
                label = { Text(stringResource(R.string.jam_start_song_title)) },
                placeholder = { Text(stringResource(R.string.jam_start_song_title_hint)) },
                singleLine = true,
                isError = showTitleError,
                supportingText = {
                    when {
                        showTitleError -> Text(
                            stringResource(if (titleChecked is JamText.Checked.Invisible) R.string.jam_edit_title_invisible else R.string.jam_start_need_title),
                        )
                        title.length >= JamLimits.TITLE_MAX -> Text(stringResource(R.string.jam_edit_title_max, JamLimits.TITLE_MAX))
                        title.length >= JamLimits.TITLE_MAX - 20 -> Text("${title.length}/${JamLimits.TITLE_MAX}")
                    }
                },
                enabled = !ui.saving,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().testTag("jam.edit.title"),
            )
            OutlinedTextField(
                value = artist,
                onValueChange = editor::setArtist,
                label = { Text(stringResource(R.string.jam_edit_artist)) },
                placeholder = { Text(stringResource(R.string.jam_edit_artist_placeholder)) },
                singleLine = true,
                isError = showArtistError,
                supportingText = { if (showArtistError) Text(stringResource(R.string.jam_edit_artist_invisible)) },
                enabled = !ui.saving,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().testTag("jam.edit.artist"),
            )
            ui.failure?.let { failure ->
                Text(
                    editFailureText(failure),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onErrorContainer,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.errorContainer)
                        .padding(horizontal = 12.dp, vertical = 8.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }
                        .testTag("jam.edit.error"),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.sm, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = ::requestClose, enabled = !ui.saving, modifier = Modifier.testTag("jam.edit.cancel")) {
                    Text(stringResource(R.string.jam_cancel))
                }
                Button(
                    onClick = { editor.save(song) },
                    enabled = !plan.empty && !ui.uploading && !ui.saving && !showTitleError && !showArtistError,
                    modifier = Modifier.heightIn(min = 48.dp).width(120.dp).testTag("jam.edit.save"),
                ) {
                    if (ui.saving) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.onPrimary)
                    } else {
                        Text(stringResource(R.string.jam_edit_save), fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.jam_edit_discard_title)) },
            text = { Text(stringResource(R.string.jam_edit_discard_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDiscard = false
                        onDismiss()
                    },
                    modifier = Modifier.testTag("jam.edit.discard"),
                ) { Text(stringResource(R.string.jam_edit_discard), color = colors.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text(stringResource(R.string.jam_edit_keep_editing)) } },
        )
    }
}

@Composable
private fun photoProblemText(problem: PhotoProblem): String = when (problem) {
    PhotoProblem.Type -> stringResource(R.string.jam_edit_photo_type)
    is PhotoProblem.Small -> stringResource(R.string.jam_edit_photo_small, problem.width, problem.height, JamCover.MIN_SIDE)
    PhotoProblem.Unreadable -> stringResource(R.string.jam_edit_photo_unreadable)
    PhotoProblem.Failed -> stringResource(R.string.jam_edit_photo_failed)
    is PhotoProblem.Write -> when (problem.failure) {
        JamWriteFailure.TooLarge -> stringResource(R.string.jam_edit_photo_too_large)
        JamWriteFailure.Other -> stringResource(R.string.jam_edit_photo_failed)
        else -> editFailureText(problem.failure)
    }
}

@Composable
private fun editFailureText(failure: JamWriteFailure): String = stringResource(
    when (failure) {
        JamWriteFailure.Off -> R.string.jam_err_off
        JamWriteFailure.Denied -> R.string.jam_edit_denied
        JamWriteFailure.TooLarge -> R.string.jam_edit_photo_too_large
        JamWriteFailure.StorageOff -> R.string.jam_err_storage_off
        JamWriteFailure.RateLimited -> R.string.jam_err_rate_limited
        JamWriteFailure.Network -> R.string.jam_err_network
        JamWriteFailure.Gone -> R.string.jam_err_gone
        JamWriteFailure.Invalid -> R.string.jam_err_invalid
        JamWriteFailure.Other -> R.string.jam_err_other
    },
)

/**
 * The song's card as the wall will draw it, live: the picture (square, centred, exactly what is sent), and under it the
 * name and artist as they are typed. The picture is the button that picks a photo; while a photo goes up it stays under a
 * ring, and a fresh one lands with a small spring (none under "remove animations").
 */
@Composable
private fun PreviewTile(
    song: JamSongSummary,
    title: String,
    artist: String?,
    cover: CoverChoice,
    preview: CoverPicture?,
    uploading: CoverUpload,
    reduce: Boolean,
    onPick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val uploadingNow = uploading is CoverUpload.Uploading
    val showNew = preview != null && (cover is CoverChoice.New || uploadingNow)
    val showCurrent = cover == CoverChoice.Keep && song.coverKey != null
    val photo = showNew || showCurrent
    val pop = remember(preview) { Animatable(if (reduce || preview == null || uploadingNow) 1f else 0.94f) }
    LaunchedEffect(preview, uploadingNow) {
        if (!reduce && !uploadingNow && pop.value < 1f) pop.animateTo(1f, spring(dampingRatio = 0.55f, stiffness = 500f))
    }
    val fraction = (uploading as? CoverUpload.Uploading)?.fraction ?: 0f
    val shown by animateFloatAsState(if (reduce) fraction else fraction.coerceAtLeast(0.04f), spring(stiffness = 300f), label = "ring")
    val photoDescription = stringResource(if (photo) R.string.jam_edit_change_photo else R.string.jam_edit_add_photo)
    Column(
        Modifier
            .width(220.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(colors.surfaceContainer)
            .border(1.dp, colors.outlineVariant, RoundedCornerShape(22.dp))
            .testTag("jam.edit.tile"),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .background(jamGround(song))
                .clickable(enabled = !uploadingNow, onClick = onPick)
                .semantics { contentDescription = photoDescription },
        ) {
            if (showNew && preview != null) {
                AsyncImage(
                    model = preview.jpeg,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    // Dimmed while it goes up by darkening the picture itself, not by laying a wash over it.
                    colorFilter = if (uploadingNow) ColorFilter.tint(Color(0xFF8C8C8C), BlendMode.Modulate) else null,
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            scaleX = pop.value
                            scaleY = pop.value
                        },
                )
            } else if (showCurrent) {
                JamCoverImage(song)
            } else {
                // No photo yet: an invitation, a dashed frame and a camera.
                Box(Modifier.fillMaxSize().padding(10.dp), contentAlignment = Alignment.TopEnd) {
                    Canvas(Modifier.fillMaxSize()) {
                        drawRoundRect(
                            color = JamInk.copy(alpha = 0.55f),
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(14.dp.toPx()),
                            style = Stroke(width = 2.dp.toPx(), pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(14f, 10f))),
                        )
                    }
                    Box(Modifier.padding(8.dp).size(36.dp).clip(CircleShape).background(JamInk), contentAlignment = Alignment.Center) {
                        Icon(PqpIcons.Camera, contentDescription = null, tint = jamGround(song), modifier = Modifier.size(18.dp))
                    }
                }
            }
            if (showNew && !uploadingNow) {
                Row(
                    Modifier
                        .padding(8.dp)
                        .align(Alignment.TopStart)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xFF05080C))
                        .padding(start = 6.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(PqpIcons.Confirm, contentDescription = null, tint = colors.primary, modifier = Modifier.size(14.dp))
                    Text(stringResource(R.string.jam_edit_ready), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = Color.White)
                }
            }
            if (uploadingNow) {
                val sending = stringResource(R.string.jam_edit_sending)
                Box(
                    Modifier
                        .align(Alignment.Center)
                        .size(64.dp)
                        .clip(CircleShape)
                        .background(Color(0xFF05080C))
                        .semantics { contentDescription = sending; progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f) }
                        .testTag("jam.edit.progress"),
                    contentAlignment = Alignment.Center,
                ) {
                    Canvas(Modifier.fillMaxSize().padding(6.dp)) {
                        val stroke = 4.dp.toPx()
                        drawCircle(Color.White.copy(alpha = 0.25f), style = Stroke(stroke))
                        drawArc(
                            color = colors.primary,
                            startAngle = -90f,
                            sweepAngle = 360f * shown,
                            useCenter = false,
                            topLeft = Offset(stroke / 2, stroke / 2),
                            size = Size(size.width - stroke, size.height - stroke),
                            style = Stroke(stroke, cap = StrokeCap.Round),
                        )
                    }
                    Text("${(fraction * 100).toInt()}%", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.ExtraBold, color = Color.White)
                }
            }
        }
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = JamBidi.clean(title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.ExtraBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = JamNaming.drawn(artist, stringResource(R.string.jam_original)).orEmpty(),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
