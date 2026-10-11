package gg.pqp.app.ui.screens.channels

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.monogramColor
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/** The banner at rest, below the status bar. */
val ServerBannerHeight = 132.dp

/** The compact bar the banner turns into, below the status bar. */
val CompactBarHeight = 56.dp

/**
 * The server's banner, at the top of the list: its picture (or its colour),
 * its name, and what is going on in it right now.
 *
 * It scrolls with the list, at half speed for the picture, and hands over to
 * [CompactServerBar] once it is mostly gone. The name is drawn in exactly one
 * of the two at a time, so it never appears twice on screen.
 */
@Composable
fun ServerBanner(
    serverId: String,
    serverName: String,
    bannerUrl: String?,
    activity: ServerActivity,
    /** How far the banner has scrolled up, in px, for the parallax. */
    scrolledPx: () -> Float,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val picture = Backend.absolute(bannerUrl)
    // The picture runs up behind the status bar; only the text and the
    // height respect the inset.
    Box(
        modifier = modifier
            .fillMaxWidth()
            .testTag("channels.banner"),
    ) {
        Box(
            Modifier
                .matchParentSize()
                .graphicsLayer { translationY = scrolledPx() * 0.5f }
                .background(
                    Brush.verticalGradient(
                        listOf(monogramColor(serverId).copy(alpha = 0.55f), colors.background),
                    ),
                ),
        ) {
            if (picture != null) {
                AsyncImage(
                    model = picture,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        // The scrim the name sits on, fading into the page so the banner has
        // no hard bottom edge.
        Box(
            Modifier
                .matchParentSize()
                .background(
                    Brush.verticalGradient(
                        0f to Color.Transparent,
                        0.45f to colors.background.copy(alpha = 0.35f),
                        1f to colors.background,
                    ),
                ),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .height(ServerBannerHeight)
                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
            verticalArrangement = Arrangement.Bottom,
        ) {
            Text(
                text = serverName,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!activity.isEmpty) {
                Spacer(Modifier.height(2.dp))
                ActivityLine(activity)
            }
        }
    }
}

/** "8 em call · 1 ao vivo", each with its own coloured dot. */
@Composable
fun ActivityLine(activity: ServerActivity, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        if (activity.inCall > 0) {
            Dot(Palette.Signal)
            Text(
                text = pluralStringResource(R.plurals.channels_activity_in_call, activity.inCall, activity.inCall),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (activity.live > 0) {
            if (activity.inCall > 0) Spacer(Modifier.width(Spacing.sm))
            Dot(MaterialTheme.colorScheme.error)
            Text(
                text = pluralStringResource(R.plurals.channels_activity_live, activity.live, activity.live),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Dot(color: Color) {
    Box(
        Modifier
            .padding(end = 5.dp)
            .size(6.dp)
            .clip(CircleShape)
            .background(color),
    )
}

/**
 * The bar the banner turns into on scroll: back, the name, the activity line.
 * [progress] runs 0 (banner showing) to 1 (banner gone) and fades the bar in
 * on a spring. The back button is always there; over the banner it sits on a
 * dark disc so it reads on any picture.
 */
@Composable
fun CompactServerBar(
    serverName: String,
    activity: ServerActivity,
    collapsed: Boolean,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val shown by animateFloatAsState(
        targetValue = if (collapsed) 1f else 0f,
        animationSpec = spring(dampingRatio = 0.9f, stiffness = 500f),
        label = "compact-bar",
    )
    Column(modifier.fillMaxWidth()) {
        Box(
            Modifier
                .fillMaxWidth()
                .background(colors.surfaceContainerLowest.copy(alpha = shown))
                .windowInsetsPadding(WindowInsets.statusBars)
                .height(CompactBarHeight),
        ) {
            Row(
                modifier = Modifier.fillMaxSize().padding(end = Spacing.gutter),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.padding(start = Spacing.xs).testTag("channels.back"),
                ) {
                    Box(
                        Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(Color.Black.copy(alpha = 0.35f * (1f - shown))),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = PqpIcons.Back,
                            contentDescription = stringResource(R.string.chat_back),
                            tint = colors.onSurface,
                            modifier = Modifier.size(Sizes.iconAction),
                        )
                    }
                }
                Column(
                    Modifier
                        .weight(1f)
                        .alpha(shown)
                        .graphicsLayer { translationY = (1f - shown) * 12.dp.toPx() },
                ) {
                    Text(
                        text = serverName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!activity.isEmpty) ActivityLine(activity)
                }
            }
        }
        if (shown > 0.01f) ChromeDivider(Modifier.alpha(shown))
    }
}
