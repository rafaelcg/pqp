package gg.pqp.app.jam.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.semantics.onClick
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamPeaks
import gg.pqp.app.jam.record.CutReason
import gg.pqp.app.jam.record.JamStudioUi
import gg.pqp.app.jam.record.JamStudioViewModel
import gg.pqp.app.jam.record.JamTakeEdit
import gg.pqp.app.jam.record.MeasureMethod
import gg.pqp.app.jam.record.PostFailure
import gg.pqp.app.jam.record.PostStage
import gg.pqp.app.jam.record.RouteKind
import gg.pqp.app.jam.record.StudioBlock
import gg.pqp.app.jam.record.StudioLane
import gg.pqp.app.jam.record.StudioNotice
import gg.pqp.app.jam.record.StudioPhase
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/*
 * THE STUDIO. A full screen over the song (or the wall, for a first take), built
 * like a music app and not a form: the band's lanes are always on screen, one
 * big red button does the thing, the clock is large, and everything that is not
 * the next step stays out of the way.
 *
 *   setup   what you play, the headphones, the count-in, a red button
 *   count   four big beats on the band's lanes
 *   record  a clock the size of the screen, the band moving, your lane growing
 *   review  your lane among theirs, play/pause with the band, nudge, send
 *
 * The logic is `JamStudioViewModel`; this file only draws it and hands taps back.
 * The words are the web studio's (`jam.studio.*`), in tu.
 */

private val RecordRed = Color(0xFFFF3B47)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JamStudioScreen(
    model: JamStudioViewModel,
    songTitle: String?,
    isNewSong: Boolean,
    onClose: () -> Unit,
    onOpenSong: (String) -> Unit,
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbars = remember { SnackbarHostState() }
    var leaveAsk by remember { mutableStateOf(false) }

    // Leaving the app ends a recording (a microphone cannot be held in the background) and keeps what was played.
    LifecycleStartEffect(model) {
        onStopOrDispose { model.onBackgrounded() }
    }

    // The microphone: asked for when the studio opens (the person just pressed "Gravar minha parte"), and again on request.
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.onMicPermission(granted)
    }
    LaunchedEffect(Unit) {
        val held = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        model.onMicPermission(held)
        if (!held) launcher.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun close() {
        when (model.leaveRisk()) {
            JamStudioViewModel.LeaveRisk.None -> {
                model.keepAndClose()
                onClose()
            }
            else -> leaveAsk = true
        }
    }
    BackHandler { close() }

    val snackText = ui.notice?.let { noticeText(it) }
    LaunchedEffect(ui.notice) {
        // The notices that are a banner in the screen stay there; the rest are said once.
        if (snackText != null && ui.notice != StudioNotice.Restored) {
            snackbars.showSnackbar(snackText)
            model.dismissNotice()
        }
    }

    Surface(Modifier.fillMaxSize().testTag("jam.studio"), color = MaterialTheme.colorScheme.surface) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.surface,
            snackbarHost = { SnackbarHost(snackbars) },
            topBar = {
                Column {
                    TopAppBar(
                        colors = pqpTopBarColors(),
                        navigationIcon = {
                            IconButton(onClick = ::close, modifier = Modifier.testTag("jam.studio.close")) {
                                Icon(PqpIcons.Close, contentDescription = stringResource(R.string.jam_back))
                            }
                        },
                        title = {
                            Column {
                                Text(
                                    stringResource(R.string.jam_rec_title),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                )
                                Text(
                                    songTitle?.takeIf { it.isNotBlank() } ?: stringResource(R.string.jam_rec_new_song),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        },
                    )
                    ChromeDivider()
                }
            },
            bottomBar = { StudioBottomBar(model, ui, onOpenSong) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (ui.phase) {
                    StudioPhase.Setup, StudioPhase.Measuring -> SetupBody(model, ui, launcher::launch)
                    StudioPhase.Countdown, StudioPhase.Recording -> RecordingBody(model, ui)
                    StudioPhase.Review -> ReviewBody(model, ui)
                    StudioPhase.Posting -> PostingBody(ui)
                    StudioPhase.Done -> DoneBody(ui, isNew = isNewSong)
                }
            }
        }
    }

    if (leaveAsk) {
        LeaveDialog(
            risk = model.leaveRisk(),
            onStay = { leaveAsk = false },
            onKeep = {
                leaveAsk = false
                model.keepAndClose()
                onClose()
            },
            onDiscard = {
                leaveAsk = false
                model.discardAndClose()
                onClose()
            },
        )
    }
}

// ------------------------------------------------------------------ strings

@Composable
private fun noticeText(notice: StudioNotice): String? = when (notice) {
    StudioNotice.CutEmpty -> stringResource(R.string.jam_rec_cut_empty)
    StudioNotice.NoFocus -> stringResource(R.string.jam_notice_focus)
    StudioNotice.MeasureSaved -> stringResource(R.string.jam_rec_measure_saved)
    StudioNotice.NudgeSaved -> stringResource(R.string.jam_rec_nudge_saved)
    StudioNotice.PlaybackFailed -> stringResource(R.string.jam_notice_playback_failed)
    StudioNotice.SaveFailed -> stringResource(R.string.jam_rec_save_failed)
    StudioNotice.Restored -> stringResource(R.string.jam_rec_restored)
    StudioNotice.CutKept, StudioNotice.MeasureFailed -> null
}

