@file:OptIn(ExperimentalLayoutApi::class)

package gg.pqp.app.jam.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.jam.JamBidi
import gg.pqp.app.jam.JamConfig
import gg.pqp.app.jam.JamEditPermissions
import gg.pqp.app.jam.JamMixRules
import gg.pqp.app.jam.JamTrackEdit
import gg.pqp.app.jam.JamWriteFailure
import gg.pqp.app.jam.JamNaming
import gg.pqp.app.jam.JamNeed
import gg.pqp.app.jam.JamNotice
import gg.pqp.app.jam.JamPeaks
import gg.pqp.app.jam.JamPermissions
import gg.pqp.app.jam.JamPlayhead
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamRecordRules
import gg.pqp.app.jam.JamShare
import gg.pqp.app.jam.JamRequestAction
import gg.pqp.app.jam.JamRequestsUi
import gg.pqp.app.jam.RecordGate
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamSongUi
import gg.pqp.app.jam.JamSongViewModel
import gg.pqp.app.jam.JamStemStatus
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.JamWho
import gg.pqp.app.jam.jamSongLink
import gg.pqp.app.jam.record.JamStudioLaunch
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One song: a header that the wall's tile grew out of, every in-mix stem as a
 * row with its waveform under one playhead, and a transport at the bottom.
 *
 * What is on it is what the engine plays (`JamSongViewModel`): play, pause and
 * scrub (drag or tap any waveform, or the bar above the play button), mute, solo
 * and volume per track (local to this phone), competing takes you can hear in
 * place of the mix's and vote on, the in-mix switch for the song's author or a
 * moderator, and delete where the contract allows it. "Gravar minha parte" opens
 * the studio (`JamStudioScreen`) over this screen: the song and its decoded band
 * stay alive underneath, which is what the studio plays against.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamSongScreen(
    model: JamSongViewModel,
    songId: String,
    serverId: String,
    channelId: String,
    /** The wall's summary, drawn at once while the detail loads. */
    seed: JamSongSummary?,
    shared: JamSharedScope?,
    viewerId: String?,
    /** What this server says about jam (the flag and storage), for the record button. */
    config: JamConfig,
    /** The studio opens over this screen, with the band as it is decoded here. */
    onRecord: (JamStudioLaunch) -> Unit,
    /** Read the flag again: this screen stays open while it may change, and the wall does not start again for it. */
    onRefreshConfig: () -> Unit,
    onBack: () -> Unit,
    /** `jam_public` is on for this account: the share button may hand out a public page, and the waiting parts exist. */
    publicEnabled: Boolean = false,
    /** The parts people outside sent to THIS song that wait for this person's answer (the starter's inbox). */
    pending: List<JamTrack> = emptyList(),
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val requests by model.requests.ui.collectAsStateWithLifecycle()
    val publication by model.publication.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val gettingBandText = stringResource(R.string.jam_rec_getting_band)
    val blockedTexts = mapOf(
        RecordGate.Reason.Off to stringResource(R.string.jam_rec_cannot_off),
        RecordGate.Reason.UploadsOff to stringResource(R.string.jam_rec_cannot_uploads_off),
        RecordGate.Reason.Closed to stringResource(R.string.jam_rec_cannot_closed),
        RecordGate.Reason.Other to stringResource(R.string.jam_rec_cannot_other),
    )
    fun blockedText(reason: RecordGate.Reason) = blockedTexts.getValue(reason)
    var confirmSong by remember { mutableStateOf(false) }
    var confirmTrack by remember { mutableStateOf<JamTrack?>(null) }
    var menu by remember { mutableStateOf(false) }
    // The edit sheet's own state lives in the view model (a rotation keeps what was typed and the photo that went up).
    var editing by rememberSaveable { mutableStateOf(false) }
    val canEditSong = ui.state?.let { JamEditPermissions.canEditSong(it.viewer, config.enabled) } == true
    fun openEditor() {
        menu = false
        model.editor.open()
        editing = true
    }

    // Unsaved edits of a take are never dropped silently: whatever would leave them behind (back, another take's editor,
    // the studio) asks first, the way the song sheet does.
    var pendingAfterDiscard by remember { mutableStateOf<(() -> Unit)?>(null) }
    fun guarded(action: () -> Unit) {
        if (ui.adjustDirty) pendingAfterDiscard = action else action()
    }
    BackHandler(enabled = ui.adjustDirty) { guarded(onBack) }
    val editorFailure by model.editor.ui.collectAsStateWithLifecycle()
    // A write refused because the flag went off says the flag may have changed; and the screen coming back to the
    // front reads it again, so the pencil and the faders come back with the flag as they went with it.
    LaunchedEffect(editorFailure.failure, ui.adjust?.failure, editorFailure.done) {
        if (editorFailure.failure == JamWriteFailure.Off || ui.adjust?.failure == JamWriteFailure.Off || editorFailure.done) onRefreshConfig()
    }

    // The song's public state is read for its starter and for anybody with a part in it (the server answers null for the
    // rest), and again when a part arrives for the starter: the share button and the waiting block read it.
    val involved = ui.state?.let { it.viewer.isAuthor || it.tracks.any { track -> viewerId != null && track.authorId == viewerId } } == true
    LaunchedEffect(publicEnabled, involved, pending.isNotEmpty()) {
        if (publicEnabled && involved) model.readPublication()
    }

    // The app left the screen: pause, so a song is never left playing to nobody.
    LifecycleStartEffect(songId) {
        onRefreshConfig()
        onStopOrDispose { model.onBackgrounded() }
    }
    // The song screen closing frees the codecs, the mapped files and the speaker. A rotation is not closing.
    androidx.compose.runtime.DisposableEffect(model) {
        onDispose {
            if ((context as? android.app.Activity)?.isChangingConfigurations != true) model.releaseMedia()
        }
    }
    // The heard position drives the playhead and the video, once per frame, only while playing.
    LaunchedEffect(ui.playing) {
        while (ui.playing) {
            androidx.compose.runtime.withFrameNanos { model.onClock(it) }
        }
    }
    LaunchedEffect(ui.phase) {
        if (ui.phase == JamSongUi.Phase.Gone) {
            // The wall under us already took the deletion; leave once the message has been read.
            delay(1400)
            onBack()
        }
    }
    val noticeText = ui.notice?.let { noticeString(it) }
    LaunchedEffect(ui.notice) {
        if (noticeText != null) {
            snackbars.showSnackbar(noticeText)
            model.dismissNotice()
        }
    }

    val link = jamSongLink(Backend.appUrl, serverId, channelId, songId)
    val copiedText = stringResource(R.string.jam_link_copied)
    // A song a stranger can open (public, live) is shared with its public page and the web's message, which asks for what is
    // still missing; a private channel song keeps the app's own link, as before.
    val songToShare = ui.state?.song
    val publicShare = songToShare != null && JamShare.offered(publicEnabled, publication?.status, songToShare.channelId)
    val shareMessage = if (publicShare && songToShare != null) {
        val tracks = ui.state?.tracks.orEmpty()
        jamShareMessage(songToShare, JamShare.pendingOf(tracks, viewerId, ui.state?.viewer?.isAuthor == true))
    } else {
        null
    }
    val publicLink = if (publicShare) JamShare.publicLink(Backend.appUrl, songId) else null
    val copyTarget = publicLink ?: link

    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) },
        topBar = {
            Column {
                TopAppBar(
                    colors = pqpTopBarColors(),
                    title = {},
                    navigationIcon = {
                        IconButton(onClick = { guarded(onBack) }, modifier = Modifier.testTag("jam.song.back")) {
                            Icon(PqpIcons.Back, contentDescription = stringResource(R.string.jam_back))
                        }
                    },
                    actions = {
                        if (canEditSong) {
                            IconButton(onClick = ::openEditor, modifier = Modifier.testTag("jam.song.edit")) {
                                Icon(PqpIcons.Edit, contentDescription = stringResource(R.string.jam_edit_open))
                            }
                        }
                        Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("jam.song.more")) {
                                Icon(PqpIcons.More, contentDescription = stringResource(R.string.jam_more))
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.jam_copy_link)) },
                                    leadingIcon = { Icon(PqpIcons.Copy, contentDescription = null) },
                                    onClick = {
                                        menu = false
                                        copyLink(context, copyTarget)
                                        scope.launch { snackbars.showSnackbar(copiedText) }
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.jam_share_link)) },
                                    leadingIcon = { Icon(PqpIcons.Share, contentDescription = null) },
                                    onClick = {
                                        menu = false
                                        if (publicLink != null && shareMessage != null) {
                                            sendSongToSheet(context, songToShare?.title.orEmpty(), shareMessage, publicLink)
                                        } else {
                                            shareLink(context, link)
                                        }
                                    },
                                )
                                if (canEditSong) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.jam_edit_open)) },
                                        leadingIcon = { Icon(PqpIcons.Edit, contentDescription = null) },
                                        onClick = ::openEditor,
                                        modifier = Modifier.testTag("jam.song.editItem"),
                                    )
                                }
                                if (ui.state?.let { JamPermissions.canDeleteSong(it.viewer) } == true) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.jam_delete_song), color = MaterialTheme.colorScheme.error) },
                                        leadingIcon = {
                                            Icon(PqpIcons.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                                        },
                                        onClick = {
                                            menu = false
                                            confirmSong = true
                                        },
                                        modifier = Modifier.testTag("jam.song.delete"),
                                    )
                                }
                            }
                        }
                    },
                )
                ChromeDivider()
            }
        },
        bottomBar = {
            Column {
                // The editor's Save and its way out, pinned over the transport so they never scroll away.
                val editing = ui.adjust
                val storedTake = editing?.let { open -> ui.state?.tracks?.firstOrNull { it.id == open.trackId } }
                if (editing != null && storedTake != null) {
                    JamAdjustBar(track = storedTake, adjust = editing, onSave = model::adjustSave, onClose = model::adjustClose)
                }
            if (ui.phase == JamSongUi.Phase.Ready) {
                TransportBar(
                    model = model,
                    ui = ui,
                    onToggle = {
                        haptics.performHapticFeedback(if (ui.playing) HapticFeedbackType.ToggleOff else HapticFeedbackType.ToggleOn)
                        model.togglePlay()
                    },
                    onRecord = {
                        guarded {
                            // Whether, and why not, is the contract's: the flag, storage and what the server says this person may add.
                            val state = ui.state
                            val gate = state?.let { JamRecordRules.gate(config, it.song, it.viewer) }
                            val launch = if (gate == RecordGate.Open) model.studioLaunch() else null
                            when {
                                launch != null -> onRecord(launch)
                                gate is RecordGate.Blocked -> scope.launch { snackbars.showSnackbar(blockedText(gate.reason)) }
                                else -> scope.launch { snackbars.showSnackbar(gettingBandText) }
                            }
                        }
                    },
                )
            }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (ui.phase) {
                JamSongUi.Phase.Loading -> Column(Modifier.fillMaxSize().padding(Spacing.gutter)) {
                    if (seed != null) {
                        SongHeader(model, ui, seed, shared, Modifier.fillMaxWidth().aspectRatio(1.5f))
                    }
                    Spacer(Modifier.height(Spacing.xl))
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(26.dp), strokeWidth = 2.dp)
                    }
                }
                JamSongUi.Phase.Failed -> Message(stringResource(R.string.jam_song_failed), stringResource(R.string.jam_retry), model::load)
                JamSongUi.Phase.Gone -> Message(stringResource(R.string.jam_song_gone), null, {})
                JamSongUi.Phase.Ready -> SongBody(
                    model, ui, shared, viewerId,
                    flagOn = config.enabled,
                    onDeleteTrack = { confirmTrack = it },
                    // Opening another take's editor, or closing this one, with edits unsaved asks first.
                    onAdjust = { track, open -> guarded { if (open) model.adjustClose() else model.startAdjust(track) } },
                    pending = pending,
                    autoAccept = publication?.autoAcceptOutside == true,
                    requests = requests,
                )
            }
        }
    }

    requests.confirmDecline?.let { track ->
        JamDeclineDialog(track = track, enabled = requests.busy == null, onConfirm = model.requests::confirmDecline, onDismiss = model.requests::cancelDecline)
    }

    val sheetSong = ui.state?.song
    // Shown while it is open, whatever the flag says now: a flag that went off under a typed name is an error on the sheet,
    // never a sheet that vanishes with the name in it.
    if (editing && sheetSong != null) {
        JamEditSheet(
            song = sheetSong,
            editor = model.editor,
            onDismiss = {
                editing = false
                model.editor.close()
            },
        )
    }

    pendingAfterDiscard?.let { after ->
        AlertDialog(
            onDismissRequest = { pendingAfterDiscard = null },
            title = { Text(stringResource(R.string.jam_edit_discard_title)) },
            text = { Text(stringResource(R.string.jam_adjust_discard_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingAfterDiscard = null
                        model.adjustClose()
                        after()
                    },
                    modifier = Modifier.testTag("jam.adjust.discard"),
                ) { Text(stringResource(R.string.jam_edit_discard), color = MaterialTheme.colorScheme.error, softWrap = false) }
            },
            dismissButton = {
                TextButton(onClick = { pendingAfterDiscard = null }) { Text(stringResource(R.string.jam_edit_keep_editing)) }
            },
        )
    }

    if (confirmSong) {
        ConfirmDialog(
            title = stringResource(R.string.jam_delete_song_title),
            body = stringResource(R.string.jam_delete_song_body),
            onConfirm = {
                confirmSong = false
                model.deleteSong()
            },
            onDismiss = { confirmSong = false },
        )
    }
    confirmTrack?.let { track ->
        ConfirmDialog(
            title = stringResource(R.string.jam_delete_track_title),
            body = stringResource(R.string.jam_delete_track_body),
            onConfirm = {
                confirmTrack = null
                model.deleteTrack(track)
            },
            onDismiss = { confirmTrack = null },
        )
    }
}

