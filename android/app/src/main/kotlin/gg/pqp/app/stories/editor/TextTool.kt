package gg.pqp.app.stories.editor

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoryLayers
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * "Aa": type over a dimmed canvas. The field wears exactly the clothes the
 * layer will (same font, color, background, alignment and size, from the same
 * `rememberTextLook`), so what is typed is what is placed. Font, color,
 * background mode, alignment and size are one tap each; "Pronto" places the
 * text in the middle, or puts an edited layer's words back where it was.
 */
@Composable
fun TextEditorOverlay(
    initialText: String,
    initialStyle: TextStyleChoice,
    canvasWidthPx: Float,
    /** How much of the canvas is dimmed: a text card is the background, so it stays visible. */
    dim: Float,
    /** The bar above and below the canvas on a tall screen: the buttons sit inside the canvas, not across its edge. */
    canvasGap: androidx.compose.ui.unit.Dp = androidx.compose.ui.unit.Dp.Hairline,
    onDone: (text: String, style: TextStyleChoice) -> Unit,
    onCancel: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    var value by remember { mutableStateOf(TextFieldValue(initialText, TextRange(initialText.length))) }
    var style by remember { mutableStateOf(initialStyle) }
    val look = rememberTextLook(style.font, style.color, style.background, style.align, style.size, canvasWidthPx)
    val hint = stringResource(R.string.stories_editor_text_hint)

    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }
    BackHandler(onBack = onCancel)

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = dim))
            // Nothing under the dim is touchable.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }
            .testTag("stories.editor.text"),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .toolsTop(canvasGap)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(Spacing.sm)) {
                ToolButton(PqpIcons.Close, stringResource(R.string.cancel), "stories.editor.text.cancel", onClick = onCancel)
                Box(Modifier.weight(1f))
                Text(
                    stringResource(R.string.stories_editor_text_done),
                    color = Palette.Ink,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(Palette.Signal)
                        .clickable { onDone(value.text, style) }
                        .padding(horizontal = Spacing.lg, vertical = Spacing.sm)
                        .testTag("stories.editor.text.done"),
                )
            }

            Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = Spacing.lg), contentAlignment = Alignment.Center) {
                Box(look.boxModifier) {
                    if (value.text.isEmpty()) {
                        // Where the first letter will land: the field is as wide as the box, so a
                        // hint at its start would sit left of the caret on a centred layer.
                        androidx.compose.material3.Text(
                            hint,
                            style = look.style.copy(color = look.style.color.copy(alpha = 0.45f), shadow = null),
                            modifier = Modifier.align(
                                when (style.align) {
                                    "left" -> Alignment.TopStart
                                    "right" -> Alignment.TopEnd
                                    else -> Alignment.TopCenter
                                },
                            ),
                        )
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = { next ->
                            value = next.copy(text = next.text.take(StoriesRules.TEXT_MAX))
                        },
                        textStyle = look.style,
                        cursorBrush = SolidColor(look.style.color),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier
                            // Wrap where the placed layer will, so the line breaks typed are the ones posted.
                            .widthIn(max = look.maxWidth)
                            .focusRequester(focus)
                            .semantics { contentDescription = hint }
                            .testTag("stories.editor.text.field"),
                    )
                }
            }

            // Size.
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = Spacing.gutter)) {
                val sizeLabel = stringResource(R.string.stories_editor_text_size)
                Text("A", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelMedium)
                Slider(
                    value = style.size,
                    onValueChange = { style = style.copy(size = it) },
                    valueRange = StoryLayers.TEXT_SIZE_MIN..StoryLayers.TEXT_SIZE_MAX,
                    colors = SliderDefaults.colors(thumbColor = Palette.Signal, activeTrackColor = Palette.Signal),
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = Spacing.sm)
                        .semantics { contentDescription = sizeLabel }
                        .testTag("stories.editor.text.size"),
                )
                Text("A", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.titleLarge)
            }

            // Fonts.
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                contentPadding = PaddingValues(horizontal = Spacing.gutter, vertical = Spacing.xs),
            ) {
                items(StoryLayers.FONTS) { font ->
                    FontChip(font, selected = font == style.font) {
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        style = style.copy(font = font)
                    }
                }
            }

            ColorRow(selected = style.color, onPick = { style = style.copy(color = it) })

            // Background and alignment.
            Row(
                horizontalArrangement = Arrangement.spacedBy(Spacing.md, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.sm),
            ) {
                BackgroundModeButton(style.background) {
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    val next = StoryLayers.TEXT_BACKGROUNDS[(StoryLayers.TEXT_BACKGROUNDS.indexOf(style.background) + 1) % StoryLayers.TEXT_BACKGROUNDS.size]
                    style = style.copy(background = next)
                }
                val alignIcon = when (style.align) {
                    "left" -> PqpIcons.AlignLeft
                    "right" -> PqpIcons.AlignRight
                    else -> PqpIcons.AlignCenter
                }
                val alignLabel = stringResource(
                    when (style.align) {
                        "left" -> R.string.stories_editor_align_left
                        "right" -> R.string.stories_editor_align_right
                        else -> R.string.stories_editor_align_center
                    },
                )
                ToolButton(alignIcon, alignLabel, "stories.editor.text.align") {
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    val next = StoryLayers.ALIGNS[(StoryLayers.ALIGNS.indexOf(style.align) + 1) % StoryLayers.ALIGNS.size]
                    style = style.copy(align = next)
                }
            }
        }
    }
}

@Composable
private fun FontChip(font: String, selected: Boolean, onClick: () -> Unit) {
    val (family, weight) = storyFont(font)
    val label = stringResource(
        when (font) {
            "bold" -> R.string.stories_editor_font_bold
            "typewriter" -> R.string.stories_editor_font_typewriter
            "serif" -> R.string.stories_editor_font_serif
            "neon" -> R.string.stories_editor_font_neon
            else -> R.string.stories_editor_font_classic
        },
    )
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(width = 76.dp, height = 44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) Color.White.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.08f))
            .border(if (selected) 2.dp else 1.dp, if (selected) Palette.Signal else Color.White.copy(alpha = 0.25f), RoundedCornerShape(12.dp))
            .semantics {
                role = Role.RadioButton
                this.selected = selected
                contentDescription = label
            }
            .clickable(onClick = onClick)
            .testTag("stories.editor.font.$font"),
    ) {
        Text(
            "Aa",
            color = Color.White,
            fontFamily = family,
            fontWeight = weight,
            style = MaterialTheme.typography.titleMedium.copy(fontFamily = family, fontWeight = weight),
        )
    }
}

/** The background mode as it looks: an "A" bare, on a solid chip, or on a soft one. */
@Composable
private fun BackgroundModeButton(mode: String, onClick: () -> Unit) {
    val label = stringResource(
        when (mode) {
            "solid" -> R.string.stories_editor_bg_solid
            "soft" -> R.string.stories_editor_bg_soft
            else -> R.string.stories_editor_bg_none
        },
    )
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(48.dp)
            .clip(RoundedCornerShape(50))
            .background(Color.Black.copy(alpha = 0.4f))
            .semantics {
                role = Role.Button
                contentDescription = label
            }
            .clickable(onClick = onClick)
            .testTag("stories.editor.text.background"),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(30.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(
                    when (mode) {
                        "solid" -> Color.White
                        "soft" -> Color.White.copy(alpha = 0.35f)
                        else -> Color.Transparent
                    },
                )
                .border(1.5.dp, Color.White, RoundedCornerShape(8.dp)),
        ) {
            Text(
                "A",
                color = if (mode == "solid") Color.Black else Color.White,
                fontWeight = FontWeight.ExtraBold,
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}
