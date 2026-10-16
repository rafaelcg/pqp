package gg.pqp.app.stories

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipe
import androidx.test.ext.junit.runners.AndroidJUnit4
import gg.pqp.app.stories.editor.EditorEnv
import gg.pqp.app.stories.editor.EditorSession
import gg.pqp.app.stories.editor.StoryEditor
import gg.pqp.app.stories.editor.TextLayer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The editor's gestures on a real touch pipeline: two fingers scaling and
 * turning a layer, one finger dragging it, a drop on the trash, a tap
 * opening the text tool. A JVM test cannot send a pinch; this one can, so the
 * thing a picky person does first (grab a word, twist it) is exercised here
 * rather than only by hand.
 *
 * Run with `./gradlew :app:connectedDebugAndroidTest` against one emulator.
 * It is not part of CI, which has no device.
 */
@RunWith(AndroidJUnit4::class)
class StoryEditorGestureTest {

    @get:Rule
    val rule = createComposeRule()

    private fun env() = EditorEnv(
        layersEnabled = true,
        isVideo = false,
        muted = false,
        cardBackground = "night",
        audienceLabel = "Amigos",
        canPost = true,
        occupancy = emptyMap(),
    )

    private fun start(session: EditorSession) {
        rule.setContent {
            StoryEditor(
                session = session,
                env = env(),
                base = {},
                onClose = {},
                onToggleMute = {},
                onCardBackground = {},
                onPickGalleryPhoto = {},
                onTakePhoto = {},
                onAudience = {},
                onPost = {},
                callSheet = { _, _ -> },
                mentionSheet = { _, _ -> },
            )
        }
        rule.waitForIdle()
    }

    private fun sessionWithText(): EditorSession = EditorSession().also {
        // Added once on the main thread, before any frame reads it.
        it.add(TextLayer("11111111-1111-1111-1111-111111111111", text = "Bora", font = "bold", size = 1.6f))
    }

    private fun layer(session: EditorSession) = session.layers.filterIsInstance<TextLayer>().single()

    @Test
    fun twoFingersScaleAndTurnTheLayerTogether() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.layer.text").assertIsDisplayed()

        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            val c = Offset(width / 2f, height / 2f)
            val reach = 70f
            // From a short, level pair of fingers to a long pair turned 45 degrees clockwise.
            val a = Math.toRadians(45.0)
            fun at(distance: Float, angle: Double) = Offset(
                c.x + (distance / 2f) * cos(angle).toFloat(),
                c.y + (distance / 2f) * sin(angle).toFloat(),
            )
            pinch(
                start0 = at(reach * 2, PI), end0 = at(reach * 4, PI + a),
                start1 = at(reach * 2, 0.0), end1 = at(reach * 4, a),
                durationMillis = 500,
            )
        }
        rule.waitForIdle()

        val after = layer(session)
        assertTrue("scale grew: ${after.scale}", after.scale > 1.5f)
        assertTrue("turned clockwise: ${after.rotation}", after.rotation > 0.5f && after.rotation < 1.1f)
        // Both fingers were on the middle: it did not wander.
        assertEquals(0.5f, after.x, 0.05f)
        assertEquals(0.5f, after.y, 0.05f)
        // One undo step for the whole gesture.
        assertTrue(session.canUndo)
        session.undo()
        assertEquals(1f, layer(session).scale, 0.001f)
    }

    @Test
    fun aPinchAnywhereTurnsTheLastLayerTouched() {
        val session = sessionWithText()
        start(session)
        // Select it with a small drag (a tap would open the text tool).
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            swipe(Offset(width / 2f, height / 2f), Offset(width / 2f + 30f, height / 2f), 200)
        }
        rule.waitForIdle()
        val moved = layer(session)
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            // Two fingers far from the text, in a corner.
            pinch(
                start0 = Offset(width * 0.15f, height * 0.12f), end0 = Offset(width * 0.05f, height * 0.08f),
                start1 = Offset(width * 0.30f, height * 0.12f), end1 = Offset(width * 0.45f, height * 0.12f),
                durationMillis = 400,
            )
        }
        rule.waitForIdle()
        assertTrue("grew from ${moved.scale} to ${layer(session).scale}", layer(session).scale > moved.scale * 1.3f)
    }

    @Test
    fun oneFingerDragsAndTheMiddleLineHoldsIt() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            // Up and a little to the right of where it sits.
            swipe(Offset(width / 2f, height / 2f), Offset(width * 0.62f, height * 0.3f), 400)
        }
        rule.waitForIdle()
        assertEquals(0.62f, layer(session).x, 0.03f)
        assertEquals(0.3f, layer(session).y, 0.03f)

        // Back to within a few dp of the middle line: it clicks onto exactly 0.5.
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            swipe(Offset(width * 0.62f, height * 0.3f), Offset(width * 0.5f + 4f, height * 0.3f), 400)
        }
        rule.waitForIdle()
        assertEquals(0.5f, layer(session).x, 0.0001f)
    }

    @Test
    fun droppingALayerOnTheTrashDeletesItAndUndoBringsItBack() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            swipe(Offset(width / 2f, height / 2f), Offset(width / 2f, height - 72f * density), 600)
        }
        rule.waitForIdle()
        assertTrue("deleted", session.layers.none { it is TextLayer })
        session.undo()
        rule.waitForIdle()
        assertEquals(1, session.layers.filterIsInstance<TextLayer>().size)
    }

    @Test
    fun aTapOnTextOpensTheTextTool() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput { click(Offset(width / 2f, height / 2f)) }
        rule.waitForIdle()
        rule.onNodeWithTag("stories.editor.text.field").assertIsDisplayed()
    }

    @Test
    fun aLayerCannotLeaveTheRangeTheServerTakes() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.canvas").performTouchInput {
            // Spread far past the maximum scale.
            pinch(
                start0 = Offset(width * 0.45f, height * 0.5f), end0 = Offset(width * 0.02f, height * 0.5f),
                start1 = Offset(width * 0.55f, height * 0.5f), end1 = Offset(width * 0.98f, height * 0.5f),
                durationMillis = 400,
            )
        }
        rule.waitForIdle()
        assertTrue(layer(session).scale <= StoryLayers.SCALE_MAX + 0.0001f)
        assertTrue(abs(layer(session).rotation) <= StoryLayers.ROTATION_MAX)
    }

    @Test
    fun aStrokeBecomesOneUndoableInkLayerAndLeavesNoGhostBehind() {
        val session = sessionWithText()
        start(session)
        rule.onNodeWithTag("stories.editor.tool.draw").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("stories.editor.drawSurface").performTouchInput {
            swipe(Offset(width * 0.2f, height * 0.3f), Offset(width * 0.8f, height * 0.4f), 400)
        }
        rule.waitForIdle()
        val ink = session.layers.filterIsInstance<gg.pqp.app.stories.editor.InkLayer>().single()
        assertEquals(1, ink.strokes.size)
        assertTrue("the stroke has a path", ink.strokes.single().points.size >= 4)
        // The finished stroke is saved; nothing is left drawing.
        assertEquals(null, session.liveStroke)
        // The ink is the lowest layer, under the text.
        assertEquals(ink, session.layers.first())
        session.undo()
        rule.waitForIdle()
        assertTrue("undo took the whole drawing back", session.layers.none { it is gg.pqp.app.stories.editor.InkLayer })
    }
}
