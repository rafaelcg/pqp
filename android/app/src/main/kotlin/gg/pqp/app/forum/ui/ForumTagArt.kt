package gg.pqp.app.forum.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.forum.ForumTag
import gg.pqp.app.ui.theme.lucide

/*
 * What a forum tag looks like and what it is called on this phone.
 *
 * The wire carries an icon KEY from a curated set (`FORUM_TAG_ICONS` in
 * `packages/shared/src/forums.ts`). The web draws each key with a Lucide icon
 * and so does this file, from Lucide's own path data (ISC licence, see
 * `PqpIcons.kt`), so a tag looks the same on both. A key this build has never
 * heard of draws as the tag's legacy emoji, and a tag with neither draws
 * nothing: a newer server never breaks an older phone.
 *
 * A starter tag also carries a `preset` key. While it is set the tag shows the
 * phone's own language ("Dúvida", "Question") whatever language staff typed the
 * stored name in; the server clears it when staff rename the tag.
 *
 * `ForumContractTest` reads the shared list and fails when a key is added there
 * and not here.
 */
object ForumTagIcons {
    private val icons: Map<String, Lazy<ImageVector>> = mapOf(
        "question" to lucide(
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
            "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
            "M12 17h.01",
        ),
        "help" to lucide(
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
            "m4.93 4.93 4.24 4.24",
            "m14.83 9.17 4.24-4.24",
            "m14.83 14.83 4.24 4.24",
            "m9.17 14.83-4.24 4.24",
            "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
        ),
        "bug" to lucide(
            "m8 2 1.88 1.88",
            "M14.12 3.88 16 2",
            "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1",
            "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6",
            "M12 20v-9",
            "M6.53 9C4.6 8.8 3 7.1 3 5",
            "M6 13H2",
            "M3 21c0-2.1 1.7-3.9 3.8-4",
            "M20.97 5c0 2.1-1.6 3.8-3.5 4",
            "M22 13h-4",
            "M17.2 17c2.1.1 3.8 1.9 3.8 4",
        ),
        "idea" to lucide(
            "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
            "M9 18h6",
            "M10 22h4",
        ),
        "feedback" to lucide(
            "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
            "M14.8 7.5a1.84 1.84 0 0 0-2.6 0l-.2.3-.3-.3a1.84 1.84 0 1 0-2.4 2.8L12 13l2.7-2.7c.9-.9.8-2.1.1-2.8",
        ),
        "discussion" to lucide(
            "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
            "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
        ),
        "poll" to lucide(
            "m9 12 2 2 4-4",
            "M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7Z",
            "M22 19H2",
        ),
        "announcement" to lucide(
            "m3 11 18-5v12L3 14v-3z",
            "M11.6 16.8a3 3 0 1 1-5.8-1.6",
        ),
        "news" to lucide(
            "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
            "M18 14h-8",
            "M15 18h-5",
            "M10 6h8v4h-8V6Z",
        ),
        "release" to lucide(
            "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
            "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
            "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
            "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
        ),
        "update" to lucide(
            "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
            "M21 3v5h-5",
            "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
            "M8 16H3v5",
        ),
        "wip" to lucide(
            "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        ),
        "code" to lucide(
            "M16 18L22 12L16 6",
            "M8 6L2 12L8 18",
        ),
        "guide" to lucide(
            "M12 7v14",
            "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        ),
        "rules" to lucide(
            "M15 12h-5",
            "M15 8h-5",
            "M19 17V5a2 2 0 0 0-2-2H4",
            "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
        ),
        "solved" to lucide(
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
            "m9 12 2 2 4-4",
        ),
        "warning" to lucide(
            "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
            "M12 9v4",
            "M12 17h.01",
        ),
        "security" to lucide(
            "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z",
            "M7 11V7a5 5 0 0 1 10 0v4",
        ),
        "pinned" to lucide(
            "M12 17v5",
            "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
        ),
        "event" to lucide(
            "M8 2v4",
            "M16 2v4",
            "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
            "M3 10h18",
            "M8 14h.01",
            "M12 14h.01",
            "M16 14h.01",
            "M8 18h.01",
            "M12 18h.01",
            "M16 18h.01",
        ),
        "showcase" to lucide(
            "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
            "M20 3v4",
            "M22 5h-4",
            "M4 17v2",
            "M5 18H3",
        ),
        "art" to lucide(
            "M13 6.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M17 10.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M8 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M6 12.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z",
        ),
        "photo" to lucide(
            "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
            "M9 13a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
        ),
        "video" to lucide(
            "M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z",
            "m6.2 5.3 3.1 3.9",
            "m12.4 3.4 3.1 4",
            "M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
        ),
        "clip" to lucide(
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z",
            "M7 3v18",
            "M3 7.5h4",
            "M3 12h18",
            "M3 16.5h4",
            "M17 3v18",
            "M17 7.5h4",
            "M17 16.5h4",
        ),
        "stream" to lucide(
            "M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2z",
            "M17 2L12 7L7 2",
        ),
        "music" to lucide(
            "M9 18V5l12-2v13",
            "M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
            "M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
        ),
        "game" to lucide(
            "M6 11L10 11",
            "M8 9L8 13",
            "M15 12L15.01 12",
            "M18 10L18.01 10",
            "M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z",
        ),
        "meme" to lucide(
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
            "M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z",
            "M9 9L9.01 9",
            "M15 9L15.01 9",
        ),
        "offtopic" to lucide(
            "M10 2v2",
            "M14 2v2",
            "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1",
            "M6 2v2",
        ),
        "community" to lucide(
            "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
            "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
            "M22 21v-2a4 4 0 0 0-3-3.87",
            "M16 3.13a4 4 0 0 1 0 7.75",
        ),
        "gift" to lucide(
            "M4 8h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z",
            "M12 8v13",
            "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7",
            "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5",
        ),
        "trophy" to lucide(
            "M6 9H4.5a2.5 2.5 0 0 1 0-5H6",
            "M18 9h1.5a2.5 2.5 0 0 0 0-5H18",
            "M4 22h16",
            "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22",
            "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22",
            "M18 2H6v7a6 6 0 0 0 12 0V2Z",
        ),
        "hot" to lucide(
            "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z",
        ),
        "star" to lucide(
            "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
        ),
        "heart" to lucide(
            "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
        ),
        "link" to lucide(
            "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
            "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
        ),
    )

    /** Every key this build can draw. */
    val keys: Set<String> get() = icons.keys

    fun vector(key: String?): ImageVector? = key?.let { icons[it]?.value }
}

/** The preset's name resource, or null for a tag with no (known) preset. */
internal fun forumTagPresetRes(preset: String?): Int? = when (preset) {
    "question" -> R.string.forum_tag_preset_question
    "bug" -> R.string.forum_tag_preset_bug
    "suggestion" -> R.string.forum_tag_preset_suggestion
    "tutorial" -> R.string.forum_tag_preset_tutorial
    "release" -> R.string.forum_tag_preset_release
    "wip" -> R.string.forum_tag_preset_wip
    "discussion" -> R.string.forum_tag_preset_discussion
    else -> null
}

/**
 * What the tag is called on this screen. Test tags keep using the tag's id,
 * which does not change with the language.
 */
@Composable
fun ForumTag.displayName(): String =
    forumTagPresetRes(preset)?.let { stringResource(it) } ?: name

/**
 * The picture at the start of a tag chip: the icon when there is one, the
 * emoji an older row still carries when there is not, nothing otherwise.
 * Decorative: the name beside it says everything.
 */
@Composable
fun ForumTagGlyph(tag: ForumTag, size: Dp = 14.dp, modifier: Modifier = Modifier) {
    val vector = ForumTagIcons.vector(tag.icon)
    if (vector != null) {
        Icon(
            imageVector = vector,
            contentDescription = null,
            tint = LocalContentColor.current,
            modifier = modifier.size(size),
        )
    } else {
        tag.emoji?.takeIf { it.isNotBlank() }?.let { emoji ->
            Text(text = emoji, style = MaterialTheme.typography.labelMedium, modifier = modifier)
        }
    }
}

/** True when [ForumTagGlyph] would draw something, so a row can skip the gap. */
fun ForumTag.hasGlyph(): Boolean =
    ForumTagIcons.vector(icon) != null || !emoji.isNullOrBlank()