@Composable
private fun noticeString(notice: JamNotice): String = stringResource(
    when (notice) {
        JamNotice.CallLive -> R.string.jam_notice_call
        JamNotice.NoFocus -> R.string.jam_notice_focus
        JamNotice.VoteFailed -> R.string.jam_notice_vote_failed
        JamNotice.MixFailed -> R.string.jam_notice_mix_failed
        JamNotice.DeleteFailed -> R.string.jam_notice_delete_failed
        JamNotice.PlaybackFailed -> R.string.jam_notice_playback_failed
    },
)

private fun copyLink(context: Context, link: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("pqp", link))
}

/** The system share sheet with the web's message and the song's public link: WhatsApp is one tap away. */
private fun sendSongToSheet(context: Context, title: String, message: String, url: String) {
    val send = Intent(Intent.ACTION_SEND)
        .setType("text/plain")
        .putExtra(Intent.EXTRA_SUBJECT, JamBidi.clean(title))
        .putExtra(Intent.EXTRA_TEXT, "$message $url")
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/**
 * What a shared song says, from what it is missing (the web's `useJamInviteMessage`): names are in the person's own
 * language, lower case, in a list ("baixo e voz"); the sender's own waiting parts are told and never asked for again.
 */
@Composable
fun jamShareMessage(song: JamSongSummary, pending: List<JamInstrument>): String {
    val needs = JamShare.stillNeeds(song, pending)
    val kind = JamShare.kind(song.joinMode, needs)
    val and = stringResource(R.string.jam_and)
    val title = JamBidi.clean(song.title)
    val list = joinList(needs.map { it.label() }, and)
    val mine = joinList(pending.map { it.label() }, and)
    val text = if (pending.isEmpty()) {
        when (kind) {
            JamShare.Kind.Needs -> pluralStringResource(R.plurals.jam_share_needs, needs.size, title, list)
            JamShare.Kind.Open -> stringResource(R.string.jam_share_open, title)
            JamShare.Kind.Listen -> stringResource(R.string.jam_share_listen, title)
        }
    } else {
        when (kind) {
            JamShare.Kind.Needs -> pluralStringResource(R.plurals.jam_share_sent_needs, needs.size, title, list, mine)
            JamShare.Kind.Open -> stringResource(R.string.jam_share_sent_open, title, mine)
            JamShare.Kind.Listen -> stringResource(R.string.jam_share_sent_listen, title, mine)
        }
    }
    return text.replace(Regex("\\s+"), " ").trim()
}

private fun shareLink(context: Context, link: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

@Composable
private fun Message(text: String, action: String?, onAction: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(Spacing.md))
            Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun ConfirmDialog(title: String, body: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("jam.confirm")) {
                Text(stringResource(R.string.jam_delete_confirm), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.jam_cancel)) } },
    )
}

