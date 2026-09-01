package gg.pqp.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/*
 * The icon set.
 *
 * ## Why not the Material icons
 *
 * `Icons.Default.*` is Material Icons Filled: solid shapes at a single optical
 * size, drawn for a design language that is not this one. Two problems, and the
 * second is the one that matters. The first is that a filled glyph next to
 * Instrument Sans at 15sp is heavier than every letter beside it, so an icon
 * always wins a row it was only meant to label. The second is that they are the
 * single most recognisable "this is a default Android app" signal there is:
 * `Icons.Filled.Dns` for a server, `Icons.Filled.Tag` for a channel and
 * `Icons.Filled.Person` for a person are three shapes every Android user has
 * seen in Settings this week.
 *
 * ## What this is instead
 *
 * **Lucide**, drawn here as `ImageVector`s from Lucide's own path data. One
 * stroke language throughout: a 24 unit box, 2 unit strokes, round caps, round
 * joins, no fills. That geometry is the same geometry Gabarito is built on, so
 * the icons and the headings look like they came from one place.
 *
 * ## Licence
 *
 * Lucide is ISC-licensed, and the notice is reproduced in full below as the
 * licence requires. Nothing is fetched at build time and there is no
 * dependency: the paths are checked in, so an icon can be nudged by hand and
 * the set cannot drift under the app.
 *
 * ```
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
 * of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
 * Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 * ```
 *
 * ## Adding one
 *
 * Take the drawing primitives out of the Lucide SVG, in order, and pass them to
 * `lucide()`. `<path>` carries its `d` verbatim; `<line>`, `<circle>` and
 * `<rect>` have to be rewritten as path data, which is why `hash` below is four
 * `M…L…` moves rather than four `<line>` elements.
 */
/**
 * `by lazy`, not `=`: an `ImageVector` is a tree, building it is not free, and a
 * `val` initialised eagerly would build all forty of them the first time
 * anything here is touched. The colour is a placeholder because `Icon()` tints
 * what it draws.
 */