@Composable
private fun cutText(reason: CutReason): String = stringResource(
    when (reason) {
        CutReason.Focus -> R.string.jam_rec_cut_focus
        CutReason.Unplugged -> R.string.jam_rec_cut_unplugged
        CutReason.Background -> R.string.jam_rec_cut_background
        CutReason.Call -> R.string.jam_rec_cut_call
        CutReason.Mic -> R.string.jam_rec_cut_mic
        CutReason.Route -> R.string.jam_rec_cut_route
        CutReason.Silenced -> R.string.jam_rec_cut_silenced
        CutReason.Died -> R.string.jam_rec_cut_died
    },
)

@Composable
private fun failureText(failure: PostFailure): String = stringResource(
    when (failure) {
        PostFailure.Off -> R.string.jam_rec_err_off
        PostFailure.Closed -> R.string.jam_rec_err_closed
        PostFailure.InstrumentNotWanted -> R.string.jam_rec_err_instrument_not_wanted
        PostFailure.SongFull -> R.string.jam_rec_err_song_full
        PostFailure.AuthorLimit -> R.string.jam_rec_err_author_limit
        PostFailure.TooLarge -> R.string.jam_rec_err_too_large
        PostFailure.StorageOff -> R.string.jam_rec_err_storage_off
        PostFailure.RateLimited -> R.string.jam_rec_err_rate_limited
        PostFailure.Network -> R.string.jam_rec_err_network
        PostFailure.Gone -> R.string.jam_rec_err_gone
        PostFailure.Other -> R.string.jam_rec_err_other
    },
)

private fun clock(ms: Long): String {
    val tenths = (ms / 100).toInt()
    val seconds = tenths / 10
    return "%d:%02d.%d".format(seconds / 60, seconds % 60, tenths % 10)
}

// ------------------------------------------------------------------ the bottom bar

@Composable
private fun StudioBottomBar(model: JamStudioViewModel, ui: JamStudioUi, onOpenSong: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    Surface(color = colors.surfaceContainerLowest, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.navigationBarsPadding()) {
            ChromeDivider()
            when (ui.phase) {
                StudioPhase.Setup, StudioPhase.Measuring -> Column(
                    Modifier.fillMaxWidth().padding(vertical = Spacing.md),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    RecordButton(
                        recording = false,
                        enabled = ui.canRecord,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.ToggleOn)
                            model.record()
                        },
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        stringResource(R.string.jam_rec_hit),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (ui.canRecord) colors.onSurface else colors.onSurfaceVariant,
                    )
                }
                StudioPhase.Countdown, StudioPhase.Recording -> Column(
                    Modifier.fillMaxWidth().padding(vertical = Spacing.md),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    RecordButton(
                        recording = true,
                        enabled = true,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.ToggleOff)
                            model.stop()
                        },
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(stringResource(R.string.jam_rec_stop), style = MaterialTheme.typography.labelLarge, color = colors.onSurface)
                }
                StudioPhase.Review -> Column(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.md),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    val blocked = ui.postFatal
                    Button(
                        onClick = { model.send() },
                        enabled = !blocked,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("jam.studio.send"),
                    ) {
                        Text(
                            stringResource(if (ui.silent) R.string.jam_rec_send_anyway else R.string.jam_rec_send),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    OutlinedButton(
                        onClick = { model.recordAgain() },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("jam.studio.again"),
                    ) { Text(stringResource(R.string.jam_rec_again)) }
                    if (blocked) {
                        TextButton(onClick = { model.discardAndClose() }, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.jam_rec_discard))
                        }
                    }
                }
                StudioPhase.Posting -> Spacer(Modifier.height(Spacing.md))
                StudioPhase.Done -> Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.md)) {
                    Button(
                        onClick = { ui.sentSongId?.let(onOpenSong) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("jam.studio.view"),
                    ) { Text(stringResource(R.string.jam_rec_done_view), fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

/**
 * The red button, the one thing on the screen. A ring and a disc; while recording the disc becomes the stop square and
 * a soft ring breathes around it (still under "remove animations").
 */
@Composable
private fun RecordButton(recording: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val reduce = rememberReduceMotion()
    val colors = MaterialTheme.colorScheme
    val corner by animateDpAsState(if (recording) 8.dp else 36.dp, tween(if (reduce) 0 else 220), label = "rec-corner")
    val inner by animateDpAsState(if (recording) 36.dp else 68.dp, tween(if (reduce) 0 else 220), label = "rec-inner")
    val breathe = rememberInfiniteTransition(label = "rec-breathe")
    val ring by breathe.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart),
        label = "rec-ring",
    )
    val label = stringResource(if (recording) R.string.jam_rec_stop else R.string.jam_rec_hit)
    Box(
        Modifier
            .size(96.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            }
            .testTag(if (recording) "jam.studio.stop" else "jam.studio.record"),
        contentAlignment = Alignment.Center,
    ) {
        if (recording && !reduce) {
            Box(
                Modifier
                    .size(96.dp)
                    .scale(0.8f + 0.2f * ring)
                    .alpha(0.5f * (1f - ring))
                    .border(3.dp, RecordRed, CircleShape),
            )
        }
        Box(
            Modifier
                .size(84.dp)
                .border(BorderStroke(4.dp, if (enabled) colors.onSurface else colors.onSurface.copy(alpha = 0.3f)), CircleShape),
        )
        Box(
            Modifier
                .size(inner)
                .clip(RoundedCornerShape(corner))
                .background(if (enabled) RecordRed else RecordRed.copy(alpha = 0.3f)),
        )
    }
}

// ------------------------------------------------------------------ setup

@Composable
private fun SetupBody(model: JamStudioViewModel, ui: JamStudioUi, askMic: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    var measureOpen by remember { mutableStateOf(false) }
    LaunchedEffect(ui.calibration) { if (ui.calibration != null) measureOpen = false }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.lg),
    ) {
        SectionLabel(stringResource(R.string.jam_rec_band))
        if (ui.lanes.isEmpty()) {
            Text(
                stringResource(R.string.jam_rec_alone),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(colors.surfaceContainer)
                    .padding(Spacing.lg),
            )
        } else {
            BandLanes(ui.lanes, ui.originMs, ui.durationMs, playhead = null)
        }

        if (ui.block != null) {
            BlockCard(ui.block, askMic)
        } else {
            SectionLabel(stringResource(R.string.jam_rec_what))
            InstrumentPicker(model, ui)

            SectionLabel(stringResource(R.string.jam_rec_title))
            RouteSection(model, ui, measureOpen, onMeasureOpen = { measureOpen = it })
            CountInRow(model, ui)
        }
        Spacer(Modifier.height(Spacing.sm))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        letterSpacing = 0.8.sp,
        modifier = Modifier.semantics { heading() },
    )
}

