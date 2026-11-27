package gg.pqp.app.jam.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.jam.JamBidi
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamNoticeQueue
import gg.pqp.app.jam.JamNoticeRules
import gg.pqp.app.jam.JamNoticeState
import gg.pqp.app.jam.JamNoticeStore
import gg.pqp.app.jam.JamNoticeToast
import gg.pqp.app.jam.JamTakeNotice
import gg.pqp.app.jam.JamTakeNoticeKind
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * What is drawn right now of the take notices, from the store: the pure rule (`JamNoticeRules.queue`) applied to what
 * is held and to whether a screen is holding them back. [JamNoticeHost] draws it and the app's frame reads the same
 * answer to know whether to leave room for it.
 */
fun JamNoticeState.drawn(holds: Int): JamNoticeQueue = JamNoticeRules.queue(notices, toast != null, held = holds > 0)

/** How long the small toast stays once it is drawn (it keeps its place while a song or the studio holds it back). */
private const val TOAST_MS = 9_000L

/**
 * The durable item of "somebody sent a part" (to the song's starter) and "the starter answered" (to whoever sent it),
 * drawn above the screen, IN the flow, so it moves the content down instead of covering a control. It stays until it
 * is answered, the way the watch party's "liberada" card does, because it is the one thing this person is waiting to
 * hear. One at a time: the newest, with a count of those behind it. Nothing is drawn while a song or the studio is
 * open (`JamNoticeStore.hold`).
 *
 * The main button spends the item and opens the song, where the waiting parts are the first thing on the page. The X
 * spends it without opening: the persistent markers (the wall's strip and tile, the song's own block) are what stays.
 */
@Composable
fun JamNoticeHost(
    store: JamNoticeStore,
    onOpenSong: (songId: String) -> Unit,
    /** The card is the first thing under the status bar (no call bar, no connection banner above it). */
    topInset: Boolean,
    modifier: Modifier = Modifier,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val holds by store.holds.collectAsStateWithLifecycle()
    val queue = state.drawn(holds)
    // One key per thing drawn, so the next card takes the place of the one answered with a spring and not a jump.
    val target: Any? = when {
        queue.toast -> state.toast?.let { "toast:${it.key}" }
        queue.card != null -> "card:${queue.card.id}"
        else -> null
    }
    AnimatedContent(
        targetState = target,
        transitionSpec = {
            (slideInVertically(spring(dampingRatio = 0.85f, stiffness = 380f)) { -it / 3 } + fadeIn())
                .togetherWith(fadeOut())
                .using(SizeTransform(clip = false))
        },
        modifier = modifier,
        label = "jam-notice",
    ) { key ->
        if (key == null) {
            Box(Modifier)
            return@AnimatedContent
        }
        val toast = state.toast
        val card = queue.card
        Box(
            Modifier
                .then(if (topInset) Modifier.statusBarsPadding() else Modifier)
                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
        ) {
            when {
                toast != null && key == "toast:${toast.key}" -> NoticeToast(toast, store, onOpenSong)
                card != null -> NoticeCard(card, queue.more, onOpen = {
                    store.ack(card.id)
                    onOpenSong(card.songId)
                }, onDismiss = { store.ack(card.id) })
            }
        }
    }
}

@Composable
private fun NoticeShell(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    emphasis: Boolean,
    tag: String,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.surfaceContainerHigh)
            .padding(start = Spacing.md, top = Spacing.md, bottom = Spacing.md, end = Spacing.xs)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag(tag),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(32.dp)
                .clip(CircleShape)
                .background(if (emphasis) colors.primaryContainer else colors.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (emphasis) colors.onPrimaryContainer else colors.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) { content() }
        IconButton(onClick = onDismiss, modifier = Modifier.testTag("$tag.dismiss")) {
            Icon(PqpIcons.Close, contentDescription = stringResource(R.string.jam_notice_close), modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun NoticeCard(notice: JamTakeNotice, more: Int, onOpen: () -> Unit, onDismiss: () -> Unit) {
    val take = notice.kind == JamTakeNoticeKind.Take
    NoticeShell(
        icon = when (notice.kind) {
            JamTakeNoticeKind.Take -> PqpIcons.Listening
            JamTakeNoticeKind.Accepted -> PqpIcons.Confirm
            JamTakeNoticeKind.Refused -> PqpIcons.Close
        },
        emphasis = take,
        tag = "jam.notice.card.${notice.kind.wire}",
        onDismiss = onDismiss,
    ) {
        Text(
            text = noticeText(notice),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        if (more > 0) {
            Text(
                text = pluralStringResource(R.plurals.jam_notice_more, more, more),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("jam.notice.more"),
            )
        }
        val label = stringResource(if (take) R.string.jam_notice_reply else R.string.jam_notice_open)
        if (take) {
            Button(onClick = onOpen, modifier = Modifier.testTag("jam.notice.open")) { Text(label) }
        } else {
            OutlinedButton(onClick = onOpen, modifier = Modifier.testTag("jam.notice.open")) { Text(label) }
        }
    }
}

@Composable
private fun NoticeToast(toast: JamNoticeToast, store: JamNoticeStore, onOpenSong: (String) -> Unit) {
    // The nine seconds start when it is finally drawn, not when the frame arrived.
    LaunchedEffect(toast.key) {
        delay(TOAST_MS)
        store.dismissToast(toast.key)
    }
    val title = JamBidi.isolate(toast.title)
    NoticeShell(
        icon = PqpIcons.Listening,
        emphasis = !toast.admitted,
        tag = "jam.notice.toast",
        onDismiss = { store.dismissToast(toast.key) },
    ) {
        Text(
            text = stringResource(if (toast.admitted) R.string.jam_notice_toast_admitted else R.string.jam_notice_toast_take, title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Button(
            onClick = {
                store.dismissToast(toast.key)
                onOpenSong(toast.songId)
            },
            modifier = Modifier.testTag("jam.notice.toast.open"),
        ) { Text(stringResource(R.string.jam_notice_toast_see)) }
    }
}

/** The sentence of a card, from the item's own kind, song, count and instruments. Names are isolated: they are typed by strangers. */
@Composable
fun noticeText(notice: JamTakeNotice): String {
    val names = notice.instruments.map { instrument ->
        if (instrument == JamInstrument.Other) stringResource(R.string.jam_notice_other_instrument) else instrument.label()
    }
    val list = joinList(names, stringResource(R.string.jam_and))
    val title = JamBidi.isolate(notice.title)
    val plural = when (notice.kind) {
        JamTakeNoticeKind.Take -> R.plurals.jam_notice_take
        JamTakeNoticeKind.Accepted -> R.plurals.jam_notice_accepted
        JamTakeNoticeKind.Refused -> R.plurals.jam_notice_refused
    }
    return pluralStringResource(plural, notice.count, list, title, notice.count)
}
