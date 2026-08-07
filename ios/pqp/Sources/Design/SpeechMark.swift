import SwiftUI

/// The pqp mark, drawn rather than shipped as an image so it can animate.
///
/// Same geometry as `scripts/generate-icons.py`: a rounded bubble with a tail
/// and three dots. Vector here means the onboarding can stagger the dots and
/// scale the bubble without a sprite sheet.
struct SpeechMark: View {
    var size: CGFloat = 96
    /// 0…1 — how far through the dot sequence the mark is. Driving this from
    /// outside is what lets onboarding choreograph it against other elements.
    var dotProgress: Double = 1

    private var bubbleWidth: CGFloat { size }
    private var bubbleHeight: CGFloat { size * 0.78 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            BubbleShape()
                .fill(Palette.signal)
                .frame(width: bubbleWidth, height: bubbleHeight * 1.32)

            HStack(spacing: bubbleWidth * 0.13) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Palette.inkDeep)
                        .frame(width: bubbleHeight * 0.21, height: bubbleHeight * 0.21)
                        .scaleEffect(dotScale(index))
                        .opacity(dotOpacity(index))
                }
            }
            .frame(width: bubbleWidth, height: bubbleHeight, alignment: .center)
        }
        .frame(width: bubbleWidth, height: bubbleHeight * 1.32)
    }

    /// Each dot occupies a third of the progress range, so they land in turn
    /// rather than together.
    private func windowed(_ index: Int) -> Double {
        let start = Double(index) * 0.22
        return min(1, max(0, (dotProgress - start) / 0.34))
    }

    private func dotScale(_ index: Int) -> CGFloat {
        let t = windowed(index)
        // Slight overshoot, settling back — a dot that arrives at exactly 1
        // looks like it was always there.
        return CGFloat(0.4 + 0.75 * t - 0.15 * t * t)
    }

    private func dotOpacity(_ index: Int) -> Double {
        windowed(index)
    }
}

/// Rounded rect body plus the tail, as one filled path so the join is seamless.
private struct BubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let bodyHeight = rect.height / 1.32
        let radius = bodyHeight * 0.30
        var path = Path()
        path.addRoundedRect(
            in: CGRect(x: 0, y: 0, width: rect.width, height: bodyHeight),
            cornerSize: CGSize(width: radius, height: radius),
            style: .continuous
        )

        let tailX = rect.width * 0.24
        let tailWidth = rect.width * 0.20
        let tailHeight = bodyHeight * 0.30
        var tail = Path()
        // Starts 2pt inside the body so the two fills overlap instead of
        // meeting on a seam that shows as a hairline at some scales.
        tail.move(to: CGPoint(x: tailX, y: bodyHeight - 2))
        tail.addLine(to: CGPoint(x: tailX + tailWidth, y: bodyHeight - 2))
        tail.addLine(to: CGPoint(x: tailX + tailWidth * 0.15, y: bodyHeight + tailHeight))
        tail.closeSubpath()

        path.addPath(tail)
        return path
    }
}

#Preview {
    ZStack {
        Palette.ink.ignoresSafeArea()
        SpeechMark(size: 120)
    }
}
