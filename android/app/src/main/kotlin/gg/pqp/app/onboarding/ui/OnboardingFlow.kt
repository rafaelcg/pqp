package gg.pqp.app.onboarding.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Backend
import gg.pqp.app.core.IdempotencyAttempt
import gg.pqp.app.core.Landing
import gg.pqp.app.core.Me
import gg.pqp.app.core.ServerMember
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.onboarding.DiscordImportPlan
import gg.pqp.app.onboarding.HandleError
import gg.pqp.app.onboarding.InvitePreview
import gg.pqp.app.onboarding.InviteRef
import gg.pqp.app.onboarding.OnboardingPath
import gg.pqp.app.onboarding.OnboardingStep
import gg.pqp.app.onboarding.UpdateMeRequest
import gg.pqp.app.onboarding.applyDiscordImport
import gg.pqp.app.onboarding.displayLink
import gg.pqp.app.onboarding.fetchInvitePreview
import gg.pqp.app.onboarding.handleErrorFor
import gg.pqp.app.onboarding.isValidUsername
import gg.pqp.app.onboarding.normalizeInviteCode
import gg.pqp.app.onboarding.normalizeUsername
import gg.pqp.app.onboarding.previewDiscordImport
import gg.pqp.app.onboarding.previewRows
import gg.pqp.app.onboarding.screen
import gg.pqp.app.onboarding.screenPosition
import gg.pqp.app.onboarding.tagWasReassigned
import gg.pqp.app.onboarding.taggedInviteUrl
import gg.pqp.app.onboarding.updateMe
import gg.pqp.app.push.DeepLinkTarget
import gg.pqp.app.push.PushController
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * First run after the age gate, as one full-screen flow of up to three steps.
 * The Android reading of `client/src/components/onboarding/onboarding-flow.tsx`
 * (onboarding V2, PR #786), with the same copy and the same rules:
 *
 *   2. você    name, photo and the @. On an invite link it also shows the room
 *              that is waiting, and its button is "Entrar em {server}".
 *   3. sala    cold start only. Three doors: make a room, bring a Discord
 *              server, or paste an invite. One opens at a time.
 *   4. pronto  after a room is made. The invite link and the pastes, so an
 *              organizer never leaves without the one thing that moves a group.
 *
 * Nothing is required. Every primary works with zero edits, and every step but
 * the last has a way out in its top bar that counts as an answer.
 *
 * NATIVE, NOT A DIALOG. The web draws this in one dialog so the app can load
 * behind it; on a phone the flow is the whole screen, the steps slide with a
 * spring, the system back gesture previews the step behind (predictive back),
 * and the moments that matter (a copy, a room made, arriving) are felt as well
 * as seen.
 */
@Composable
fun OnboardingFlow(session: SessionStore, push: PushController) {
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me ?: return

    // Frozen at mount: the invite that decides the path is consumed here, and
    // the rail must not change length under somebody mid-flow.
    val inviteCode by rememberSaveable {
        mutableStateOf((push.pendingTarget.value as? DeepLinkTarget.Invite)?.code)
    }
    LaunchedEffect(Unit) {
        // Taken off the controller so the signed-in navigation does not redeem
        // it a second time once this hands over. The join happens below.
        if (push.pendingTarget.value is DeepLinkTarget.Invite) push.consumeTarget()
    }
    val path = if (inviteCode != null) OnboardingPath.Invite else OnboardingPath.Cold

    var step by rememberSaveable { mutableStateOf(OnboardingStep.You) }
    var forward by remember { mutableStateOf(true) }
    // Saved with the step: a recreation on "pronto" must come back to the
    // same room and link, not to a step with nothing to draw.
    var created by rememberSaveable(stateSaver = CreatedRoom.Saver) { mutableStateOf<CreatedRoom?>(null) }
    var celebrated by rememberSaveable { mutableStateOf(false) }
    var backProgress by remember { mutableFloatStateOf(0f) }
    val haptics = rememberOnboardingHaptics()
    val reduceMotion = rememberReduceMotion()

    val arrival = rememberArrival(session, inviteCode)
    val you = remember(me.id) { YouForm(me) }
    val room = remember { RoomForm() }

    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val flowFocus = LocalFocusManager.current

    LaunchedEffect(Unit) {
        // Arriving from the age gate, whose year field had the keyboard.
        keyboard?.hide()
    }

    fun goTo(next: OnboardingStep) {
        // A step never inherits the keyboard of the one before it: the field
        // that asked for it is sliding away, and a keyboard over the doors
        // hides two of the three.
        flowFocus.clearFocus(force = true)
        keyboard?.hide()
        forward = next.ordinal > step.ordinal
        step = next
    }

    fun finish(landing: Landing?) = session.finishOnboarding(landing)

    // Room → você is the only way back: the room made on step 3 exists, so
    // "pronto" has no step behind it to return to. Back there means go in.
    PredictiveBackHandler(enabled = step == OnboardingStep.Room && !room.busy) { progress ->
        try {
            progress.collect { backProgress = it.progress }
            backProgress = 0f
            goTo(OnboardingStep.You)
        } catch (cancelled: CancellationException) {
            backProgress = 0f
            throw cancelled
        }
    }
    BackHandler(enabled = step == OnboardingStep.Ready) {
        created?.let { finish(it.landing()) }
    }

    // Belt and braces for the saver: never sit on "pronto" with no room.
    if (step == OnboardingStep.Ready && created == null) step = OnboardingStep.Room

    val position = screenPosition(path, step.screen())

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(
                    WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
                ),
        ) {
            TopRow(
                index = position.index,
                total = position.total,
                canGoBack = step == OnboardingStep.Room && !room.busy,
                onBack = { goTo(OnboardingStep.You) },
                skipLabel = when {
                    step == OnboardingStep.You && path == OnboardingPath.Cold ->
                        stringResource(R.string.onboarding_you_later)
                    step == OnboardingStep.Room -> stringResource(R.string.onboarding_room_later)
                    else -> null
                },
                skipEnabled = !you.saving && !room.busy,
                onSkip = { finish(null) },
            )

            AnimatedContent(
                targetState = step,
                transitionSpec = { stepTransition(forward, reduceMotion) },
                label = "onboarding-step",
                modifier = Modifier
                    .weight(1f)
                    .graphicsLayer {
                        // The step behind is previewed by the gesture: this one
                        // leans away as the finger travels, then the real
                        // transition takes over on release.
                        val p = backProgress
                        translationX = p * 56.dp.toPx()
                        scaleX = 1f - p * 0.06f
                        scaleY = 1f - p * 0.06f
                        alpha = 1f - p * 0.35f
                    },
            ) { current ->
                when (current) {
                    OnboardingStep.You -> YouStep(
                        session = session,
                        me = me,
                        path = path,
                        form = you,
                        arrival = arrival,
                        haptics = haptics,
                        onNext = {
                            when {
                                path == OnboardingPath.Cold -> goTo(OnboardingStep.Room)
                                else -> {
                                    val joined = arrival.joined
                                    if (joined != null) haptics.celebrate()
                                    finish(
                                        joined?.let {
                                            Landing(it.first, it.second, Landing.Kind.Arrived)
                                        },
                                    )
                                }
                            }
                        },
                    )

                    OnboardingStep.Room -> RoomStep(
                        session = session,
                        form = room,
                        haptics = haptics,
                        onCreated = { made ->
                            created = made
                            goTo(OnboardingStep.Ready)
                        },
                        onJoined = { serverId, name ->
                            haptics.celebrate()
                            finish(Landing(serverId, name, Landing.Kind.Arrived))
                        },
                    )

                    OnboardingStep.Ready -> created?.let { made ->
                        ReadyStep(
                            session = session,
                            created = made,
                            haptics = haptics,
                            onInvite = { code -> created = made.copy(inviteCode = code) },
                            onEnter = { finish(made.landing()) },
                        )
                    }
                }
            }
        }

        // The organizer's one burst, on the screen where the room exists.
        // Invitees get theirs on arrival, in the room itself.
        if (step == OnboardingStep.Ready && !celebrated) {
            LaunchedEffect(Unit) {
                haptics.celebrate()
                delay(2_700)
                celebrated = true
            }
            ConfettiBurst(originY = 0.22f)
        }
    }
}