@Composable
private fun InstrumentPicker(model: JamStudioViewModel, ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    val addable = model.addable
    val wanted = model.wanted
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        JamInstrument.entries.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.fillMaxWidth()) {
                row.forEach { instrument ->
                    val enabled = instrument in addable
                    val selected = ui.instrument == instrument
                    val tint = instrument.color()
                    val name = instrument.title()
                    Column(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 76.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(if (selected) tint else colors.surfaceContainer)
                            .then(if (selected) Modifier else Modifier.border(1.dp, colors.outlineVariant, RoundedCornerShape(16.dp)))
                            .alpha(if (enabled) 1f else 0.38f)
                            .clickable(enabled = enabled) { model.pickInstrument(instrument) }
                            .semantics { role = Role.RadioButton; contentDescription = name }
                            .padding(vertical = Spacing.sm),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Icon(instrument.icon(), contentDescription = null, tint = if (selected) JamInk else tint, modifier = Modifier.size(28.dp))
                        Spacer(Modifier.height(4.dp))
                        Text(
                            name,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                            color = if (selected) JamInk else colors.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (instrument in wanted) {
                            Text(
                                stringResource(R.string.jam_rec_wanted),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (selected) JamInk.copy(alpha = 0.8f) else colors.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(horizontal = 4.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RouteSection(model: JamStudioViewModel, ui: JamStudioUi, measureOpen: Boolean, onMeasureOpen: (Boolean) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val route = ui.route
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        // What is plugged in, and what that means for the take.
        val kindText = stringResource(
            when (route?.outputKind) {
                RouteKind.Wired -> R.string.jam_rec_route_wired
                RouteKind.Bluetooth -> R.string.jam_rec_route_bluetooth
                RouteKind.Speaker -> R.string.jam_rec_route_speaker
                else -> R.string.jam_rec_route_other
            },
        )
        val calibration = ui.calibration
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(colors.surfaceContainer)
                .padding(horizontal = Spacing.md, vertical = Spacing.sm + 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            Icon(
                if (route?.bleeds == true) PqpIcons.Speakerphone else PqpIcons.Listening,
                contentDescription = null,
                tint = if (route?.bleeds == true || ui.bluetooth) colors.error else colors.primary,
                modifier = Modifier.size(24.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(kindText, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Text(
                    if (calibration != null) {
                        stringResource(R.string.jam_rec_measured, calibration.correctionMs.roundToInt())
                    } else {
                        stringResource(R.string.jam_rec_not_measured)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = if (calibration != null) colors.primary else colors.onSurfaceVariant,
                    modifier = Modifier.testTag("jam.studio.routeStatus"),
                )
            }
            if (calibration != null && !measureOpen && ui.measuring == null) {
                TextButton(onClick = { onMeasureOpen(true) }, modifier = Modifier.testTag("jam.studio.remeasure")) {
                    Text(stringResource(R.string.jam_rec_measure_again), maxLines = 1)
                }
            }
        }
        if (ui.bleeds) {
            Warning(stringResource(R.string.jam_rec_speaker_title), stringResource(R.string.jam_rec_speaker_body))
        } else if (ui.bluetooth) {
            Warning(null, stringResource(R.string.jam_rec_bluetooth_body))
        }
        if (ui.measuring != null) {
            MeasuringPanel(model, ui.measuring)
        } else if (calibration == null || measureOpen) {
            MeasureCard(model, ui, onDismiss = if (calibration != null) ({ onMeasureOpen(false) }) else null)
        }
    }
}

@Composable
private fun Warning(title: String?, body: String) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.errorContainer.copy(alpha = 0.5f))
            .padding(Spacing.md),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Icon(PqpIcons.Warning, contentDescription = null, tint = colors.error, modifier = Modifier.size(20.dp))
        Column {
            if (title != null) Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text(body, style = MaterialTheme.typography.bodySmall, color = colors.onSurface)
        }
    }
}

@Composable
private fun MeasureCard(model: JamStudioViewModel, ui: JamStudioUi, onDismiss: (() -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    var manual by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(colors.surfaceContainer)
            .border(1.dp, colors.primary.copy(alpha = 0.5f), RoundedCornerShape(20.dp))
            .padding(Spacing.lg)
            .testTag("jam.studio.measureCard"),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Text(stringResource(R.string.jam_rec_measure_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.jam_rec_measure_body), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        if (ui.measureFailed) {
            Text(
                stringResource(R.string.jam_rec_measure_failed),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Button(
            onClick = { model.measure(MeasureMethod.Loopback) },
            enabled = ui.micGranted && ui.block == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("jam.studio.measureLoopback"),
        ) { Text(stringResource(R.string.jam_rec_measure_now), fontWeight = FontWeight.Bold) }
        Text(stringResource(R.string.jam_rec_measure_now_hint), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        OutlinedButton(
            onClick = { model.measure(MeasureMethod.TapAlong) },
            enabled = ui.micGranted && ui.block == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("jam.studio.measureTap"),
        ) { Text(stringResource(R.string.jam_rec_measure_tap)) }
        Text(stringResource(R.string.jam_rec_measure_tap_hint), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = { manual = true }, modifier = Modifier.testTag("jam.studio.manual")) {
                Text(stringResource(R.string.jam_rec_manual))
            }
            if (onDismiss != null) TextButton(onClick = onDismiss) { Text(stringResource(R.string.jam_cancel)) }
        }
    }
    if (manual) ManualDialog(onUse = { model.setManualCorrection(it); manual = false }, onDismiss = { manual = false })
}

@Composable
private fun ManualDialog(onUse: (Double) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    val value = text.replace(',', '.').toDoubleOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.jam_rec_manual_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(stringResource(R.string.jam_rec_manual_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.take(7) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.testTag("jam.studio.manualField"),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { value?.let(onUse) },
                enabled = value != null && abs(value) <= 500,
                modifier = Modifier.testTag("jam.studio.manualUse"),
            ) { Text(stringResource(R.string.jam_rec_manual_use)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.jam_cancel)) } },
    )
}

/** Listening: rings spreading from the middle while the phone plays and hears. */
@Composable
private fun MeasuringPanel(model: JamStudioViewModel, method: MeasureMethod) {
    val colors = MaterialTheme.colorScheme
    val reduce = rememberReduceMotion()
    val transition = rememberInfiniteTransition(label = "measuring")
    val wave by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1600), RepeatMode.Restart), label = "wave")
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(colors.surfaceContainer)
            .padding(Spacing.lg)
            .testTag("jam.studio.measuring"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) {
            if (!reduce) {
                repeat(2) { i ->
                    val p = (wave + i * 0.5f) % 1f
                    Box(Modifier.size(96.dp).scale(0.35f + 0.65f * p).alpha(1f - p).border(2.dp, colors.primary, CircleShape))
                }
            }
            Icon(PqpIcons.Mic, contentDescription = null, tint = colors.primary, modifier = Modifier.size(32.dp))
        }
        Text(
            stringResource(if (method == MeasureMethod.Loopback) R.string.jam_rec_measuring_loopback else R.string.jam_rec_measuring_tap),
            style = MaterialTheme.typography.titleSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        TextButton(onClick = model::cancelMeasure) { Text(stringResource(R.string.jam_cancel)) }
    }
}

@Composable
private fun CountInRow(model: JamStudioViewModel, ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    val on = ui.countInBars > 0
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surfaceContainer).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.jam_rec_count_in), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Text(stringResource(R.string.jam_rec_count_in_hint), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            }
            androidx.compose.material3.Switch(
                checked = on,
                onCheckedChange = { model.setCountIn(if (it) 1 else 0) },
                modifier = Modifier.testTag("jam.studio.countIn"),
            )
        }
        if (on) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                StepButton("-", stringResource(R.string.jam_rec_bpm_slower)) { model.setBpm(ui.bpm - 5) }
                Text(
                    stringResource(R.string.jam_rec_bpm, ui.bpm),
                    style = MaterialTheme.typography.titleMedium,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.width(96.dp),
                )
                StepButton("+", stringResource(R.string.jam_rec_bpm_faster)) { model.setBpm(ui.bpm + 5) }
            }
        }
    }
}