private fun lucide(vararg paths: String) = lazy {
    ImageVector.Builder(
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        paths.forEach { d ->
            addPath(
                pathData = addPathNodes(d),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
}

/**
 * The same glyph, filled and unstroked: the one state Lucide draws that way
 * itself (a liked heart is `fill="currentColor"` on lucide.dev too). Kept to
 * that one job so the set stays a stroke set.
 */
private fun lucideFilled(vararg paths: String) = lazy {
    ImageVector.Builder(
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        paths.forEach { d ->
            addPath(
                pathData = addPathNodes(d),
                fill = SolidColor(Color.Black),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
}

/**
 * The glyphs, named as Lucide names them, so a shape can be found by searching
 * lucide.dev and matched here.
 *
 * Private, and that is not only tidiness: `Lucide.search` and a public
 * `PqpIcons.Search` compile to the same JVM getter, so the two layers have to
 * live in different scopes. The app never addresses a glyph directly; it
 * addresses the job, below.
 */
private object Lucide {

    val archive by lucide(
        "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
        "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",
        "M10 12h4",
    )
    val arrowLeft by lucide(
        "m12 19-7-7 7-7",
        "M19 12H5",
    )
    val atSign by lucide(
        "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
        "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8",
    )
    val ban by lucide(
        "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
        "M4.929 4.929 19.07 19.071",
    )
    val bell by lucide(
        "M10.268 21a2 2 0 0 0 3.464 0",
        "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
    )
    val check by lucide(
        "M20 6 9 17l-5-5",
    )
    val chevronDown by lucide(
        "m6 9 6 6 6-6",
    )
    val chevronRight by lucide(
        "m9 18 6-6-6-6",
    )
    val circleAlert by lucide(
        "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
        "M12 8L12 12",
        "M12 16L12.01 16",
    )
    val download by lucide(
        "M12 15V3",
        "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
        "m7 10 5 5 5-5",
    )
    val ellipsisVertical by lucide(
        "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
        "M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
        "M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    )
    val hash by lucide(
        "M4 9L20 9",
        "M4 15L20 15",
        "M10 3L8 21",
        "M16 3L14 21",
    )
    val headphoneOff by lucide(
        "M21 14h-1.343",
        "M9.128 3.47A9 9 0 0 1 21 12v3.343",
        "m2 2 20 20",
        "M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3",
        "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364",
    )
    val headphones by lucide(
        "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3",
    )
    val heart by lucide(
        "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
    )
    val heartFilled by lucideFilled(
        "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
    )
    val inbox by lucide(
        "M22 12L16 12L14 15L10 15L8 12L2 12",
        "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    )
    val layers by lucide(
        "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
        "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
        "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
    )
    val lock by lucide(
        "M5 11H19A2 2 0 0 1 21 13V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V13A2 2 0 0 1 5 11Z",
        "M7 11V7a5 5 0 0 1 10 0v4",
    )
    val logOut by lucide(
        "m16 17 5-5-5-5",
        "M21 12H9",
        "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    )
    val maximize by lucide(
        "M8 3H5a2 2 0 0 0-2 2v3",
        "M21 8V5a2 2 0 0 0-2-2h-3",
        "M3 16v3a2 2 0 0 0 2 2h3",
        "M16 21h3a2 2 0 0 0 2-2v-3",
    )
    val messageCircle by lucide(
        "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
    )
    val micOff by lucide(
        "M12 19v3",
        "M15 9.34V5a3 3 0 0 0-5.68-1.33",
        "M16.95 16.95A7 7 0 0 1 5 12v-2",
        "M18.89 13.23A7 7 0 0 0 19 12v-2",
        "m2 2 20 20",
        "M9 9v3a3 3 0 0 0 5.12 2.12",
    )
    val mic by lucide(
        "M12 19v3",
        "M19 10v2a7 7 0 0 1-14 0v-2",
        "M12 2H12A3 3 0 0 1 15 5V12A3 3 0 0 1 12 15H12A3 3 0 0 1 9 12V5A3 3 0 0 1 12 2Z",
    )
    val minimize by lucide(
        "M8 3v3a2 2 0 0 1-2 2H3",
        "M21 8h-3a2 2 0 0 1-2-2V3",
        "M3 16h3a2 2 0 0 1 2 2v3",
        "M16 21v-3a2 2 0 0 1 2-2h3",
    )
    val paperclip by lucide(
        "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
    )
    val pencil by lucide(
        "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
        "m15 5 4 4",
    )
    val phoneOff by lucide(
        "M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272",
        "M22 2 2 22",
        "M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473",
    )
    val phone by lucide(
        "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
    )
    val play by lucide(
        // Lucide draws this as `<polygon points="6 3 20 12 6 21 6 3"/>`.
        // Rewritten as path data because `lucide()` takes `d` strings only,
        // and closed with `Z` so the round join at the back edge is drawn.
        "M6 3 20 12 6 21Z",
    )
    val plus by lucide(
        "M5 12h14",
        "M12 5v14",
    )
    val refreshCw by lucide(
        "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
        "M21 3v5h-5",
        "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
        "M8 16H3v5",
    )
    val screenShareOff by lucide(
        "M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3",
        "M8 21h8",
        "M12 17v4",
        "m22 3-5 5",
        "m17 3 5 5",
    )
    val screenShare by lucide(
        "M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3",
        "M8 21h8",
        "M12 17v4",
        "m17 8 5-5",
        "M17 3h5v5",
    )
    val search by lucide(
        "m21 21-4.34-4.34",
        "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
    )
    val send by lucide(
        "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        "m21.854 2.147-10.94 10.939",
    )
    val settings by lucide(
        "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
        "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    )
    val trash2 by lucide(
        "M10 11v6",
        "M14 11v6",
        "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
        "M3 6h18",
        "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    )
    val userPlus by lucide(
        "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
        "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
        "M19 8L19 14",
        "M22 11L16 11",
    )
    val user by lucide(
        "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
        "M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
    )
    val users by lucide(
        "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
        "M16 3.128a4 4 0 0 1 0 7.744",
        "M22 21v-2a4 4 0 0 0-3-3.87",
        "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
    )
    val volume2 by lucide(
        "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
        "M16 9a5 5 0 0 1 0 6",
        "M19.364 18.364a9 9 0 0 0 0-12.728",
    )
    val volumeX by lucide(
        "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
        "M22 9L16 15",
        "M16 9L22 15",
    )
    val x by lucide(
        "M18 6 6 18",
        "m6 6 12 12",
    )

}

/**
 * The icon set, addressed by job.
 */
object PqpIcons {

    // ---------------------------------------------------------------------
    // What the app calls things.
    //
    // Screens address an icon by the job it does, not by the shape it is, so
    // swapping the glyph for "leave the call" is one line here rather than a
    // sweep through six files. It is also the only place the choices can be
    // argued with, and two of them are worth arguing about:
    //
    //  - **Deafen is headphones, not a crossed-out speaker.** The old
    //    `VolumeOff` was the same metaphor as mute one button along, so the
    //    two loudest controls in a call were a crossed microphone and a
    //    crossed speaker. Ears and mouth are different organs and the icons
    //    should say so.
    //  - **A server is `layers`, not `Dns`.** `Dns` is a rack of servers,
    //    which is what the word means to an administrator and not what it
    //    means to somebody joining a place to talk in.
    // ---------------------------------------------------------------------

    /** Back, in the reading direction. Mirrored for RTL by the call site. */
    val Back get() = Lucide.arrowLeft
    val Close get() = Lucide.x
    val More get() = Lucide.ellipsisVertical
    val Forward get() = Lucide.chevronRight
    val Expand get() = Lucide.chevronDown
    val Confirm get() = Lucide.check
    val Add get() = Lucide.plus
    val Edit get() = Lucide.pencil
    val Delete get() = Lucide.trash2
    val Export get() = Lucide.download
    val Retry get() = Lucide.refreshCw
    val Search get() = Lucide.search
    val Settings get() = Lucide.settings
    val SignOut get() = Lucide.logOut
    val Notifications get() = Lucide.bell
    val Warning get() = Lucide.circleAlert
    val Attach get() = Lucide.paperclip

    /** Start playing a video attachment. */
    val Play get() = Lucide.play

    /** A place with channels in it. */
    val Server get() = Lucide.layers
    val TextChannel get() = Lucide.hash
    val VoiceChannel get() = Lucide.volume2
    val PrivateChannel get() = Lucide.lock

    val Person get() = Lucide.user
    val People get() = Lucide.users
    val AddFriend get() = Lucide.userPlus
    val Block get() = Lucide.ban
    val Handle get() = Lucide.atSign

    val Messages get() = Lucide.messageCircle
    val Send get() = Lucide.send

    /** The Baú: a server's chest of posts that stay. A box, not a feed icon. */
    val Bau get() = Lucide.archive

    /** A like on a Baú post, outline until it is yours. */
    val Like get() = Lucide.heart
    val LikeFilled get() = Lucide.heartFilled
    val Empty get() = Lucide.inbox

    val Mic get() = Lucide.mic
    val MicMuted get() = Lucide.micOff
    val Listening get() = Lucide.headphones
    val Deafened get() = Lucide.headphoneOff
    val Speakerphone get() = Lucide.volume2
    val Earpiece get() = Lucide.phone
    val HangUp get() = Lucide.phoneOff
    val ShareScreen get() = Lucide.screenShare
    val StopSharing get() = Lucide.screenShareOff
    val EnterFullscreen get() = Lucide.maximize
    val ExitFullscreen get() = Lucide.minimize
}