private fun androidx.compose.animation.AnimatedContentTransitionScope<OnboardingStep>.stepTransition(
    forward: Boolean,
    reduceMotion: Boolean,
): ContentTransform {
    if (reduceMotion) return fadeIn(tween(0)) togetherWith fadeOut(tween(0))
    val direction = if (forward) 1 else -1
    val slide = spring<androidx.compose.ui.unit.IntOffset>(dampingRatio = 0.86f, stiffness = 380f)
    return (
        slideInHorizontally(slide) { width -> direction * width / 4 } +
            fadeIn(tween(durationMillis = 260, delayMillis = 40))
        ).togetherWith(
        slideOutHorizontally(slide) { width -> -direction * width / 6 } +
            fadeOut(tween(durationMillis = 120)),
    ).using(SizeTransform(clip = false))
}

@Composable
private fun TopRow(
    index: Int,
    total: Int,
    canGoBack: Boolean,
    onBack: () -> Unit,
    skipLabel: String?,
    skipEnabled: Boolean,
    onSkip: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(start = Spacing.xs, end = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The rail sits on the page gutter, where the age gate draws it, and
        // the back arrow slides in ahead of it only when there is a way back:
        // the rail must not jump sideways between the gate and the wizard.
        androidx.compose.animation.AnimatedVisibility(
            visible = canGoBack,
            enter = fadeIn() + androidx.compose.animation.expandHorizontally(),
            exit = fadeOut() + androidx.compose.animation.shrinkHorizontally(),
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    PqpIcons.Back,
                    contentDescription = stringResource(R.string.onboarding_room_import_back),
                )
            }
        }
        Spacer(Modifier.width(if (canGoBack) Spacing.xs else Spacing.gutter))
        StepRail(index = index, total = total)
        Spacer(Modifier.weight(1f))
        AnimatedContent(targetState = skipLabel, label = "skip") { label ->
            if (label != null) {
                TextButton(onClick = onSkip, enabled = skipEnabled) {
                    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Spacer(Modifier.size(48.dp))
            }
        }
    }
}

/** The scrolling body and the button pinned under it, above the keyboard. */
@Composable
private fun StepScaffold(
    header: @Composable ColumnScope.() -> Unit,
    bottom: @Composable ColumnScope.() -> Unit,
    body: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.gutter + Spacing.xs)
                .padding(top = Spacing.md, bottom = Spacing.xl),
        ) {
            header()
            Spacer(Modifier.height(Spacing.xl))
            body()
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.background)
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter + Spacing.xs, vertical = Spacing.md),
            content = bottom,
        )
    }
}

// ----------------------------------------------------------------- arrival

/** The invite link's join, running behind the "você" step. */
@Stable
private class ArrivalState {
    var preview by mutableStateOf<InvitePreview?>(null)

    /** `serverId` to `serverName` once the join landed. */
    var joined by mutableStateOf<Pair<String, String>?>(null)
    var failed by mutableStateOf(false)

    /** Everybody else in the room, counted once when the list lands. */
    var others by mutableStateOf<Int?>(null)

    /** At most five of them, pictures first: all the card draws. */
    var faces by mutableStateOf<List<ServerMember>>(emptyList())
    val pending: Boolean get() = joined == null && !failed
}

@Composable
private fun rememberArrival(session: SessionStore, code: String?): ArrivalState {
    val state = remember(code) { ArrivalState() }
    if (code == null) return state
    // The public preview answers before the join does (no auth, one read), so
    // the room's name and face are on screen while the seat is being saved.
    LaunchedEffect(code) {
        state.preview = fetchInvitePreview(session.http, code)
    }
    LaunchedEffect(code) {
        val joined = session.startInviteJoin(code).await()
        if (joined == null) {
            // `linkError` keeps the server's own sentence; the app shows it in
            // the room list the moment first run hands over.
            state.failed = true
        } else {
            val name = joined.serverName.ifBlank { state.preview?.serverName.orEmpty() }
            state.joined = joined.serverId to name
            // Reduced to a count and five faces here, once, so the card does
            // no work over the whole roster on every recomposition.
            val selfId = (session.phase.value as? SessionPhase.Ready)?.me?.id
            val members = runCatching { session.api.serverMembers(joined.serverId) }.getOrNull()
            if (members != null) {
                val others = members.filter { it.id != selfId }
                state.others = others.size
                state.faces = others.sortedByDescending { !it.avatarUrl.isNullOrBlank() }.take(5)
            }
        }
    }
    return state
}

// --------------------------------------------------------------- step: você

@Stable
private class YouForm(me: Me) {
    var displayName by mutableStateOf(me.displayName)
    var nameTouched by mutableStateOf(false)
    var avatarUrl by mutableStateOf(me.avatarUrl.orEmpty())
    var editingHandle by mutableStateOf(false)
    var username by mutableStateOf(me.username.orEmpty())
    var tag by mutableStateOf(me.tag)
    var reassignedTag by mutableStateOf<String?>(null)
    var saving by mutableStateOf(false)
    var waitingForJoin by mutableStateOf(false)
    var saveError by mutableStateOf(false)
    var handleError by mutableStateOf<HandleError?>(null)
}

/**
 * Six of the web's eight presets: the two `bottts-neutral` ones are SVG, which
 * this app's image loader does not decode, and a blank circle in a row of
 * faces reads as a broken app. Same URLs, so a choice made here is the same
 * picture on the web.
 */
private val AvatarPresets = listOf(
    "https://api.dicebear.com/9.x/shapes/png?seed=signal",
    "https://api.dicebear.com/9.x/shapes/png?seed=phosphor",
    "https://api.dicebear.com/9.x/shapes/png?seed=desk",
    "https://api.dicebear.com/9.x/shapes/png?seed=mesh",
    "https://api.dicebear.com/9.x/shapes/png?seed=lobby",
    "https://api.dicebear.com/9.x/shapes/png?seed=relay",
)

