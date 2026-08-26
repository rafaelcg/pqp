package gg.pqp.app.social.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.screens.ServersScreen
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes

/**
 * The signed-in home: servers, messages, friends.
 *
 * A bottom `NavigationBar` rather than the single scrolling list #103 started
 * with, because three peer destinations with live counts is exactly what the
 * component is for, and because a badge nobody can see is a badge that does not
 * work: the whole point of the friend and DM frames is that they land while
 * you are looking at something else.
 *
 * The tabs are state rather than nested navigation destinations. The list is
 * fixed at three, none of them is deep-linkable on its own, and a nested
 * `NavHost` would put a second back stack under the real one, which is how a
 * back gesture starts doing two different things depending on how you got here.
 * `BackHandler` gives the platform behaviour instead: back from any tab returns
 * to the first, and back from the first leaves.
 *
 * ## The bar itself
 *
 * This is the one piece of chrome on screen on every tab, so it is the piece
 * that decides whether the app looks like pqp or like Settings. It sits on
 * `surfaceContainerLowest` with a hairline above it, which is deeper than the
 * page it frames: the design language's whole claim is that a screen is a sheet
 * laid on a rail, and Material's instinct to lighten a bar is the thing being
 * argued with. The selected destination is the one lime object here, and it is
 * lime three times over (indicator, glyph, label) because they are one object.
 */
@Composable
fun HomeScreen(
    session: SessionStore,
    onOpenServer: (ServerSummary) -> Unit,
    onOpenConversation: (ConversationRoute) -> Unit,
    onOpenProfile: () -> Unit,
) {
    val social = remember { SocialRepository.of(session) }
    var tab by rememberSaveable { mutableStateOf(HomeTab.Servers) }
    var startingConversation by remember { mutableStateOf(false) }

    // The route carries the title because a conversation has no name of its own,
    // and the caller is the one holding the participants. Resolved here so the
    // navigation graph never has to reach for a string resource.
    val emptyTitle = stringResource(R.string.dms_empty_conversation)
    val open: (DmSummary) -> Unit = { conversation ->
        onOpenConversation(ConversationRoute(conversation.channelId, conversation.titleOr(emptyTitle)))
    }

    val conversations by social.conversations.collectAsStateWithLifecycle()
    val friends by social.friends.collectAsStateWithLifecycle()

    // Rows with something unread, not messages: "4" next to Messages means four
    // conversations want you, which is the number a person can act on. A sum of
    // message counts would say 200 for one chatty group.
    val unreadConversations = conversations.count { it.unread.count > 0 }
    val pendingRequests = friends.pendingCount

    BackHandler(enabled = tab != HomeTab.Servers) { tab = HomeTab.Servers }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        bottomBar = {
            Column {
                ChromeDivider()
                NavigationBar(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                ) {
                    HomeTab.entries.forEach { entry ->
                        val badge = when (entry) {
                            HomeTab.Messages -> unreadConversations
                            HomeTab.Friends -> pendingRequests
                            HomeTab.Servers -> 0
                        }
                        NavigationBarItem(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            icon = {
                                BadgedBox(
                                    badge = {
                                        // A pending friend request is a thing to
                                        // act on, and acting on it is the only
                                        // way it goes away, so it earns the loud
                                        // colour. Unread conversations do not:
                                        // the number already says there is
                                        // something there, and a second lime
                                        // object on the bar would make neither
                                        // of them mean anything.
                                        CountBadge(
                                            count = badge,
                                            loud = entry == HomeTab.Friends,
                                        )
                                    },
                                ) {
                                    Icon(
                                        imageVector = when (entry) {
                                            HomeTab.Servers -> PqpIcons.Server
                                            HomeTab.Messages -> PqpIcons.Messages
                                            HomeTab.Friends -> PqpIcons.People
                                        },
                                        contentDescription = null,
                                        modifier = Modifier.size(Sizes.iconAction),
                                    )
                                }
                            },
                            label = {
                                Text(
                                    text = stringResource(entry.label),
                                    style = MaterialTheme.typography.labelLarge,
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
                                // Low alpha, because a solid lime pill behind a
                                // lime glyph would leave the glyph unreadable
                                // and would be the loudest thing on every
                                // screen in the app at once.
                                indicatorColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
                                unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            ),
                            modifier = Modifier.testTag("home.tab.${entry.name.lowercase()}"),
                        )
                    }
                }
            }
        },
    ) { padding ->
        // Only the bottom inset is consumed here. Each tab brings its own
        // Scaffold and its own top app bar, and adding the top inset twice
        // pushes every large title down by a status bar's height.
        Box(
            Modifier
                .fillMaxSize()
                .padding(bottom = padding.calculateBottomPadding()),
        ) {
            // A cross-fade and deliberately not a slide. The three tabs are
            // peers: a slide has a direction, a direction implies an order, and
            // the back gesture here does not honour that order (back from any
            // tab goes to the first, not to the one on its left). Fading says
            // "a different thing is here now" without claiming anything about
            // where it came from.
            AnimatedContent(
                targetState = tab,
                transitionSpec = {
                    fadeIn(tween(Motion.QUICK_MILLIS)) togetherWith fadeOut(tween(Motion.QUICK_MILLIS))
                },
                label = "home-tab",
            ) { current ->
                when (current) {
                    HomeTab.Servers -> ServersScreen(
                        session = session,
                        onOpenServer = onOpenServer,
                        onOpenProfile = onOpenProfile,
                    )

                    HomeTab.Messages -> ConversationsScreen(
                        social = social,
                        onOpen = open,
                        onNewConversation = { startingConversation = true },
                    )

                    HomeTab.Friends -> FriendsScreen(
                        social = social,
                        api = session.api,
                        onOpenConversation = open,
                    )
                }
            }
        }
    }

    if (startingConversation) {
        NewConversationSheet(
            social = social,
            onDismiss = { startingConversation = false },
            onOpened = open,
        )
    }
}

enum class HomeTab(val label: Int) {
    Servers(R.string.servers_title),
    Messages(R.string.dms_title),
    Friends(R.string.friends_title),
}