@Composable
private fun StepButton(symbol: String, description: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(onClick = onClick)
            .semantics { contentDescription = description; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) { Text(symbol, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
}

/** A hold waits this long before it repeats, so a tap stays one step, and then repeats this often. */
private const val HOLD_DELAY_NS = 400_000_000L
private const val REPEAT_NS = 90_000_000L

@Composable
private fun BlockCard(block: StudioBlock, askMic: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val (title, body) = when (block) {
        StudioBlock.InCall -> R.string.jam_rec_in_call_title to R.string.jam_rec_in_call_body
        StudioBlock.MicDenied -> R.string.jam_rec_mic_denied_title to R.string.jam_rec_mic_denied_body
        StudioBlock.MicBusy -> R.string.jam_rec_mic_denied_title to R.string.jam_rec_mic_busy
        StudioBlock.OutputFailed -> R.string.jam_rec_mic_denied_title to R.string.jam_rec_output_failed
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(colors.surfaceContainer)
            .padding(Spacing.lg)
            .testTag("jam.studio.block.${block.name}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Text(
            stringResource(if (block == StudioBlock.InCall || block == StudioBlock.MicDenied) title else R.string.jam_rec_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(stringResource(body), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        if (block == StudioBlock.MicDenied) {
            Button(onClick = { askMic(Manifest.permission.RECORD_AUDIO) }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.jam_rec_allow_mic))
            }
            OutlinedButton(
                onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.jam_rec_open_settings)) }
        }
    }
}

// ------------------------------------------------------------------ the band's lanes

/**
 * The band, one row per track, all on the same timeline. [playhead] is read in the draw phase (a fraction of the
 * timeline, or null for none), so a clock moving thirty times a second repaints the lines and recomposes nothing.
 */
@Composable
private fun BandLanes(
    lanes: List<StudioLane>,
    originMs: Double,
    durationMs: Double,
    playhead: (() -> Float?)?,
    onSeek: ((Float) -> Unit)? = null,
    live: (@Composable () -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("jam.studio.lanes")) {
        lanes.forEach { lane ->
            androidx.compose.runtime.key(lane.id) {
                LaneRow(lane, originMs, durationMs, playhead, onSeek)
            }
        }
        live?.invoke()
    }
}

@Composable
private fun LaneRow(lane: StudioLane, originMs: Double, durationMs: Double, playhead: (() -> Float?)?, onSeek: ((Float) -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    val tint = lane.instrument.color()
    val reduce = rememberReduceMotion()
    val track = lane.track
    val bars = remember(track.peaks, track.offsetMs, track.trimStartMs, track.durationMs) { JamPeaks.trackBars(track, 120) }
    val start = if (durationMs > 0) ((track.startMs - originMs) / durationMs).coerceIn(0.0, 1.0).toFloat() else 0f
    val end = if (durationMs > 0) ((track.endMs - originMs) / durationMs).coerceIn(0.0, 1.0).toFloat() else 1f
    val draw = remember(lane.id) { Animatable(if (reduce || lane.mine) 1f else 0f) }
    LaunchedEffect(lane.id) { if (draw.value < 1f) draw.animateTo(1f, tween(600, easing = FastOutSlowInEasing)) }
    var width by remember { mutableIntStateOf(0) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val label = stringResource(R.string.jam_track_label, lane.instrument.title(), lane.name ?: stringResource(R.string.jam_rec_you))
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(tint), contentAlignment = Alignment.Center) {
            Icon(lane.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(18.dp))
        }
        Box(
            Modifier
                .weight(1f)
                .height(48.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (lane.mine) tint.copy(alpha = 0.16f) else colors.surfaceContainer)
                .then(if (lane.mine) Modifier.border(2.dp, tint, RoundedCornerShape(12.dp)) else Modifier)
                .onSizeChanged { width = it.width }
                .then(
                    if (onSeek != null) {
                        Modifier
                            .pointerInput(durationMs) { detectTapGestures { onSeek(it.x / width.coerceAtLeast(1)) } }
                            .pointerInput(durationMs) {
                                detectHorizontalDragGestures(onDragStart = { onSeek(it.x / width.coerceAtLeast(1)) }) { change, _ ->
                                    change.consume()
                                    onSeek(change.position.x / width.coerceAtLeast(1))
                                }
                            }
                    } else {
                        Modifier
                    },
                )
                .drawWithContent {
                    drawContent()
                    val at = playhead?.invoke()
                    if (at != null) {
                        val x = (at * size.width).coerceIn(0f, size.width)
                        drawLine(colors.primary, Offset(x, 0f), Offset(x, size.height), strokeWidth = 2.dp.toPx())
                    }
                }
                .semantics { contentDescription = label },
        ) {
            Box(
                Modifier
                    .padding(start = with(density) { (width * start).toDp() })
                    .width(with(density) { (width * (end - start)).toDp() })
                    .fillMaxSize()
                    .padding(vertical = 6.dp),
            ) {
                JamWaveform(
                    values = bars,
                    color = tint,
                    draw = { draw.value },
                    barWidthPx = with(density) { 3.dp.toPx() },
                    gapPx = with(density) { 2.dp.toPx() },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Text(
                text = lane.name ?: stringResource(R.string.jam_rec_you),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = colors.onSurface.copy(alpha = 0.85f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 2.dp).width(96.dp),
            )
        }
    }
}

// ------------------------------------------------------------------ count-in and recording

@Composable
private fun RecordingBody(model: JamStudioViewModel, ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    val reduce = rememberReduceMotion()
    val tint = ui.instrument.color()
    // The microphone's level is read once per frame, while the screen is on, and only repaints its bar.
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { while (true) withFrameNanos { frame = it.hashCode() } }
    val counting = ui.phase == StudioPhase.Countdown
    val duration = ui.durationMs
    // A take longer than the band keeps its lane on screen: the timeline stretches to hold it.
    fun scaleMs() = max(max(duration, 20_000.0), model.transportMs * 1.15)

    Column(
        Modifier.fillMaxSize().padding(horizontal = Spacing.gutter, vertical = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.lg),
    ) {
        Column(Modifier.fillMaxWidth().weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (counting) {
                Text(
                    stringResource(R.string.jam_rec_get_ready).uppercase(),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = colors.onSurfaceVariant,
                    letterSpacing = 1.sp,
                )
                Spacer(Modifier.height(Spacing.sm))
                val beat = ui.beat
                val pop = remember { Animatable(1f) }
                LaunchedEffect(beat) {
                    if (!reduce && beat > 0) {
                        pop.snapTo(1.3f)
                        pop.animateTo(1f, spring(dampingRatio = 0.5f, stiffness = 400f))
                    }
                }
                val beatLabel = stringResource(R.string.jam_rec_beat, beat, ui.beats)
                Text(
                    text = if (beat == 0) "" else beat.toString(),
                    fontSize = 132.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = tint,
                    modifier = Modifier
                        .graphicsLayer { scaleX = pop.value; scaleY = pop.value }
                        .semantics { contentDescription = beatLabel; liveRegion = LiveRegionMode.Polite }
                        .testTag("jam.studio.beat"),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(ui.beats) { i ->
                        Box(Modifier.size(12.dp).clip(CircleShape).background(if (i < beat) tint else colors.surfaceContainerHigh))
                    }
                }
            } else {
                RecDot(reduce)
                Spacer(Modifier.height(Spacing.sm))
                val time = clock(ui.elapsedMs)
                val timeLabel = stringResource(R.string.jam_rec_time, time)
                Text(
                    text = time,
                    fontSize = 68.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = colors.onSurface,
                    softWrap = false,
                    maxLines = 1,
                    modifier = Modifier.clearAndSetSemantics { contentDescription = timeLabel }.testTag("jam.studio.timer"),
                )
                Spacer(Modifier.height(Spacing.sm))
                MicLevel(model, frame, tint)
                Spacer(Modifier.height(Spacing.md))
                Text(
                    stringResource(R.string.jam_rec_recording, ui.instrument.label()),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.jam_rec_recording_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
        BandLanes(
            lanes = ui.lanes,
            originMs = ui.originMs,
            durationMs = if (duration > 0) duration else scaleMs(),
            playhead = { frame.let { if (model.transportMs < 0) null else (model.transportMs / (if (duration > 0) duration else scaleMs())).toFloat() } },
            live = { LiveLane(model, ui, tint, ::scaleMs) },
        )
    }
}

@Composable
private fun RecDot(reduce: Boolean) {
    val transition = rememberInfiniteTransition(label = "dot")
    val pulse by transition.animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dot")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(12.dp).clip(CircleShape).background(RecordRed).alpha(if (reduce) 1f else pulse))
        Text(
            stringResource(R.string.jam_rec_lane_live).uppercase(),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            color = RecordRed,
            letterSpacing = 1.sp,
        )
    }
}

@Composable
private fun MicLevel(model: JamStudioViewModel, frame: Int, tint: Color) {
    val colors = MaterialTheme.colorScheme
    val label = stringResource(R.string.jam_rec_level)
    Box(
        Modifier
            .width(220.dp)
            .height(8.dp)
            .clip(RoundedCornerShape(50))
            .background(colors.surfaceContainerHigh)
            .semantics { contentDescription = label }
            .drawWithContent {
                drawContent()
                // The level is read here, at draw time: a fresh read per frame.
                @Suppress("UNUSED_EXPRESSION") frame
                val level = model.level().coerceIn(0f, 1f)
                drawRoundRect(tint, size = Size(size.width * level, size.height), cornerRadius = CornerRadius(size.height / 2))
            },
    )
}

/** Your lane while it is being made: the loudest value of every 80 ms, growing from the left. */
@Composable
private fun LiveLane(model: JamStudioViewModel, ui: JamStudioUi, tint: Color, scaleMs: () -> Double) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(tint), contentAlignment = Alignment.Center) {
            Icon(ui.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(18.dp))
        }
        Box(
            Modifier
                .weight(1f)
                .height(48.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(tint.copy(alpha = 0.16f))
                .border(2.dp, tint, RoundedCornerShape(12.dp))
                .drawWithContent {
                    drawContent()
                    @Suppress("UNUSED_EXPRESSION") model.peaksTick
                    val peaks = model.livePeaks()
                    val perMs = size.width / scaleMs().toFloat()
                    val barW = 3.dp.toPx()
                    peaks.forEachIndexed { i, p ->
                        val x = (i * 80f) * perMs
                        if (x <= size.width) {
                            val h = max(3.dp.toPx(), p.coerceIn(0f, 1f) * (size.height - 12.dp.toPx()))
                            drawRoundRect(
                                tint,
                                topLeft = Offset(x, (size.height - h) / 2f),
                                size = Size(barW, h),
                                cornerRadius = CornerRadius(barW / 2),
                            )
                        }
                    }
                },
        ) {
            Text(
                stringResource(R.string.jam_rec_you),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = colors.onSurface.copy(alpha = 0.85f),
                modifier = Modifier.align(Alignment.TopStart).padding(start = 8.dp, top = 2.dp),
            )
        }
    }
}

// ------------------------------------------------------------------ review

@Composable
private fun ReviewBody(model: JamStudioViewModel, ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    val take = ui.take ?: return
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(ui.playing) { while (ui.playing) withFrameNanos { frame = it.hashCode() } }
    val duration = ui.durationMs
    val positionText by remember(frame) { mutableStateOf(JamTime.clock(model.reviewPositionMs())) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.gutter, vertical = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.lg),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                stringResource(R.string.jam_rec_review_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.semantics { heading() },
            )
            Text(stringResource(R.string.jam_rec_review_body), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        }

        ui.cut?.let { InfoCard(cutText(it) + " " + stringResource(R.string.jam_rec_cut_kept)) }
        if (ui.notice == StudioNotice.Restored) InfoCard(stringResource(R.string.jam_rec_restored))
        if (ui.silent) Warning(stringResource(R.string.jam_rec_silent_title), stringResource(R.string.jam_rec_silent_body))
        if (take.routeChanged) Warning(null, stringResource(R.string.jam_rec_route_changed))
        if (take.uncalibrated) Warning(null, stringResource(R.string.jam_rec_uncalibrated))
        ui.postFailure?.let { Warning(null, failureText(it)) }

        SectionLabel(stringResource(R.string.jam_rec_with_band))
        BandLanes(
            lanes = ui.lanes,
            originMs = ui.originMs,
            durationMs = duration,
            playhead = { frame.let { if (duration > 0) (model.reviewPositionMs() / duration).toFloat() else null } },
            onSeek = { f -> model.seekReview(f * duration) },
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            val playLabel = stringResource(if (ui.playing) R.string.jam_pause else R.string.jam_play)
            Box(
                Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(colors.primary)
                    .clickable { model.togglePlay() }
                    .clearAndSetSemantics { contentDescription = playLabel; role = Role.Button }
                    .testTag("jam.studio.play"),
                contentAlignment = Alignment.Center,
            ) {
                Crossfade(ui.playing, label = "review-play") { playing ->
                    Icon(if (playing) PqpIcons.Pause else PqpIcons.Play, contentDescription = null, tint = colors.onPrimary, modifier = Modifier.size(26.dp))
                }
            }
            Text(
                text = "$positionText / ${JamTime.clock(duration)}",
                style = MaterialTheme.typography.titleSmall,
                fontFamily = FontFamily.Monospace,
                softWrap = false,
                maxLines = 1,
            )
        }

        NudgeCard(model, ui)
        if (take.correctionMs != 0.0 && !take.uncalibrated) {
            Text(
                stringResource(R.string.jam_rec_corrected, take.correctionMs.roundToInt()),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun InfoCard(text: String) {
    val colors = MaterialTheme.colorScheme
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.surfaceContainer)
            .padding(Spacing.md)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun NudgeCard(model: JamStudioViewModel, ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    val take = ui.take ?: return
    val nudge = take.nudgeMs
    val value = when {
        nudge == 0 -> stringResource(R.string.jam_rec_on_time)
        nudge < 0 -> stringResource(R.string.jam_rec_ms_earlier, -nudge)
        else -> stringResource(R.string.jam_rec_ms_later, nudge)
    }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(colors.surfaceContainer).padding(Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Text(stringResource(R.string.jam_rec_nudge_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            NudgeButton(stringResource(R.string.jam_rec_earlier), PqpIcons.SlideLeft, -1, model, Modifier.weight(1f).testTag("jam.studio.earlier"))
            Text(
                value,
                style = MaterialTheme.typography.titleSmall,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.width(112.dp).testTag("jam.studio.nudgeValue").semantics { liveRegion = LiveRegionMode.Polite },
            )
            NudgeButton(stringResource(R.string.jam_rec_later), PqpIcons.Forward, 1, model, Modifier.weight(1f).testTag("jam.studio.later"))
        }
        Text(stringResource(R.string.jam_rec_hold_hint), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        if (nudge != 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = model::resetNudge) { Text(stringResource(R.string.jam_rec_nudge_reset), maxLines = 1) }
                TextButton(onClick = model::keepNudgeForRoute, modifier = Modifier.testTag("jam.studio.keepNudge")) {
                    Text(stringResource(R.string.jam_rec_nudge_keep), maxLines = 2)
                }
            }
        }
    }
}

/** A press steps once; holding it repeats and speeds up (10, 50, then 100 ms a step), because nobody taps thirty times. */
@Composable
private fun NudgeButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    sign: Int,
    model: JamStudioViewModel,
    modifier: Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val current by rememberUpdatedState(model)
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.surfaceContainerHigh)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                role = Role.Button
                // TalkBack and a keyboard step once; the hold-to-repeat is for a finger.
                onClick(label) {
                    current.nudge(sign * JamTakeEdit.stepFor(0))
                    true
                }
            }
            .pointerInput(sign) {
                awaitEachGesture {
                    awaitFirstDown()
                    current.nudge(sign * JamTakeEdit.stepFor(0))
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    val started = System.nanoTime()
                    var next = started + HOLD_DELAY_NS
                    while (true) {
                        val wait = max(1L, (next - System.nanoTime()) / 1_000_000L)
                        // Nothing arrives while the finger is still: the wait ends by itself and the step repeats.
                        val event = withTimeoutOrNull(wait) { awaitPointerEvent() }
                        if (event != null && event.changes.none { it.pressed }) break
                        val now = System.nanoTime()
                        if (now >= next) {
                            current.nudge(sign * JamTakeEdit.stepFor((now - started) / 1_000_000L))
                            next = now + REPEAT_NS
                        }
                    }
                }
            }
            .padding(horizontal = Spacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (sign < 0) Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, maxLines = 1)
            if (sign > 0) Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        }
    }
}

// ------------------------------------------------------------------ posting, done, leaving

@Composable
private fun PostingBody(ui: JamStudioUi) {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        val percent = (ui.postFraction * 100).roundToInt()
        val text = when (ui.postStage) {
            PostStage.Encoding -> stringResource(R.string.jam_rec_post_encoding)
            PostStage.Creating -> stringResource(R.string.jam_rec_post_creating)
            PostStage.Uploading -> stringResource(R.string.jam_rec_post_uploading, percent)
            PostStage.Claiming -> stringResource(R.string.jam_rec_post_claiming)
        }
        if (ui.postStage == PostStage.Uploading) {
            LinearProgressIndicator(
                progress = { ui.postFraction },
                modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(50)),
                color = colors.primary,
                trackColor = colors.surfaceContainerHigh,
            )
        } else {
            CircularProgressIndicator(Modifier.size(36.dp), strokeWidth = 3.dp)
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text,
            style = MaterialTheme.typography.titleSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("jam.studio.posting"),
        )
    }
}