@Composable
private fun YouStep(
    session: SessionStore,
    me: Me,
    path: OnboardingPath,
    form: YouForm,
    arrival: ArrivalState,
    haptics: OnboardingHaptics,
    onNext: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val invite = path == OnboardingPath.Invite
    val serverName = arrival.joined?.second ?: arrival.preview?.serverName
    val handleChanged = form.editingHandle && form.username != me.username.orEmpty()
    val canSubmit = !form.saving && !form.waitingForJoin &&
        (!handleChanged || isValidUsername(form.username))

    // Pressed "Entrar em" while the join was still running: go the moment it
    // lands, or after ten seconds regardless, so a slow network never strands
    // somebody here. A dead link is explained in the app, not on this step.
    LaunchedEffect(form.waitingForJoin, arrival.pending) {
        if (!form.waitingForJoin) return@LaunchedEffect
        if (!arrival.pending) {
            onNext()
            return@LaunchedEffect
        }
        delay(10_000)
        onNext()
    }

    fun advance() {
        if (invite && arrival.pending) {
            form.waitingForJoin = true
            return
        }
        onNext()
    }

    fun submit() {
        if (!canSubmit) return
        focus.clearFocus()
        val trimmed = form.displayName.trim()
        val nameChanged = trimmed.isNotEmpty() && trimmed != me.displayName
        val avatarChanged = form.avatarUrl != me.avatarUrl.orEmpty()
        if (!nameChanged && !avatarChanged && !handleChanged) {
            haptics.tick()
            advance()
            return
        }
        form.saving = true
        form.saveError = false
        form.handleError = null
        scope.launch {
            try {
                val updated = session.api.updateMe(
                    UpdateMeRequest(
                        displayName = trimmed.takeIf { nameChanged },
                        username = form.username.takeIf { handleChanged },
                        // An empty string clears the picture; null would be
                        // "leave it alone" and dropped from the body.
                        avatarUrl = form.avatarUrl.takeIf { avatarChanged },
                    ),
                )
                session.applyProfile(updated)
                if (handleChanged && tagWasReassigned(form.username, form.tag, updated.tag)) {
                    // Stay and say so. Advancing here is how somebody leaves
                    // believing in a handle nobody can type.
                    form.reassignedTag = updated.tag
                    form.tag = updated.tag
                    form.username = updated.username ?: form.username
                    form.editingHandle = false
                    haptics.reject()
                    return@launch
                }
                form.tag = updated.tag
                haptics.tick()
                advance()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                haptics.reject()
                if (handleChanged) {
                    form.handleError = handleErrorFor((error as? ApiException)?.status)
                } else {
                    form.saveError = true
                }
            } finally {
                form.saving = false
            }
        }
    }

    val eyebrow = when {
        invite && arrival.failed -> stringResource(R.string.onboarding_you_eyebrow_invite_failed)
        invite && serverName != null -> stringResource(R.string.onboarding_you_eyebrow_invite, serverName)
        else -> stringResource(R.string.onboarding_you_eyebrow)
    }
    val description = if (invite && arrival.failed) {
        stringResource(R.string.onboarding_you_description_invite_failed)
    } else {
        stringResource(R.string.onboarding_you_description)
    }
    val primary = when {
        form.saving -> stringResource(R.string.onboarding_saving)
        form.waitingForJoin -> stringResource(R.string.onboarding_you_entering)
        invite && !arrival.failed && serverName != null ->
            stringResource(R.string.onboarding_you_enter, serverName)
        else -> stringResource(R.string.onboarding_you_next)
    }

    StepScaffold(
        header = {
            if (invite && !arrival.failed) {
                ArrivalCard(arrival = arrival)
                Spacer(Modifier.height(Spacing.xl))
            }
            StepHeader(
                eyebrow = eyebrow,
                title = stringResource(R.string.onboarding_you_title),
                description = description,
                icon = if (invite) PqpIcons.Sparkles else PqpIcons.Person,
            )
        },
        bottom = {
            PrimaryButton(
                text = primary,
                onClick = ::submit,
                enabled = canSubmit,
                busy = form.saving || form.waitingForJoin,
            )
        },
    ) {
        // Name.
        FieldLabel(stringResource(R.string.onboarding_you_name))
        OutlinedTextField(
            value = form.displayName,
            onValueChange = {
                form.displayName = it.take(32)
                form.nameTouched = true
            },
            enabled = !form.saving,
            singleLine = true,
            placeholder = { Text(stringResource(R.string.onboarding_you_name_placeholder)) },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Words,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        )
        // The field arrives filled from the identity provider, and for anyone
        // who used Google that is their legal name over every message.
        AnimatedVisibility(
            visible = !form.nameTouched && form.displayName == me.displayName && form.displayName.isNotEmpty(),
        ) {
            Text(
                text = stringResource(R.string.onboarding_you_name_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs + 2.dp),
            )
        }

        Spacer(Modifier.height(Spacing.xl))
        PhotoRow(
            name = form.displayName.ifBlank { me.displayName },
            seed = me.id,
            value = form.avatarUrl,
            enabled = !form.saving,
            haptics = haptics,
            onPick = { form.avatarUrl = it },
        )

        Spacer(Modifier.height(Spacing.xl))
        HandleSection(me = me, form = form, haptics = haptics, onDone = ::submit)

        AnimatedVisibility(visible = form.saveError) {
            ErrorLine(stringResource(R.string.onboarding_you_save_error))
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = Spacing.xs + 2.dp),
    )
}

@Composable
private fun ErrorLine(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier
            .padding(top = Spacing.sm)
            .semantics { liveRegion = LiveRegionMode.Assertive },
    )
}

/**
 * "{server} tá te esperando", made visible: the room's icon, its name, and the
 * faces already inside. Warm on purpose, because this is the screen an invitee
 * would otherwise read as signing up for nothing.
 */
