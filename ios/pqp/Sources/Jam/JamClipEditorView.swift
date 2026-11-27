import SwiftUI

/// THE CLIP: a take drawn on the song's timeline under the band's waveform
/// (`jam-clip-editor.tsx`). The picture is built only from opaque palette
/// colours: the heard stretch is the instrument's colour, what a cut hides is
/// the raised surface with its bars in the border colour, the band is a row of
/// thin muted bars, and the song's start is one lime line.
///
/// Three grips, each its own drag and its own adjustable element for VoiceOver:
/// the start handle and the end handle cut, the middle moves the whole take.
/// A grip freezes the window it was picked up in, so the frame never slides
/// under a finger.
struct JamClipEditorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let track: JamTrack
    let source: JamClipSource
    let edits: JamClipEdits
    let band: [JamClipMath.BandLane]
    let zoom: JamClipMath.Zoom
    let song: JamSongModel
    @Binding var grabbing: Bool
    let onTrimStart: (Double) -> Void
    let onTrimEnd: (Double) -> Void
    let onNudge: (Double) -> Void

    enum Grip: Equatable { case start, end, body }

    private struct Hold {
        var grip: Grip
        var edits: JamClipEdits
        var window: JamClipWindow
    }

    @State private var hold: Hold?
    @State private var width: CGFloat = 0

    static let height: CGFloat = 156
    private static let bandHeight: CGFloat = 50
    private static let takeTop: CGFloat = 58
    private static let takeBottom: CGFloat = 12
    private static let handleHit: CGFloat = 44

    private var window: JamClipWindow { hold?.window ?? JamClipMath.window(source, edits, zoom: zoom) }

    var body: some View {
        let view = window
        let span = JamClipMath.span(source, edits)
        let reach = JamClipMath.reach(source, nudgeMs: edits.nudgeMs)
        let w = max(1, width)
        let spanLeft = JamClipMath.fraction(view, span.startMs) * w
        let spanRight = JamClipMath.fraction(view, span.endMs) * w
        let reachLeft = JamClipMath.fraction(view, reach.startMs) * w
        let reachRight = JamClipMath.fraction(view, reach.endMs) * w
        let takeHeight = Self.height - Self.takeTop - Self.takeBottom

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.inkDeep)

            // The band, on its own row right above the take: the beat to line up with.
            ZStack {
                Rectangle().fill(Palette.surface)
                JamClipBars(
                    values: JamClipMath.bandEnvelope(band, window: view, count: max(1, Int(w / 5))),
                    color: Palette.paperMuted, barWidth: 2.5, gap: 2.5
                )
                .padding(.vertical, 8)
            }
            .frame(width: w, height: Self.bandHeight)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
            .accessibilityHidden(true)

            // Where the song starts: the line a first note lines up with.
            if view.startMs < 0, view.endMs > 0 {
                Rectangle().fill(Palette.signal).frame(width: 1.5, height: Self.height)
                    .offset(x: JamClipMath.fraction(view, 0) * w - 0.75)
                    .accessibilityHidden(true)
            }

            // The take: its whole reach, the cut parts quiet, the heard part in colour.
            JamClipTake(
                bars: JamClipMath.bars(peaks: track.peaks, source: source, count: max(1, Int(max(0, reachRight - reachLeft) / 4))),
                color: track.instrument.color,
                heardFrom: reachRight > reachLeft ? (spanLeft - reachLeft) / (reachRight - reachLeft) : 0,
                heardTo: reachRight > reachLeft ? (spanRight - reachLeft) / (reachRight - reachLeft) : 1,
                level: JamClipMath.level(ofGain: edits.gain)
            )
            .frame(width: max(0, reachRight - reachLeft), height: takeHeight)
            .offset(x: reachLeft, y: Self.takeTop)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: edits.gain)
            .accessibilityHidden(true)

            // The middle: drag to move the take in time.
            Color.clear
                .frame(width: max(0, spanRight - spanLeft), height: takeHeight)
                .contentShape(Rectangle())
                .offset(x: spanLeft, y: Self.takeTop)
                .gesture(drag(.body))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Move the recording in time"))
                .accessibilityValue(Text(verbatim: JamAdjustSheet.nudgeWords(edits.nudgeMs)))
                .accessibilityHint(Text("Swipe up to move it later, down to move it earlier."))
                .accessibilityAdjustableAction { direction in
                    onNudge(edits.nudgeMs + (direction == .increment ? 1 : -1) * JamClipEdits.bodyStepMs)
                }
                .accessibilityIdentifier("jam.adjust.body")

            handle(.start, x: spanLeft, height: takeHeight)
            handle(.end, x: spanRight, height: takeHeight)

            // The playhead, drawn from the engine's own clock.
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !song.isPlaying)) { _ in
                let _ = song.seekRevision
                let songMs = song.engine.originMs + song.positionMs
                let inside = songMs >= view.startMs && songMs <= view.endMs
                Rectangle().fill(Palette.paper).frame(width: 2, height: Self.height)
                    .offset(x: JamClipMath.fraction(view, songMs) * w - 1)
                    .opacity(inside ? 1 : 0)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("jam.adjust.clip")
    }

    // MARK: Handles

    private func handle(_ grip: Grip, x: CGFloat, height: CGFloat) -> some View {
        let value = grip == .start ? max(0, edits.trimStartMs - source.minTrimStartMs) : edits.trimEndMs
        let active = hold?.grip == grip
        return ZStack {
            Capsule()
                .fill(Palette.paper)
                .frame(width: 10, height: height + 8)
                .overlay(
                    VStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { _ in Capsule().fill(Palette.inkDeep).frame(width: 4, height: 2) }
                    }
                )
                .overlay(Capsule().strokeBorder(Palette.inkDeep, lineWidth: 2))
                .scaleEffect(x: active && !reduceMotion ? 1.25 : 1, y: 1)
                .animation(reduceMotion ? nil : .jamQuick(reduceMotion: false), value: active)
        }
        .frame(width: Self.handleHit, height: max(Self.handleHit, height + 8))
        .contentShape(Rectangle())
        .offset(x: x - Self.handleHit / 2, y: Self.takeTop - 4)
        .gesture(drag(grip))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(grip == .start ? "Cut the start" : "Cut the end"))
        .accessibilityValue(Text("\(String(format: "%.1f", value / 1000)) s cut"))
        .accessibilityHint(Text("Swipe up to move the handle right, down to move it left."))
        .accessibilityAdjustableAction { direction in
            let sign: Double = direction == .increment ? 1 : -1
            if grip == .start {
                onTrimStart(edits.trimStartMs + sign * JamClipEdits.handleStepMs)
            } else {
                onTrimEnd(edits.trimEndMs - sign * JamClipEdits.handleStepMs)
            }
        }
        .accessibilityIdentifier(grip == .start ? "jam.adjust.handle.start" : "jam.adjust.handle.end")
    }

    // MARK: Dragging

    private func drag(_ grip: Grip) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if hold == nil {
                    hold = Hold(grip: grip, edits: edits, window: JamClipMath.window(source, edits, zoom: zoom))
                    grabbing = true
                    Haptics.selection()
                }
                guard let grab = hold, grab.grip == grip else { return }
                let ms = Double(value.translation.width) * JamClipMath.msPerPoint(grab.window, width: Double(width))
                switch grip {
                case .start: onTrimStart(grab.edits.trimStartMs + ms)
                case .end: onTrimEnd(grab.edits.trimEndMs - ms)
                case .body: onNudge(grab.edits.nudgeMs + ms)
                }
            }
            .onEnded { _ in
                hold = nil
                grabbing = false
            }
    }
}