@Composable
private fun DoneBody(ui: JamStudioUi, isNew: Boolean) {
    val colors = MaterialTheme.colorScheme
    val reduce = rememberReduceMotion()
    val pop = remember { Animatable(if (reduce) 1f else 0.6f) }
    LaunchedEffect(Unit) { if (pop.value < 1f) pop.animateTo(1f, spring(dampingRatio = 0.5f, stiffness = 300f)) }
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(88.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value }.clip(CircleShape).background(ui.instrument.color()),
            contentAlignment = Alignment.Center,
        ) { Icon(PqpIcons.Confirm, contentDescription = null, tint = JamInk, modifier = Modifier.size(44.dp)) }
        Spacer(Modifier.height(Spacing.lg))
        Text(
            stringResource(if (isNew) R.string.jam_rec_done_new_title else R.string.jam_rec_done_title),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.ExtraBold,
            modifier = Modifier.testTag("jam.studio.done"),
        )
        Spacer(Modifier.height(Spacing.sm))
        Text(
            stringResource(R.string.jam_rec_done_body),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun LeaveDialog(risk: JamStudioViewModel.LeaveRisk, onStay: () -> Unit, onKeep: () -> Unit, onDiscard: () -> Unit) {
    if (risk == JamStudioViewModel.LeaveRisk.Recording) {
        AlertDialog(
            onDismissRequest = onStay,
            title = { Text(stringResource(R.string.jam_rec_leave_recording_title)) },
            text = { Text(stringResource(R.string.jam_rec_leave_recording_body)) },
            confirmButton = {
                TextButton(onClick = onStay, modifier = Modifier.testTag("jam.studio.keepRecording")) {
                    Text(stringResource(R.string.jam_rec_keep_recording))
                }
            },
            dismissButton = {
                TextButton(onClick = onDiscard, modifier = Modifier.testTag("jam.studio.discard")) {
                    Text(stringResource(R.string.jam_rec_discard), color = MaterialTheme.colorScheme.error)
                }
            },
        )
    } else {
        AlertDialog(
            onDismissRequest = onStay,
            title = { Text(stringResource(R.string.jam_rec_leave_take_title)) },
            text = { Text(stringResource(R.string.jam_rec_leave_take_body)) },
            confirmButton = {
                TextButton(onClick = onKeep, modifier = Modifier.testTag("jam.studio.keep")) {
                    Text(stringResource(R.string.jam_rec_leave_keep))
                }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = onDiscard, modifier = Modifier.testTag("jam.studio.discard")) {
                        Text(stringResource(R.string.jam_rec_discard), color = MaterialTheme.colorScheme.error)
                    }
                    TextButton(onClick = onStay) { Text(stringResource(R.string.jam_rec_leave_stay)) }
                }
            },
        )
    }
}