@Composable
private fun ArrivalCard(arrival: ArrivalState) {
    val name = arrival.joined?.second ?: arrival.preview?.serverName
    val iconUrl = arrival.preview?.iconUrl
    val count = arrival.others ?: arrival.preview?.memberCount
    val faces = arrival.faces

    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)),
        modifier = Modifier
            .fillMaxWidth()
            .riseIn(delayMillis = 120),
    ) {
        Row(
            modifier = Modifier.padding(Spacing.md + 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (name == null) {
                PulsingBlock(Modifier.size(56.dp), RoundedCornerShape(14.dp))
            } else {
                // Seeded by the server's id once the join has told us it, which
                // is what the channel list seeds by: the monogram keeps its
                // colour from this card into the room.
                Avatar(
                    name = name,
                    url = iconUrl,
                    size = 56.dp,
                    cornerRadius = 14.dp,
                    seed = arrival.joined?.first ?: name,
                )
            }
            Spacer(Modifier.width(Spacing.md + 2.dp))
            Column(Modifier.weight(1f)) {
                if (name == null) {
                    PulsingBlock(Modifier.fillMaxWidth(0.55f).height(18.dp), RoundedCornerShape(6.dp))
                    Spacer(Modifier.height(Spacing.sm))
                    Text(
                        text = stringResource(R.string.onboarding_you_joining),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        text = name,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(Spacing.xs + 2.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (faces.isNotEmpty()) {
                            Box(Modifier.height(24.dp).width((18 * faces.size + 6).dp)) {
                                faces.forEachIndexed { index, member ->
                                    Box(
                                        Modifier
                                            .offset(x = (18 * index).dp)
                                            .riseIn(delayMillis = 200 + index * 60, distance = 6.dp)
                                            .size(24.dp)
                                            .clip(CircleShape)
                                            .border(2.dp, MaterialTheme.colorScheme.background, CircleShape),
                                    ) {
                                        Avatar(
                                            name = member.displayName,
                                            url = member.avatarUrl,
                                            size = 24.dp,
                                            seed = member.id,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.width(Spacing.sm))
                        }
                        if (count != null && count > 0) {
                            Text(
                                text = pluralStringResource(R.plurals.onboarding_you_members, count, count),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else if (arrival.pending) {
                            Text(
                                text = stringResource(R.string.onboarding_you_joining),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PulsingBlock(modifier: Modifier, shape: androidx.compose.ui.graphics.Shape) {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.8f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            tween(700),
            androidx.compose.animation.core.RepeatMode.Reverse,
        ),
        label = "pulse-alpha",
    )
    Box(
        modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f * alpha)),
    )
}

@Composable
private fun PhotoRow(
    name: String,
    seed: String,
    value: String,
    enabled: Boolean,
    haptics: OnboardingHaptics,
    onPick: (String) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        FieldLabel(stringResource(R.string.onboarding_you_photo))
        Spacer(Modifier.weight(1f))
        AnimatedVisibility(visible = value.isNotEmpty(), enter = fadeIn(), exit = fadeOut()) {
            TextButton(onClick = { onPick("") }, enabled = enabled) {
                Text(stringResource(R.string.onboarding_you_photo_clear))
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        val currentDescription = stringResource(R.string.onboarding_you_photo_current)
        AnimatedContent(
            targetState = value,
            transitionSpec = {
                (fadeIn(tween(180)) + androidx.compose.animation.scaleIn(initialScale = 0.85f))
                    .togetherWith(fadeOut(tween(120)))
            },
            label = "avatar",
            modifier = Modifier.semantics { contentDescription = currentDescription },
        ) { url ->
            Avatar(name = name, url = url.ifEmpty { null }, size = 56.dp, seed = seed)
        }
        Spacer(Modifier.width(Spacing.md + 2.dp))
        Row(
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            AvatarPresets.forEachIndexed { index, url ->
                val chosen = value == url
                val scale by animateFloatAsState(
                    targetValue = if (chosen) 1.08f else 1f,
                    animationSpec = spring(dampingRatio = 0.5f, stiffness = 600f),
                    label = "preset-scale",
                )
                val ring by animateColorAsState(
                    targetValue = if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent,
                    label = "preset-ring",
                )
                val label = stringResource(R.string.onboarding_you_photo_preset, index + 1)
                AsyncImage(
                    model = url,
                    contentDescription = label,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .weight(1f)
                        .aspectRatio(1f)
                        .scale(scale)
                        .border(2.dp, ring, CircleShape)
                        .padding(3.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .semantics { selected = chosen }
                        .clickable(enabled = enabled, role = Role.RadioButton) {
                            haptics.tick()
                            onPick(url)
                        },
                )
            }
        }
    }
}

@Composable
private fun HandleSection(me: Me, form: YouForm, haptics: OnboardingHaptics, onDone: () -> Unit) {
    val context = LocalContext.current
    val focusRequester = remember { FocusRequester() }
    var copied by remember { mutableStateOf(false) }
    val value = form.tag ?: form.username
    val expandedLabel = stringResource(R.string.onboarding_door_expanded)
    val collapsedLabel = stringResource(R.string.onboarding_door_collapsed)
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    val bring = remember { BringIntoViewRequester() }
    LaunchedEffect(form.editingHandle) {
        if (!form.editingHandle) return@LaunchedEffect
        // After the field has expanded, and again once the keyboard is up:
        // the page shrinks under the IME and the field would sit behind it.
        delay(220)
        runCatching { focusRequester.requestFocus() }
        bring.bringIntoView()
        delay(380)
        bring.bringIntoView()
    }

    FieldLabel(stringResource(R.string.onboarding_you_handle))
    Row(verticalAlignment = Alignment.CenterVertically) {
        val copyLabel = stringResource(R.string.onboarding_you_handle_copy, value)
        val copiedLabel = stringResource(R.string.onboarding_you_handle_copied)
        val border by animateColorAsState(
            targetValue = if (copied) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
            label = "handle-border",
        )
        Surface(
            onClick = {
                if (value.isNotEmpty() && copyToClipboard(context, "pqp", value)) {
                    haptics.confirm()
                    copied = true
                }
            },
            shape = MaterialTheme.shapes.small,
            color = MaterialTheme.colorScheme.surfaceContainer,
            border = BorderStroke(1.dp, border),
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 52.dp)
                .semantics {
                    contentDescription = copyLabel
                    if (copied) stateDescription = copiedLabel
                    liveRegion = LiveRegionMode.Polite
                },
        ) {
            Row(
                modifier = Modifier.padding(horizontal = Spacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // The @ turns into a check for a moment. No "Copiado" label
                // beside it: on a phone that label is what pushes the number,
                // the one part people cannot guess, off the chip.
                AnimatedContent(
                    targetState = copied,
                    transitionSpec = {
                        (androidx.compose.animation.scaleIn(spring(dampingRatio = 0.5f, stiffness = 700f), initialScale = 0.5f) + fadeIn())
                            .togetherWith(androidx.compose.animation.scaleOut(targetScale = 0.5f) + fadeOut())
                    },
                    label = "handle-glyph",
                ) { done ->
                    Icon(
                        if (done) PqpIcons.Confirm else PqpIcons.Handle,
                        contentDescription = null,
                        tint = if (done) successColor() else MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Spacer(Modifier.width(Spacing.sm))
                HandleText(value, Modifier.weight(1f))
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        OutlinedButton(
            onClick = {
                haptics.tick()
                if (form.editingHandle) {
                    form.username = me.username.orEmpty()
                    form.handleError = null
                    form.editingHandle = false
                } else {
                    form.editingHandle = true
                    form.reassignedTag = null
                }
            },
            enabled = !form.saving,
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .heightIn(min = 52.dp)
                .semantics {
                    stateDescription = if (form.editingHandle) expandedLabel else collapsedLabel
                },
        ) {
            if (!form.editingHandle) {
                Icon(PqpIcons.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(Spacing.xs + 2.dp))
            }
            Text(
                stringResource(
                    if (form.editingHandle) R.string.onboarding_you_handle_keep else R.string.onboarding_you_handle_change,
                ),
            )
        }
    }

    AnimatedVisibility(
        visible = form.editingHandle,
        enter = expandVertically(spring(dampingRatio = 0.85f, stiffness = 420f)) + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        Column(
            Modifier
                .padding(top = Spacing.md)
                .bringIntoViewRequester(bring),
        ) {
            OutlinedTextField(
                value = form.username,
                onValueChange = {
                    form.username = normalizeUsername(it)
                    form.handleError = null
                },
                label = { Text(stringResource(R.string.onboarding_you_username)) },
                singleLine = true,
                isError = form.handleError != null,
                enabled = !form.saving,
                leadingIcon = { Icon(PqpIcons.Handle, contentDescription = null, modifier = Modifier.size(18.dp)) },
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { onDone() }),
                shape = MaterialTheme.shapes.small,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
            Text(
                text = stringResource(R.string.onboarding_you_username_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs + 2.dp),
            )
        }
    }

    AnimatedVisibility(visible = form.reassignedTag != null) {
        Surface(
            shape = MaterialTheme.shapes.small,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier
                .padding(top = Spacing.sm)
                .fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Text(
                text = stringResource(R.string.onboarding_you_reassigned, form.reassignedTag.orEmpty()),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(Spacing.md),
            )
        }
    }
    form.handleError?.let { error ->
        ErrorLine(
            stringResource(
                when (error) {
                    HandleError.Taken -> R.string.onboarding_you_error_taken
                    HandleError.Invalid -> R.string.onboarding_you_error_invalid
                    HandleError.Generic -> R.string.onboarding_you_save_error
                },
            ),
        )
    }
}

/** `name#1234`, where only the name may shorten: the number is why the chip exists. */
@Composable
private fun HandleText(value: String, modifier: Modifier = Modifier) {
    val hash = value.lastIndexOf('#')
    val name = if (hash > 0) value.substring(0, hash) else value
    val number = if (hash > 0) value.substring(hash) else ""
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = name,
            style = MaterialTheme.typography.titleMedium,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (number.isNotEmpty()) {
            Text(
                text = number,
                style = MaterialTheme.typography.titleMedium,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
            )
        }
    }
}

// ---------------------------------------------------------------- step: sala

private enum class Door { Create, Import, Invite }

@Stable
private class RoomForm {
    var open by mutableStateOf<Door?>(null)
    var name by mutableStateOf("")
    var code by mutableStateOf("")
    var source by mutableStateOf("")
    var plan by mutableStateOf<DiscordImportPlan?>(null)
    var busy by mutableStateOf(false)
    var error by mutableStateOf<Int?>(null)

    /**
     * A door was just opened by a tap, so its field may take the keyboard.
     * Coming back to this step (the back gesture from nowhere, or a return
     * from "você") must not summon it again uninvited.
     */
    var focusPending by mutableStateOf(false)

    /**
     * One key per create attempt, reused across a retry of the same name so
     * a lost response never makes a second room; an edited name starts a
     * fresh attempt. Not observable state on purpose: nothing on screen
     * reads it, it only needs to outlive a single `create()` call.
     */
    val idempotency = IdempotencyAttempt()
}

/** The room step 3 made, and its invite, for step 4. */
data class CreatedRoom(
    val serverId: String,
    val serverName: String,
    val inviteCode: String?,
    val ref: InviteRef,
) {
    fun landing() = Landing(serverId, serverName, Landing.Kind.Owner, inviteCode)

    companion object {
        val Saver: androidx.compose.runtime.saveable.Saver<CreatedRoom?, Any> =
            androidx.compose.runtime.saveable.listSaver(
                save = { room ->
                    if (room == null) emptyList() else listOf(room.serverId, room.serverName, room.inviteCode.orEmpty(), room.ref.name)
                },
                restore = { saved ->
                    if (saved.size < 4) null else CreatedRoom(
                        serverId = saved[0],
                        serverName = saved[1],
                        inviteCode = saved[2].ifEmpty { null },
                        ref = InviteRef.valueOf(saved[3]),
                    )
                },
            )
    }
}

@Composable
private fun RoomStep(
    session: SessionStore,
    form: RoomForm,
    haptics: OnboardingHaptics,
    onCreated: (CreatedRoom) -> Unit,
    onJoined: (serverId: String, name: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    fun openDoor(door: Door) {
        if (form.busy) return
        haptics.tick()
        form.error = null
        form.open = if (form.open == door) null else door
        form.focusPending = form.open != null
    }

    fun create() {
        val trimmed = form.name.trim()
        if (trimmed.isEmpty() || form.busy) return
        focus.clearFocus()
        form.busy = true
        form.error = null
        scope.launch {
            val before = session.servers.value.map { it.id }.toSet()
            val server = try {
                session.api.createServer(trimmed, form.idempotency.keyFor(trimmed)).server
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // The create may have committed and only the answer been lost.
                // A retry would then make a second room, so look first.
                val made = madeSince(session, before, trimmed)
                if (made != null) {
                    form.idempotency.reset()
                    onMade(session, made, InviteRef.Onboarding, haptics, onCreated)
                    form.busy = false
                    return@launch
                }
                haptics.reject()
                form.error = R.string.onboarding_room_create_error
                form.busy = false
                return@launch
            }
            form.idempotency.reset()
            // From here the room exists, so nothing below may send the person
            // back to a "Criar" that would make a second one. The invite runs
            // beside the list refresh; the ready step retries a failed invite.
            val invite = async { runCatching { session.api.createInvite(server.id) }.getOrNull() }
            session.refreshServers()
            val code = invite.await()?.code
            haptics.confirm()
            onCreated(CreatedRoom(server.id, server.name, code, InviteRef.Onboarding))
            form.busy = false
        }
    }

    fun join() {
        val code = normalizeInviteCode(form.code)
        if (code.isEmpty() || form.busy) return
        focus.clearFocus()
        form.busy = true
        form.error = null
        scope.launch {
            val joined = session.redeemInvite(code)
            if (joined == null) {
                // Said here, in one sentence, rather than in the app-wide
                // dialog behind the wizard.
                session.clearLinkError()
                haptics.reject()
                form.error = R.string.onboarding_room_invite_error
                form.busy = false
                return@launch
            }
            onJoined(joined.serverId, joined.serverName)
        }
    }

    fun preview() {
        val source = form.source.trim()
        if (source.isEmpty() || form.busy) return
        focus.clearFocus()
        form.busy = true
        form.error = null
        scope.launch {
            try {
                form.plan = session.api.previewDiscordImport(source)
                haptics.tick()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                haptics.reject()
                form.error = R.string.onboarding_room_import_preview_error
            } finally {
                form.busy = false
            }
        }
    }

    fun apply() {
        val source = form.source.trim()
        if (form.busy) return
        form.busy = true
        form.error = null
        scope.launch {
            val before = session.servers.value.map { it.id }.toSet()
            val result = try {
                session.api.applyDiscordImport(source)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                val made = form.plan?.serverName?.let { madeSince(session, before, it) }
                if (made != null) {
                    onMade(session, made, InviteRef.Discord, haptics, onCreated)
                    form.busy = false
                    return@launch
                }
                haptics.reject()
                form.error = R.string.onboarding_room_import_apply_error
                form.busy = false
                return@launch
            }
            session.refreshServers()
            haptics.confirm()
            onCreated(
                CreatedRoom(result.server.id, result.server.name, result.invite?.code, InviteRef.Discord),
            )
            form.busy = false
        }
    }

    StepScaffold(
        header = {
            StepHeader(
                eyebrow = stringResource(R.string.onboarding_room_eyebrow),
                title = stringResource(R.string.onboarding_room_title),
                description = stringResource(R.string.onboarding_room_description),
                icon = PqpIcons.Server,
            )
        },
        bottom = {},
    ) {
        val doors = listOf(
            Triple(Door.Create, PqpIcons.Sparkles, R.string.onboarding_room_create_title to R.string.onboarding_room_create_body),
            Triple(Door.Import, PqpIcons.Layout, R.string.onboarding_room_import_title to R.string.onboarding_room_import_body),
            Triple(Door.Invite, PqpIcons.Link, R.string.onboarding_room_invite_title to R.string.onboarding_room_invite_body),
        )
        doors.forEachIndexed { index, (door, icon, copy) ->
            DoorCard(
                icon = icon,
                title = stringResource(copy.first),
                body = stringResource(copy.second),
                open = form.open == door,
                collapsed = form.open != null && form.open != door,
                enabled = !form.busy,
                onClick = { openDoor(door) },
                modifier = Modifier.riseIn(delayMillis = 60 + index * 70),
            ) {
                when (door) {
                    Door.Create -> InlineField(
                        value = form.name,
                        onValueChange = { form.name = it.take(100) },
                        placeholder = stringResource(R.string.onboarding_room_create_placeholder),
                        label = stringResource(R.string.onboarding_room_create_label),
                        action = stringResource(
                            if (form.busy) R.string.onboarding_room_create_busy else R.string.onboarding_room_create_action,
                        ),
                        enabled = !form.busy,
                        actionEnabled = form.name.isNotBlank() && !form.busy,
                        capitalization = KeyboardCapitalization.Sentences,
                        onSubmit = ::create,
                        focus = form,
                    )

                    Door.Invite -> InlineField(
                        value = form.code,
                        onValueChange = { form.code = it },
                        placeholder = stringResource(R.string.onboarding_room_invite_placeholder),
                        label = stringResource(R.string.onboarding_room_invite_placeholder),
                        action = stringResource(
                            if (form.busy) R.string.onboarding_room_invite_busy else R.string.onboarding_room_invite_action,
                        ),
                        enabled = !form.busy,
                        actionEnabled = form.code.isNotBlank() && !form.busy,
                        capitalization = KeyboardCapitalization.None,
                        keyboardType = KeyboardType.Uri,
                        onSubmit = ::join,
                        focus = form,
                    )

                    Door.Import -> DiscordDoor(
                        form = form,
                        onPreview = ::preview,
                        onApply = ::apply,
                        onBack = {
                            haptics.tick()
                            form.plan = null
                        },
                    )
                }
            }
            Spacer(Modifier.height(Spacing.sm + 2.dp))
        }
        form.error?.let { ErrorLine(stringResource(it)) }
    }
}

/**
 * A room this account owns, named [name], that was not in [before]: what an
 * ambiguous create or import (the request failed after it may have
 * committed) looks like when it did commit. Null when it did not, or when
 * the list cannot be read, in which case the error stands.
 */
private suspend fun madeSince(
    session: SessionStore,
    before: Set<String>,
    name: String,
): gg.pqp.app.core.ServerSummary? {
    val me = (session.phase.value as? SessionPhase.Ready)?.me?.id ?: return null
    val servers = runCatching { session.api.servers() }.getOrNull() ?: return null
    return servers.firstOrNull { it.id !in before && it.ownerId == me && it.name == name.trim() }
}

private suspend fun onMade(
    session: SessionStore,
    server: gg.pqp.app.core.ServerSummary,
    ref: InviteRef,
    haptics: OnboardingHaptics,
    onCreated: (CreatedRoom) -> Unit,
) {
    val code = runCatching { session.api.createInvite(server.id) }.getOrNull()?.code
    session.refreshServers()
    haptics.confirm()
    onCreated(CreatedRoom(server.id, server.name, code, ref))
}

/**
 * A door: a card that is a button while closed and a small form while open.
 * One is open at a time; the other two shrink to a single line so the open
 * one and the keyboard both fit on a small phone.
 */
@Composable
private fun DoorCard(
    icon: ImageVector,
    title: String,
    body: String,
    open: Boolean,
    collapsed: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val border by animateColorAsState(
        targetValue = if (open) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        label = "door-border",
    )
    val container by animateColorAsState(
        targetValue = if (open) {
            MaterialTheme.colorScheme.primary.copy(alpha = 0.07f)
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        label = "door-container",
    )
    val badge by animateColorAsState(
        targetValue = if (open) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        label = "door-badge",
    )
    val badgeTint by animateColorAsState(
        targetValue = if (open) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.primary,
        label = "door-badge-tint",
    )
    val chevron by animateFloatAsState(
        targetValue = if (open) 90f else 0f,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 500f),
        label = "door-chevron",
    )
    val badgeSize by androidx.compose.animation.core.animateDpAsState(
        targetValue = if (collapsed) 32.dp else 42.dp,
        animationSpec = spring(dampingRatio = 0.8f, stiffness = 420f),
        label = "door-badge-size",
    )
    val expanded = stringResource(R.string.onboarding_door_expanded)
    val closed = stringResource(R.string.onboarding_door_collapsed)

    Surface(
        shape = RoundedCornerShape(18.dp),
        color = container,
        border = BorderStroke(if (open) 1.5.dp else 1.dp, border),
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(spring(dampingRatio = 0.86f, stiffness = 420f)),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                    .semantics { stateDescription = if (open) expanded else closed }
                    .padding(horizontal = Spacing.md + 2.dp, vertical = if (collapsed) Spacing.md else Spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(badgeSize)
                        .clip(RoundedCornerShape(12.dp))
                        .background(badge),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = badgeTint, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(Spacing.md + 2.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    AnimatedVisibility(visible = !collapsed) {
                        Text(
                            text = body,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
                Spacer(Modifier.width(Spacing.sm))
                Icon(
                    PqpIcons.Forward,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(18.dp)
                        .rotate(chevron),
                )
            }
            AnimatedVisibility(
                visible = open,
                enter = expandVertically(spring(dampingRatio = 0.86f, stiffness = 420f)) + fadeIn(tween(200, 60)),
                exit = shrinkVertically() + fadeOut(tween(100)),
            ) {
                Column(
                    Modifier.padding(start = Spacing.md + 2.dp, end = Spacing.md + 2.dp, bottom = Spacing.md + 2.dp),
                    content = content,
                )
            }
        }
    }
}

@Composable
private fun InlineField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    label: String,
    action: String,
    enabled: Boolean,
    actionEnabled: Boolean,
    capitalization: KeyboardCapitalization,
    onSubmit: () -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    focus: RoomForm? = null,
) {
    val focusRequester = remember { FocusRequester() }
    val bring = remember { BringIntoViewRequester() }
    LaunchedEffect(Unit) {
        // A door is a tap, so the keyboard coming up is what was asked for.
        // Only on that tap, though: see `RoomForm.focusPending`.
        if (focus?.focusPending != true) return@LaunchedEffect
        focus.focusPending = false
        delay(160)
        runCatching { focusRequester.requestFocus() }
        delay(420)
        bring.bringIntoView()
    }
    Row(
        modifier = Modifier.bringIntoViewRequester(bring),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            keyboardOptions = KeyboardOptions(
                capitalization = capitalization,
                autoCorrectEnabled = false,
                keyboardType = keyboardType,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { if (actionEnabled) onSubmit() }),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .weight(1f)
                .focusRequester(focusRequester)
                .semantics { contentDescription = label },
        )
        Spacer(Modifier.width(Spacing.sm))
        Button(
            onClick = onSubmit,
            enabled = actionEnabled,
            shape = MaterialTheme.shapes.small,
            contentPadding = ButtonDefaults.ContentPadding,
            modifier = Modifier.heightIn(min = 56.dp),
        ) {
            Text(action)
        }
    }
}

/**
 * The Discord door, native end to end: how to get the link, the paste, then
 * the sidebar it will become, drawn as rows, before anything is created. The
 * same two calls the web's import dialog makes (`/api/import/discord/preview` and `/apply`).
 */
@Composable
private fun DiscordDoor(
    form: RoomForm,
    onPreview: () -> Unit,
    onApply: () -> Unit,
    onBack: () -> Unit,
) {
    AnimatedContent(
        targetState = form.plan,
        transitionSpec = {
            (fadeIn(tween(220, 80)) + slideInHorizontally { it / 5 })
                .togetherWith(fadeOut(tween(100)))
                .using(SizeTransform(clip = false))
        },
        label = "discord-door",
    ) { plan ->
        Column {
            if (plan == null) {
                listOf(
                    R.string.onboarding_room_import_step1,
                    R.string.onboarding_room_import_step2,
                    R.string.onboarding_room_import_step3,
                ).forEachIndexed { index, res ->
                    Row(
                        modifier = Modifier.padding(bottom = Spacing.sm),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier
                                .size(22.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "${index + 1}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        Spacer(Modifier.width(Spacing.sm + 2.dp))
                        Text(
                            stringResource(res),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Spacer(Modifier.height(Spacing.xs))
                InlineField(
                    value = form.source,
                    onValueChange = { form.source = it },
                    placeholder = stringResource(R.string.onboarding_room_import_placeholder),
                    label = stringResource(R.string.onboarding_room_import_placeholder),
                    action = stringResource(
                        if (form.busy) R.string.onboarding_room_import_loading else R.string.onboarding_room_import_preview,
                    ),
                    enabled = !form.busy,
                    actionEnabled = form.source.isNotBlank() && !form.busy,
                    capitalization = KeyboardCapitalization.None,
                    keyboardType = KeyboardType.Uri,
                    onSubmit = onPreview,
                    focus = form,
                )
            } else {
                DiscordPreview(plan = plan, busy = form.busy, onApply = onApply, onBack = onBack)
            }
        }
    }
}

private const val PREVIEW_ROWS = 8

@Composable
private fun DiscordPreview(plan: DiscordImportPlan, busy: Boolean, onApply: () -> Unit, onBack: () -> Unit) {
    val rows = remember(plan) { previewRows(plan) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Avatar(name = plan.serverName, url = plan.iconUrl, size = 36.dp, cornerRadius = 10.dp)
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Text(
            stringResource(R.string.onboarding_room_import_preview_title, plan.serverName),
            style = MaterialTheme.typography.titleMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
    Spacer(Modifier.height(Spacing.sm))
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(vertical = Spacing.sm)) {
            rows.take(PREVIEW_ROWS).forEachIndexed { index, row ->
                Row(
                    modifier = Modifier
                        .riseIn(delayMillis = index * 45, distance = 8.dp)
                        .padding(
                            start = if (row.indent) Spacing.xl else Spacing.md,
                            end = Spacing.md,
                            top = if (row.type == "category" && index > 0) Spacing.sm else 3.dp,
                            bottom = 3.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (row.type == "category") {
                        Text(
                            row.name.uppercase(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    } else {
                        Icon(
                            if (row.type == "voice") PqpIcons.VoiceChannel else PqpIcons.TextChannel,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(Spacing.sm))
                        Text(
                            row.name,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (row.isPrivate) {
                            Spacer(Modifier.width(Spacing.xs))
                            Icon(
                                PqpIcons.PrivateChannel,
                                contentDescription = stringResource(R.string.onboarding_room_import_private),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(12.dp),
                            )
                        }
                    }
                }
            }
            if (rows.size > PREVIEW_ROWS) {
                Text(
                    stringResource(R.string.onboarding_room_import_more, rows.size - PREVIEW_ROWS),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
                )
            }
        }
    }
    Spacer(Modifier.height(Spacing.md))
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onBack, enabled = !busy) {
            Text(stringResource(R.string.onboarding_room_import_back))
        }
        Spacer(Modifier.weight(1f))
        Button(onClick = onApply, enabled = !busy, shape = MaterialTheme.shapes.small) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.width(Spacing.sm))
            }
            Text(
                stringResource(
                    if (busy) R.string.onboarding_room_import_applying else R.string.onboarding_room_import_confirm,
                ),
            )
        }
    }
}

// -------------------------------------------------------------- step: pronto

@Composable
private fun ReadyStep(
    session: SessionStore,
    created: CreatedRoom,
    haptics: OnboardingHaptics,
    onInvite: (String?) -> Unit,
    onEnter: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var copiedOnce by remember { mutableStateOf(false) }
    var retrying by remember { mutableStateOf(false) }

    StepScaffold(
        header = {
            StepHeader(
                eyebrow = stringResource(R.string.onboarding_ready_eyebrow),
                title = stringResource(R.string.onboarding_ready_title),
                description = stringResource(R.string.onboarding_ready_description),
                icon = PqpIcons.Done,
            )
        },
        bottom = {
            PrimaryButton(
                text = stringResource(R.string.onboarding_ready_enter),
                onClick = {
                    haptics.tick()
                    onEnter()
                },
                quiet = !copiedOnce && created.inviteCode != null,
            )
        },
    ) {
        val code = created.inviteCode
        if (code == null) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(Spacing.lg)) {
                    Text(
                        stringResource(R.string.onboarding_ready_invite_failed),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(Spacing.md))
                    FilledTonalButton(
                        onClick = {
                            retrying = true
                            scope.launch {
                                val invite = runCatching { session.api.createInvite(created.serverId) }.getOrNull()
                                onInvite(invite?.code)
                                retrying = false
                            }
                        },
                        enabled = !retrying,
                    ) {
                        Icon(PqpIcons.Retry, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(Spacing.sm))
                        Text(stringResource(R.string.onboarding_ready_retry))
                    }
                }
            }
        } else {
            val url = taggedInviteUrl(Backend.appUrl, code, created.ref)
            InviteLinkBox(url = url, haptics = haptics, onCopied = { copiedOnce = true })
            Spacer(Modifier.height(Spacing.xl))
            PasteCard(url = url, haptics = haptics, onCopied = { copiedOnce = true })
        }
        Spacer(Modifier.height(Spacing.xl))
        FeatureMoments()
    }
}

@Composable
private fun InviteLinkBox(url: String, haptics: OnboardingHaptics, onCopied: () -> Unit) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    // Bumped per copy so the pulse replays on a second tap.
    var pulse by remember { mutableStateOf(0) }
    LaunchedEffect(pulse) {
        if (pulse > 0) {
            delay(1_600)
            copied = false
        }
    }
    val border by animateColorAsState(
        targetValue = if (copied) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        label = "link-border",
    )
    val bump = remember { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(pulse) {
        if (pulse > 0) {
            bump.snapTo(0.97f)
            bump.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = 700f))
        }
    }

    FieldLabel(stringResource(R.string.onboarding_ready_link))
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(if (copied) 1.5.dp else 1.dp, border),
        modifier = Modifier
            .fillMaxWidth()
            .riseIn(delayMillis = 80)
            .graphicsLayer {
                scaleX = bump.value
                scaleY = bump.value
            },
    ) {
        Row(
            modifier = Modifier.padding(start = Spacing.md, end = Spacing.xs + 2.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                PqpIcons.Link,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = displayLink(url),
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(Spacing.sm))
            Button(
                onClick = {
                    if (copyToClipboard(context, "pqp invite", url)) {
                        haptics.confirm()
                        copied = true
                        failed = false
                        pulse += 1
                        onCopied()
                    } else {
                        failed = true
                        haptics.reject()
                    }
                },
                shape = MaterialTheme.shapes.small,
                colors = if (copied) {
                    ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    )
                } else {
                    ButtonDefaults.buttonColors()
                },
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                CopyGlyph(copied = copied)
                Spacer(Modifier.width(Spacing.xs + 2.dp))
                Text(
                    stringResource(if (copied) R.string.onboarding_ready_copied else R.string.onboarding_ready_copy_link),
                )
            }
        }
    }
    // What to do with it, said the moment it is on the clipboard.
    Box(
        Modifier
            .padding(top = Spacing.sm)
            .heightIn(min = 20.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        AnimatedContent(targetState = copied to failed, label = "link-note") { (isCopied, isFailed) ->
            Text(
                text = stringResource(
                    when {
                        isFailed -> R.string.onboarding_ready_copy_failed
                        isCopied -> R.string.onboarding_ready_copied_toast
                        else -> R.string.onboarding_ready_note
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (isCopied) FontWeight.SemiBold else FontWeight.Normal,
                color = when {
                    isFailed -> MaterialTheme.colorScheme.error
                    isCopied -> successColor()
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

/**
 * "Traz a galera": the text to paste in the group chat, short or long, with
 * the system share sheet beside the copy. Same two texts as the web
 * (`client/src/lib/share-invite.ts`), fixed regardless of anything else.
 */
@Composable
private fun PasteCard(url: String, haptics: OnboardingHaptics, onCopied: () -> Unit) {
    val context = LocalContext.current
    var long by rememberSaveable { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }
    val text = stringResource(if (long) R.string.invite_paste_long_text else R.string.invite_paste_short_text, url)
    val shareTitle = stringResource(R.string.invite_paste_share)

    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = Modifier
            .fillMaxWidth()
            .riseIn(delayMillis = 160),
    ) {
        Column(Modifier.padding(Spacing.lg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.invite_paste_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                SingleChoiceSegmentedButtonRow {
                    SegmentedButton(
                        selected = !long,
                        onClick = {
                            haptics.tick()
                            long = false
                        },
                        shape = SegmentedButtonDefaults.itemShape(0, 2),
                        icon = {},
                        colors = segmentColors(),
                    ) { Text(stringResource(R.string.invite_paste_short)) }
                    SegmentedButton(
                        selected = long,
                        onClick = {
                            haptics.tick()
                            long = true
                        },
                        shape = SegmentedButtonDefaults.itemShape(1, 2),
                        icon = {},
                        colors = segmentColors(),
                    ) { Text(stringResource(R.string.invite_paste_long)) }
                }
            }
            Spacer(Modifier.height(Spacing.md))
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.small)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .animateContentSize(spring(dampingRatio = 0.9f, stiffness = 500f))
                    .padding(Spacing.md),
            ) {
                AnimatedContent(targetState = text, label = "paste-text") { shown ->
                    Text(shown, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Spacer(Modifier.height(Spacing.md))
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                FilledTonalButton(
                    onClick = {
                        if (copyToClipboard(context, "pqp invite", text)) {
                            haptics.confirm()
                            copied = true
                            onCopied()
                        }
                    },
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp),
                ) {
                    CopyGlyph(copied = copied)
                    Spacer(Modifier.width(Spacing.xs + 2.dp))
                    Text(stringResource(if (copied) R.string.invite_paste_copied else R.string.invite_paste_copy))
                }
                // Tonal, like Copiar: "Copiar link" above is this screen's one
                // lime button, and "Entrar na sala" takes the colour after.
                FilledTonalButton(
                    onClick = {
                        haptics.tick()
                        onCopied()
                        shareText(context, text, shareTitle)
                    },
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp),
                ) {
                    Icon(
                        PqpIcons.Share,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(Spacing.xs + 2.dp))
                    Text(shareTitle)
                }
            }
        }
    }
}

@Composable
private fun segmentColors() = SegmentedButtonDefaults.colors(
    activeContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f),
    activeContentColor = MaterialTheme.colorScheme.primary,
    activeBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
    inactiveContainerColor = Color.Transparent,
    inactiveContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    inactiveBorderColor = MaterialTheme.colorScheme.outline,
)

/**
 * What the room can do, as three skimmable lines rather than a slideshow:
 * shown once, on the step where the organizer is about to bring people in,
 * which is when "and then what" is the question.
 */
@Composable
fun FeatureMoments(modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(
            stringResource(R.string.onboarding_features_title).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = Spacing.md),
        )
        listOf(
            Triple(PqpIcons.VoiceChannel, R.string.onboarding_feature_voice_title, R.string.onboarding_feature_voice_body),
            Triple(PqpIcons.ShareScreen, R.string.onboarding_feature_screen_title, R.string.onboarding_feature_screen_body),
            Triple(PqpIcons.WatchParty, R.string.onboarding_feature_watch_title, R.string.onboarding_feature_watch_body),
        ).forEachIndexed { index, (icon, title, body) ->
            Row(
                modifier = Modifier
                    .padding(bottom = Spacing.md)
                    .riseIn(delayMillis = 320 + index * 90)
                    .semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.Top,
            ) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(Spacing.md))
                Column(Modifier.weight(1f)) {
                    Text(stringResource(title), style = MaterialTheme.typography.titleSmall)
                    Text(
                        stringResource(body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