// MARK: - Drawing

/// Thin vertical bars from 0...1 values, centred on a line: the band.
private struct JamClipBars: View {
    let values: [Double]
    let color: Color
    var barWidth: CGFloat = 3
    var gap: CGFloat = 2

    var body: some View {
        Canvas { context, size in
            guard !values.isEmpty else { return }
            let step = barWidth + gap
            let count = max(1, Int((size.width + gap) / step))
            for i in 0..<count {
                let lo = i * values.count / count
                let hi = max(lo + 1, (i + 1) * values.count / count)
                let peak = values[min(lo, values.count - 1)..<min(hi, values.count)].max() ?? 0
                let height = max(2, CGFloat(min(1, max(0, peak))) * size.height)
                let rect = CGRect(x: CGFloat(i) * step, y: (size.height - height) / 2, width: barWidth, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(color))
            }
        }
    }
}

/// The take's own bars across its whole reach: the heard stretch in the
/// instrument's colour with ink bars, the rest on the raised surface with
/// border-coloured bars, so a cut reads as a cut and not as missing audio.
private struct JamClipTake: View {
    let bars: [Double]
    let color: Color
    /// Where the heard stretch starts and ends, as fractions of this view.
    let heardFrom: Double
    let heardTo: Double
    let level: Double

    var body: some View {
        Canvas { context, size in
            let outer = RoundedRectangle(cornerRadius: 8, style: .continuous).path(in: CGRect(origin: .zero, size: size))
            context.fill(outer, with: .color(Palette.surfaceRaised))
            let from = size.width * CGFloat(min(1, max(0, heardFrom)))
            let to = size.width * CGFloat(min(1, max(0, heardTo)))
            if to > from {
                context.clip(to: outer)
                context.fill(Path(CGRect(x: from, y: 0, width: to - from, height: size.height)), with: .color(color))
            }
            guard !bars.isEmpty else { return }
            let count = max(1, min(bars.count, Int(size.width / 4)))
            let step = size.width / CGFloat(count)
            let usable = size.height - 12
            for i in 0..<count {
                let lo = i * bars.count / count
                let hi = max(lo + 1, (i + 1) * bars.count / count)
                let peak = bars[min(lo, bars.count - 1)..<min(hi, bars.count)].max() ?? 0
                let height = max(3, CGFloat(peak) * usable * CGFloat(min(1, level)))
                let x = CGFloat(i) * step + step * 0.2
                let centre = x + step * 0.3
                let heard = centre >= from && centre <= to
                let rect = CGRect(x: x, y: (size.height - height) / 2, width: max(1.5, step * 0.6), height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(heard ? Palette.inkDeep : Palette.border))
            }
        }
    }
}