// ------------------------------------------------------------------ body

@Composable
private fun SongBody(
    model: JamSongViewModel,
    ui: JamSongUi,
    shared: JamSharedScope?,
    viewerId: String?,
    flagOn: Boolean,
    onDeleteTrack: (JamTrack) -> Unit,
    /** The faders were tapped on [JamTrack]; true when that take's editor is the one open. */
    onAdjust: (JamTrack, Boolean) -> Unit,
    /** Parts from outside waiting for the starter's answer: they come first on the page, above the stage. */
    pending: List<JamTrack>,
    autoAccept: Boolean,
    requests: JamRequestsUi,
) {
    val state = ui.state ?: return
    val song = state.song
    val stack = ui.stack
    // A waiting part is a question, not an alternative take: it is listed in its own block, never twice.
    val pendingIds = remember(pending) { pending.mapTo(HashSet()) { it.id } }
    val others = ui.otherTakes.filter { it.id !in pendingIds }
    val reduce = rememberReduceMotion()
    // The one playhead is drawn across the lanes and NOT across an open adjust editor, which has a playhead of its own on a
    // different scale: where the editor sits is measured against the block, and the line skips it.
    var stackCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var editorRange by remember { mutableStateOf<ClosedFloatingPointRange<Float>?>(null) }
    LaunchedEffect(ui.adjust == null) { if (ui.adjust == null) editorRange = null }
    // An editor that opens below the fold is brought up to the top of the list once it has grown to its height, so it
    // is on screen where the finger just was (and a sibling's open editor, being replaced, is not left in the way).
    val listState = rememberLazyListState()
    var listCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var panelCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    LaunchedEffect(ui.adjust?.trackId) {
        if (ui.adjust == null) return@LaunchedEffect
        delay(if (reduce) 60 else 380)
        val list = listCoordinates
        val panel = panelCoordinates
        if (list != null && panel != null && list.isAttached && panel.isAttached) {
            val delta = panel.positionInRoot().y - list.positionInRoot().y - with(density) { 8.dp.toPx() }
            if (reduce) listState.scrollBy(delta) else listState.animateScrollBy(delta)
        }
    }

    // What waits for the starter is the first thing on the page, so anything that arrives or answers there is brought into
    // view: a part that lands while the list is scrolled down, an answer, a refused write. Never on the box leaving.
    var seenPending by remember { mutableStateOf(pending.size) }
    LaunchedEffect(pending.size, requests.answer?.trackId, requests.answer?.kind, requests.failure) {
        val arrived = pending.size > seenPending
        seenPending = pending.size
        val said = requests.answer != null || requests.failure != null
        if ((arrived || said) && (listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0)) {
            if (reduce) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        }
    }

    LazyColumn(
        state = listState,
        contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, top = Spacing.sm, bottom = Spacing.xl),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
        modifier = Modifier.fillMaxSize().onGloballyPositioned { listCoordinates = it }.testTag("jam.song.list"),
    ) {
        if (pending.isNotEmpty() || requests.answer != null) {
            item(key = "requests") {
                Column(Modifier.animateItem(), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                    JamRequestsBlock(
                        takes = pending,
                        autoAccept = autoAccept,
                        auditioning = ui.auditioning,
                        requests = requests,
                        onListen = { track ->
                            if (ui.auditioning[track.instrument] == track.id) model.stopAudition(track.instrument) else model.listen(track)
                        },
                        onAccept = model.requests::accept,
                        onDecline = model.requests::askDecline,
                    )
                    requests.answer?.let { answer ->
                        JamAnswerBox(
                            answer = answer,
                            busy = requests.busy != null,
                            failure = requests.failure?.takeIf { it.trackId == answer.trackId && it.action == JamRequestAction.Undo },
                            onUndo = model.requests::undo,
                            onDismiss = { model.requests.dismissAnswer(answer.trackId, answer.kind) },
                        )
                    }
                }
            }
        }
        item(key = "header") {
            SongHeader(model, ui, song, shared, Modifier.fillMaxWidth().aspectRatio(if (ui.videoTracks.isEmpty()) 1.5f else 16f / 9f))
        }
        item(key = "meta") { SongMeta(song, ui) }
        item(key = "tracks-title") { SectionTitle(stringResource(R.string.jam_tracks)) }
        item(key = "stack") {
            // One playhead across every stacked lane: a line over the whole block, drawn from the heard position.
            val playheadColor = MaterialTheme.colorScheme.primary
            Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
                modifier = Modifier
                    .onGloballyPositioned { stackCoordinates = it }
                    .drawWithContent {
                        drawContent()
                        val duration = ui.durationMs
                        if (duration > 0 && stack.isNotEmpty()) {
                            val x = JamPlayhead.x(model.positionMs, size.width, duration)
                            val color = playheadColor.copy(alpha = 0.9f)
                            val gap = editorRange
                            if (gap == null) {
                                drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 2.dp.toPx())
                            } else {
                                if (gap.start > 0f) drawLine(color, Offset(x, 0f), Offset(x, gap.start), strokeWidth = 2.dp.toPx())
                                if (gap.endInclusive < size.height) drawLine(color, Offset(x, gap.endInclusive), Offset(x, size.height), strokeWidth = 2.dp.toPx())
                            }
                        }
                    },
            ) {
                stack.forEach { track ->
                    androidx.compose.runtime.key(track.id) {
                        TrackRow(
                            model, ui, track, viewerId,
                            fresh = track.id in state.fresh,
                            reduce = reduce,
                            flagOn = flagOn,
                            onDelete = { onDeleteTrack(track) },
                            onAdjust = onAdjust,
                            onEditorBounds = { coordinates ->
                                panelCoordinates = coordinates
                                val block = stackCoordinates
                                if (block != null && block.isAttached && coordinates.isAttached) {
                                    val top = block.localPositionOf(coordinates, Offset.Zero).y
                                    val range = top..(top + coordinates.size.height)
                                    if (range != editorRange) editorRange = range
                                }
                            },
                        )
                    }
                }
            }
        }
        if (others.isNotEmpty()) {
            item(key = "others-title") {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    SectionTitle(stringResource(R.string.jam_other_takes))
                    Text(
                        stringResource(R.string.jam_other_takes_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(others, key = { "take-${it.id}" }) { track ->
                OtherTakeRow(model, ui, track, viewerId, flagOn = flagOn, onDelete = { onDeleteTrack(track) }, onAdjust = { onAdjust(track, false) }, modifier = Modifier.animateItem())
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        letterSpacing = androidx.compose.ui.unit.TextUnit(0.8f, androidx.compose.ui.unit.TextUnitType.Sp),
    )
}

/**
 * The card the wall's tile grows into. With video it is the stage: the stems'
 * pictures, muted and locked to the audio clock, under a scrim with the title.
 * Without, it is the instrument's colour with the mix's waveform in ink.
 */
@Composable
private fun SongHeader(
    model: JamSongViewModel,
    ui: JamSongUi,
    song: JamSongSummary,
    shared: JamSharedScope?,
    modifier: Modifier,
) {
    val tracks = ui.videoTracks
    val ground = jamGround(song)
    val reduce = rememberReduceMotion()
    val envelope = remember(ui.state?.tracks) { JamPeaks.mixEnvelope(ui.state?.tracks.orEmpty(), 64) }
    val draw = remember { Animatable(if (reduce) 1f else 0f) }
    LaunchedEffect(envelope.any { it > 0 }) {
        if (envelope.any { it > 0 } && draw.value < 1f) draw.animateTo(1f, tween(700, easing = FastOutSlowInEasing))
    }
    val shape = RoundedCornerShape(22.dp)
    // A cover is the picture of the song while no video is on stage: the plate and the waveform are under it until it
    // arrives (and stay if it cannot be had), and the playing video still wins the header, since that is the point of it.
    var coverStatus by remember(song.coverKey) { mutableStateOf(if (song.coverKey == null) JamCoverStatus.None else JamCoverStatus.Loading) }
    val hasCover = tracks.isEmpty() && coverStatus == JamCoverStatus.Ready
    Box(
        modifier
            .jamSongBounds(shared, song.id)
            .clip(shape)
            .background(if (tracks.isEmpty()) ground else Color.Black)
            .testTag("jam.song.header"),
    ) {
        if (tracks.isNotEmpty()) {
            VideoStage(model, ui)
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(0.55f to Color.Transparent, 1f to Color(0xD905080C)),
                ),
            )
        } else {
            if (song.coverKey != null) {
                JamCoverImage(song, onStatus = { coverStatus = it })
                if (hasCover) JamCoverScrim()
            }
            if (!hasCover) JamWaveform(
                values = envelope,
                color = JamInk.copy(alpha = 0.78f),
                playedColor = JamInk,
                played = { if (ui.durationMs > 0) (model.positionMs / ui.durationMs).toFloat() else 0f },
                draw = { draw.value },
                barWidthPx = 8f,
                gapPx = 6f,
                modifier = Modifier.fillMaxWidth().fillMaxSize(0.5f).padding(top = 20.dp, start = 18.dp, end = 18.dp),
            )
        }
        val textColor = if (tracks.isEmpty() && !hasCover) JamInk else Color.White
        Column(Modifier.align(Alignment.BottomStart).padding(16.dp)) {
            Text(
                text = JamBidi.clean(song.title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.ExtraBold,
                color = textColor,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("jam.song.title"),
            )
            val sub = listOfNotNull(
                JamNaming.drawn(song.artist, stringResource(R.string.jam_original)),
                JamNaming.drawn(song.authorName, stringResource(R.string.jam_deleted_account)),
            ).joinToString(JamNaming.SEPARATOR)
            Text(sub, style = MaterialTheme.typography.labelLarge, color = textColor.copy(alpha = 0.85f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun VideoStage(model: JamSongViewModel, ui: JamSongUi) {
    val tracks = ui.videoTracks
    val rows = tracks.chunked(2)
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        rows.forEach { row ->
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                row.forEach { track ->
                    val player = model.videoPlayer(track.id)
                    Box(Modifier.weight(1f).fillMaxSize().background(track.instrument.color().copy(alpha = 0.25f))) {
                        if (player != null) JamVideoSurface(player, Modifier.fillMaxSize())
                        Row(
                            Modifier.align(Alignment.TopStart).padding(8.dp).clip(RoundedCornerShape(50)).background(Color(0x99000000)).padding(horizontal = 8.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(track.instrument.icon(), contentDescription = null, tint = Color.White, modifier = Modifier.size(12.dp))
                            Text(
                                text = JamBidi.clean(track.authorName ?: track.instrument.title()),
                                style = MaterialTheme.typography.labelSmall,
                                color = Color.White,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                if (row.size == 1 && rows.size > 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun SongMeta(song: JamSongSummary, ui: JamSongUi) {
    val need = remember(song) { JamNeed.of(song) }
    val colors = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
        val callout = need.isCallout
        Text(
            text = need.text(),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (callout) colors.onPrimary else colors.onSurfaceVariant,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(if (callout) colors.primary else colors.surfaceContainerHigh)
                .padding(horizontal = Spacing.md, vertical = 5.dp)
                .testTag("jam.song.need"),
        )
        val names = remember(ui.state?.tracks) { ui.state?.tracks.orEmpty().mapNotNull { it.authorName }.distinct() }
        Text(
            text = JamWho.line(song, names.ifEmpty { null }, maxNames = 4),
            style = MaterialTheme.typography.labelLarge,
            color = colors.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// ------------------------------------------------------------------ tracks

@Composable
private fun TrackRow(
    model: JamSongViewModel,
    ui: JamSongUi,
    track: JamTrack,
    viewerId: String?,
    fresh: Boolean,
    reduce: Boolean,
    flagOn: Boolean,
    onDelete: () -> Unit,
    onAdjust: (JamTrack, Boolean) -> Unit,
    onEditorBounds: (LayoutCoordinates) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val state = ui.state ?: return
    val tint = track.instrument.color()
    val name = JamBidi.clean(track.authorName ?: track.instrument.title())
    val label = stringResource(R.string.jam_track_label, track.instrument.title(), name)
    val status = ui.stems[track.id] ?: JamStemStatus.Loading
    val audible = ui.audible(track.id)
    val muted = track.id in ui.muted
    val soloed = track.id in ui.soloed
    val auditioned = ui.auditioning[track.instrument] == track.id && !track.inMix
    var expanded by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    // The author's own take, with the flag on, is the only one that can be adjusted; the editor opens under its lane.
    val stored = state.tracks.firstOrNull { it.id == track.id } ?: track
    val canAdjust = JamEditPermissions.canAdjustTrack(stored, viewerId, flagOn)
    val adjusting = ui.adjust?.trackId == track.id
    val savedVolume = JamTrackEdit.volumeDelta(stored.gain)

    // Entrance: a row that arrives live slides up and fades in; at rest, nothing.
    val enter = remember { Animatable(if (reduce || !fresh) 1f else 0f) }
    LaunchedEffect(Unit) { if (enter.value < 1f) enter.animateTo(1f, spring(dampingRatio = 0.8f, stiffness = 300f)) }

    Column(
        Modifier
            .fillMaxWidth()
            .animateContentSize(spring(dampingRatio = 0.85f, stiffness = 380f))
            .graphicsLayer {
                alpha = enter.value
                translationY = (1f - enter.value) * 24.dp.toPx()
            }
            .testTag("jam.track.${track.id}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // The controls are the same four buttons wherever they sit: beside the title while the type is ordinary, and on a line
        // of their own under it once the type is big, where beside it they leave the title no room (it was "Gui..." at 2.0).
        val controls: @Composable () -> Unit = {
            SmallToggle(
                active = muted,
                onClick = { model.toggleMute(track.id) },
                description = stringResource(if (muted) R.string.jam_unmute else R.string.jam_mute, label),
                testTag = "jam.mute.${track.id}",
            ) {
                Icon(if (muted) PqpIcons.ServerMuted else PqpIcons.Speakerphone, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            SmallToggle(
                active = soloed,
                onClick = { model.toggleSolo(track.id) },
                description = stringResource(if (soloed) R.string.jam_unsolo else R.string.jam_solo, label),
                testTag = "jam.solo.${track.id}",
            ) {
                Text(stringResource(R.string.jam_solo_short), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            }
            if (canAdjust) {
                SmallToggle(
                    active = adjusting,
                    onClick = { onAdjust(stored, adjusting) },
                    description = stringResource(R.string.jam_adjust_open),
                    testTag = "jam.adjustOpen.${track.id}",
                ) {
                    Icon(PqpIcons.Adjust, contentDescription = null, modifier = Modifier.size(18.dp))
                }
            }
            VotePill(model, ui, track, haptics)
        
        }
        val bigType = LocalDensity.current.fontScale >= 1.4f
        if (bigType) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm + 2.dp)) {
                Box(
                    Modifier.size(40.dp).clip(CircleShape).background(tint).clickable { expanded = !expanded },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(track.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(20.dp))
                }
                Column(
                    Modifier.weight(1f).clickable { expanded = !expanded },
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    Text(
                        text = JamNaming.heading(track.instrument.title(), track.label),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = if (audible) colors.onSurface else colors.onSurfaceVariant,
                    )
                    Text(
                        // The author's saved volume, said on its own lane when it is not the recorded level (the web does too).
                        text = if (savedVolume != null) name + JamNaming.SEPARATOR + stringResource(R.string.jam_clip_saved_volume, savedVolume) else name,
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (auditioned) {
                        // Under the name and not beside the title: beside it the badge took the title's room.
                        Text(
                            text = stringResource(R.string.jam_auditioning),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            color = colors.onPrimary,
                            softWrap = false,
                            modifier = Modifier.padding(top = 2.dp).clip(RoundedCornerShape(50)).background(colors.primary).padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.xs), itemVerticalAlignment = Alignment.CenterVertically) {
                    controls()
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm + 2.dp)) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(tint).clickable { expanded = !expanded },
                contentAlignment = Alignment.Center,
            ) {
                Icon(track.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(20.dp))
            }
            Column(
                Modifier.weight(1f).clickable { expanded = !expanded },
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                Text(
                    text = JamNaming.heading(track.instrument.title(), track.label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (audible) colors.onSurface else colors.onSurfaceVariant,
                )
                Text(
                    // The author's saved volume, said on its own lane when it is not the recorded level (the web does too).
                    text = if (savedVolume != null) name + JamNaming.SEPARATOR + stringResource(R.string.jam_clip_saved_volume, savedVolume) else name,
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (auditioned) {
                    // Under the name and not beside the title: beside it the badge took the title's room.
                    Text(
                        text = stringResource(R.string.jam_auditioning),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = colors.onPrimary,
                        softWrap = false,
                        modifier = Modifier.padding(top = 2.dp).clip(RoundedCornerShape(50)).background(colors.primary).padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
                controls()
            }
        }

        Lane(model, ui, track, status, label)

        AnimatedVisibility(
            visible = adjusting,
            enter = if (reduce) EnterTransition.None else expandVertically(spring(stiffness = 500f)) + fadeIn(),
            exit = if (reduce) ExitTransition.None else shrinkVertically(spring(stiffness = 500f)) + fadeOut(),
        ) {
            val adjust = ui.adjust
            if (adjust != null && adjust.trackId == track.id) {
                JamAdjustPanel(
                    track = stored,
                    adjust = adjust,
                    band = JamMixRules.activeTracks(ui.liveTracks, ui.auditioning).filter { it.id != track.id },
                    originMs = ui.originMs,
                    position = { model.positionMs },
                    onTrimStart = model::adjustTrimStart,
                    onTrimEnd = model::adjustTrimEnd,
                    onNudge = model::adjustNudge,
                    onGainPercent = model::adjustGainPercent,
                    onReset = model::adjustReset,
                    modifier = Modifier.onGloballyPositioned(onEditorBounds),
                )
            }
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(spring(stiffness = 500f)) + fadeIn(),
            exit = shrinkVertically(spring(stiffness = 500f)) + fadeOut(),
        ) {
            ExpandedControls(model, ui, track, viewerId, state.viewer, label, auditioned, onDelete)
        }
    }
}

@Composable
private fun SmallToggle(
    active: Boolean,
    onClick: () -> Unit,
    description: String,
    testTag: String,
    content: @Composable () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val background by animateFloatAsState(if (active) 1f else 0f, spring(stiffness = 900f), label = "toggle")
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(
                androidx.compose.ui.graphics.lerp(colors.surfaceContainerHigh, colors.primary, background),
            )
            .clickable(onClick = onClick)
            .semantics { contentDescription = description; stateDescription = "" }
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides if (active) colors.onPrimary else colors.onSurfaceVariant,
        ) { content() }
    }
}

@Composable
private fun VotePill(
    model: JamSongViewModel,
    ui: JamSongUi,
    track: JamTrack,
    haptics: androidx.compose.ui.hapticfeedback.HapticFeedback,
) {
    val colors = MaterialTheme.colorScheme
    val voted = track.id in (ui.state?.viewer?.votedTrackIds.orEmpty())
    val description = stringResource(if (voted) R.string.jam_unvote else R.string.jam_vote, track.instrument.title()) +
        ", " + pluralStringResource(R.plurals.jam_votes, track.voteCount, track.voteCount)
    val scale = remember { Animatable(1f) }
    LaunchedEffect(voted) {
        if (voted) {
            scale.snapTo(0.8f)
            scale.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = 500f))
        }
    }
    Row(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(if (voted) colors.primary else colors.surfaceContainerHigh)
            .clickable {
                haptics.performHapticFeedback(if (voted) HapticFeedbackType.ToggleOff else HapticFeedbackType.Confirm)
                model.toggleVote(track)
            }
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .semantics { contentDescription = description }
            .testTag("jam.vote.${track.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            PqpIcons.Vote,
            contentDescription = null,
            tint = if (voted) colors.onPrimary else colors.onSurfaceVariant,
            modifier = Modifier.size(16.dp).scale(scale.value),
        )
        Text(
            text = track.voteCount.toString(),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Default,
            color = if (voted) colors.onPrimary else colors.onSurfaceVariant,
        )
    }
}

/**
 * One stem's waveform across the song's timeline: its slice where it plays, the
 * trimmed head and tail faded, the bars before the playhead in the instrument's
 * colour. Tap or drag to scrub. A stem still loading shows a pulse, one that
 * cannot play says so, and the rest of the mix carries on.
 */
@Composable
private fun Lane(
    model: JamSongViewModel,
    ui: JamSongUi,
    track: JamTrack,
    status: JamStemStatus,
    label: String,
) {
    val colors = MaterialTheme.colorScheme
    val tint = track.instrument.color()
    val audible = ui.audible(track.id)
    val density = LocalDensity.current
    var widthPx by remember { mutableStateOf(0) }
    val duration = ui.durationMs
    val origin = ui.originMs
    val startFraction = if (duration > 0) ((track.startMs - origin) / duration).coerceIn(0.0, 1.0).toFloat() else 0f
    val endFraction = if (duration > 0) ((track.endMs - origin) / duration).coerceIn(0.0, 1.0).toFloat() else 1f
    val bars = remember(track.peaks, track.offsetMs, track.trimStartMs, track.trimEndMs, track.durationMs) {
        JamPeaks.trackBars(track, 120)
    }
    val reduce = rememberReduceMotion()
    val draw = remember { Animatable(if (reduce) 1f else 0f) }
    LaunchedEffect(Unit) { if (draw.value < 1f) draw.animateTo(1f, tween(600, easing = FastOutSlowInEasing)) }

    val lastSeekNanos = remember { mutableLongStateOf(0L) }
    fun seekAt(x: Float, force: Boolean = false) {
        val now = System.nanoTime()
        if (!force && now - lastSeekNanos.longValue < 50_000_000L) return
        lastSeekNanos.longValue = now
        model.seekToX(x, widthPx.toFloat())
    }
    val currentSeek by rememberUpdatedState(::seekAt)

    Box(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surfaceContainer)
            .onSizeChanged { widthPx = it.width }
            .pointerInput(duration) {
                detectTapGestures { offset -> currentSeek(offset.x, true) }
            }
            .pointerInput(duration) {
                detectHorizontalDragGestures(
                    onDragStart = { offset -> currentSeek(offset.x, true) },
                    onHorizontalDrag = { change, _ ->
                        change.consume()
                        currentSeek(change.position.x, false)
                    },
                )
            }
            .semantics { contentDescription = label },
    ) {
        when (status) {
            JamStemStatus.Ready -> {
                val sliceWidthDp = with(density) { (widthPx * (endFraction - startFraction)).toDp() }
                Box(
                    Modifier
                        .padding(start = with(density) { (widthPx * startFraction).toDp() })
                        .width(sliceWidthDp)
                        .fillMaxSize()
                        .padding(vertical = 6.dp),
                ) {
                    JamWaveform(
                        values = bars,
                        color = tint.copy(alpha = if (audible) 0.55f else 0.2f),
                        playedColor = tint.copy(alpha = if (audible) 1f else 0.3f),
                        played = {
                            if (duration > 0 && endFraction > startFraction) {
                                val position = model.positionMs / duration
                                ((position - startFraction) / (endFraction - startFraction)).toFloat()
                            } else {
                                0f
                            }
                        },
                        draw = { draw.value },
                        barWidthPx = with(density) { 3.dp.toPx() },
                        gapPx = with(density) { 2.dp.toPx() },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            JamStemStatus.Loading -> LoadingPulse(tint)
            JamStemStatus.Unplayable -> Text(
                text = stringResource(R.string.jam_stem_unplayable),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterStart).padding(horizontal = Spacing.md),
            )
        }
    }
}

@Composable
private fun LoadingPulse(tint: Color) {
    val pulse = remember { Animatable(0.15f) }
    LaunchedEffect(Unit) {
        while (true) {
            pulse.animateTo(0.4f, tween(700))
            pulse.animateTo(0.15f, tween(700))
        }
    }
    Box(Modifier.fillMaxSize().padding(vertical = 18.dp, horizontal = 12.dp).clip(RoundedCornerShape(50)).background(tint.copy(alpha = pulse.value)))
}

@Composable
private fun ExpandedControls(
    model: JamSongViewModel,
    ui: JamSongUi,
    track: JamTrack,
    viewerId: String?,
    viewer: gg.pqp.app.jam.JamSongViewer,
    label: String,
    auditioned: Boolean,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Icon(PqpIcons.Speakerphone, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            val description = stringResource(R.string.jam_volume, label)
            Slider(
                value = ui.volume(track.id),
                onValueChange = { model.setVolume(track.id, it) },
                valueRange = 0f..1f,
                colors = SliderDefaults.colors(thumbColor = track.instrument.color(), activeTrackColor = track.instrument.color()),
                modifier = Modifier.weight(1f).semantics { contentDescription = description }.testTag("jam.volume.${track.id}"),
            )
        }
        // A row that wraps as whole buttons: no action ever disappears or breaks mid-word, at any width or type size.
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (JamPermissions.canSetMix(viewer)) {
                TextButton(onClick = { model.setInMix(track, !track.inMix) }, enabled = track.id !in ui.busy, modifier = Modifier.testTag("jam.mix.${track.id}")) {
                    Text(stringResource(if (track.inMix) R.string.jam_take_out_of_mix else R.string.jam_put_in_mix), softWrap = false)
                }
            }
            if (auditioned) {
                TextButton(onClick = { model.stopAudition(track.instrument) }) { Text(stringResource(R.string.jam_audition_stop), softWrap = false) }
            }
            if (JamPermissions.canDeleteTrack(track, viewer, viewerId)) {
                TextButton(onClick = onDelete, modifier = Modifier.testTag("jam.deleteTrack.${track.id}")) {
                    Text(stringResource(R.string.jam_delete_track), color = MaterialTheme.colorScheme.error, softWrap = false)
                }
            }
        }
    }
}

@Composable
private fun OtherTakeRow(
    model: JamSongViewModel,
    ui: JamSongUi,
    track: JamTrack,
    viewerId: String?,
    flagOn: Boolean,
    onDelete: () -> Unit,
    onAdjust: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val viewer = ui.state?.viewer ?: return
    val name = JamBidi.clean(track.authorName ?: track.instrument.title())
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.surfaceContainer)
            .padding(Spacing.md)
            .testTag("jam.other.${track.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm + 2.dp)) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(track.instrument.color()), contentAlignment = Alignment.Center) {
                Icon(track.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(18.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    JamNaming.heading(track.instrument.title(), track.label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(name, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            VotePill(model, ui, track, haptics)
        }
        // The actions wrap as whole buttons (a fixed row of four squeezed the last one out, or broke it a letter a line).
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedButton(onClick = { model.audition(track) }, modifier = Modifier.testTag("jam.audition.${track.id}")) {
                Icon(PqpIcons.Play, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.jam_audition), softWrap = false)
            }
            if (JamPermissions.canSetMix(viewer)) {
                TextButton(onClick = { model.setInMix(track, true) }, enabled = track.id !in ui.busy) {
                    Text(stringResource(R.string.jam_put_in_mix), softWrap = false)
                }
            }
            if (JamEditPermissions.canAdjustTrack(track, viewerId, flagOn)) {
                // Adjusting a take that is not in the mix means hearing it: it is listened to, and its lane opens in the stack.
                val adjustLabel = stringResource(R.string.jam_adjust_open)
                IconButton(
                    onClick = onAdjust,
                    modifier = Modifier.semantics { contentDescription = adjustLabel }.testTag("jam.adjustOpen.${track.id}"),
                ) { Icon(PqpIcons.Adjust, contentDescription = null, modifier = Modifier.size(20.dp)) }
            }
            if (JamPermissions.canDeleteTrack(track, viewer, viewerId)) {
                TextButton(onClick = onDelete, modifier = Modifier.testTag("jam.deleteTrack.${track.id}")) {
                    Text(stringResource(R.string.jam_delete_track), color = colors.error, softWrap = false)
                }
            }
        }
    }
}

// ------------------------------------------------------------------ transport

@Composable
private fun TransportBar(
    model: JamSongViewModel,
    ui: JamSongUi,
    onToggle: () -> Unit,
    onRecord: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val duration = ui.durationMs
    val seconds by remember { derivedStateOf { (model.positionMs / 1000).toInt() } }
    val clock = JamTime.clock(seconds * 1000.0)
    val total = JamTime.clock(duration)
    val description = stringResource(R.string.jam_position, clock, total)
    val canPlay = ui.ready && !ui.callLive
    val nothing = ui.phase == JamSongUi.Phase.Ready && !ui.preparing && !ui.ready

    Surface(color = colors.surfaceContainerLowest, tonalElevation = 0.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.navigationBarsPadding()) {
            ChromeDivider()
            // The scrub bar: a thin track the heard position fills, adjustable from TalkBack.
            ScrubBar(model, duration, description)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.sm + 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                val playLabel = stringResource(if (ui.playing) R.string.jam_pause else R.string.jam_play)
                val preparingLabel = stringResource(R.string.jam_preparing)
                Box(
                    Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(if (canPlay || ui.playing) colors.primary else colors.surfaceContainerHigh)
                        .clickable(enabled = canPlay || ui.playing, onClick = onToggle)
                        .clearAndSetSemantics {
                            contentDescription = if (ui.preparing) preparingLabel else playLabel
                            role = androidx.compose.ui.semantics.Role.Button
                        }
                        .testTag("jam.play"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (ui.preparing) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.5.dp, color = colors.onSurfaceVariant)
                    } else {
                        Crossfade(targetState = ui.playing, label = "play") { playing ->
                            Icon(
                                imageVector = if (playing) PqpIcons.Pause else PqpIcons.Play,
                                contentDescription = null,
                                tint = if (canPlay || playing) colors.onPrimary else colors.onSurfaceVariant,
                                modifier = Modifier.size(26.dp),
                            )
                        }
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "$clock / $total",
                        style = MaterialTheme.typography.titleSmall,
                        fontFamily = FontFamily.Monospace,
                        color = colors.onSurface,
                        softWrap = false,
                        maxLines = 1,
                        modifier = Modifier.clearAndSetSemantics { },
                    )
                    val hint = when {
                        ui.preparing -> stringResource(R.string.jam_preparing)
                        ui.callLive -> stringResource(R.string.jam_notice_call)
                        nothing -> stringResource(R.string.jam_nothing_playable)
                        else -> null
                    }
                    if (hint != null) {
                        Text(hint, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 2)
                    }
                }
                // Where the real record button will go: honest about where recording is, never dead.
                val recordLabel = stringResource(R.string.jam_record)
                if (LocalDensity.current.fontScale >= 1.4f) {
                    // Big type: the label would squeeze the clock, so the button is its glyph, still named for TalkBack.
                    androidx.compose.material3.OutlinedIconButton(onClick = onRecord, modifier = Modifier.testTag("jam.record")) {
                        Icon(PqpIcons.Mic, contentDescription = recordLabel)
                    }
                } else {
                    OutlinedButton(onClick = onRecord, modifier = Modifier.testTag("jam.record")) {
                        Icon(PqpIcons.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(recordLabel, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun ScrubBar(model: JamSongViewModel, durationMs: Double, description: String) {
    val colors = MaterialTheme.colorScheme
    var widthPx by remember { mutableStateOf(0) }
    val lastSeek = remember { mutableLongStateOf(0L) }
    Box(
        Modifier
            .fillMaxWidth()
            .height(20.dp)
            .onSizeChanged { widthPx = it.width }
            .pointerInput(durationMs) {
                detectTapGestures { offset -> model.seekToX(offset.x, widthPx.toFloat()) }
            }
            .pointerInput(durationMs) {
                detectHorizontalDragGestures(
                    onDragStart = { offset -> model.seekToX(offset.x, widthPx.toFloat()) },
                    onHorizontalDrag = { change, _ ->
                        change.consume()
                        val now = System.nanoTime()
                        if (now - lastSeek.longValue > 50_000_000L) {
                            lastSeek.longValue = now
                            model.seekToX(change.position.x, widthPx.toFloat())
                        }
                    },
                )
            }
            .semantics {
                contentDescription = description
                progressBarRangeInfo = ProgressBarRangeInfo((model.positionMs / 1000).toFloat(), 0f..(durationMs / 1000).toFloat().coerceAtLeast(1f))
                setProgress { target ->
                    model.seekTo(target * 1000.0)
                    true
                }
            }
            .testTag("jam.scrub"),
        contentAlignment = Alignment.TopStart,
    ) {
        Box(Modifier.fillMaxWidth().height(3.dp).background(colors.surfaceContainerHigh))
        Box(
            Modifier
                .height(3.dp)
                .fillMaxWidth()
                .drawWithContent {
                    val fraction = if (durationMs > 0) (model.positionMs / durationMs).toFloat().coerceIn(0f, 1f) else 0f
                    drawRect(colors.primary, size = androidx.compose.ui.geometry.Size(size.width * fraction, size.height))
                },
        )
    }
}
