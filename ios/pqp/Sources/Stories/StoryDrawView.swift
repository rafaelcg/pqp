import PencilKit
import SwiftUI
import UIKit

/// Drawing on the story: a pen, a marker, a highlighter and an eraser, twelve
/// colors and a size, with PencilKit doing the strokes. Done exports the
/// strokes as ONE transparent PNG at the canvas aspect, which goes up like any
/// other layer image; it is never burned into the photo.
enum StoryPen: String, CaseIterable, Sendable {
    case pen, marker, highlighter, eraser

    var symbol: String {
        switch self {
        case .pen: "pencil.tip"
        case .marker: "paintbrush.pointed.fill"
        case .highlighter: "highlighter"
        case .eraser: "eraser.fill"
        }
    }

    var label: String {
        switch self {
        case .pen: String(localized: "Pen")
        case .marker: String(localized: "Marker")
        case .highlighter: String(localized: "Highlighter")
        case .eraser: String(localized: "Eraser")
        }
    }

    /// The width a slider position of 0...1 means for this tool, in points of
    /// a canvas 390 wide (scaled with the canvas).
    func width(_ fraction: Double) -> CGFloat {
        switch self {
        case .pen: 2 + 14 * CGFloat(fraction)
        case .marker: 8 + 26 * CGFloat(fraction)
        case .highlighter: 14 + 30 * CGFloat(fraction)
        case .eraser: 8 + 40 * CGFloat(fraction)
        }
    }

    func tool(color: UIColor, fraction: Double, canvasWidth: CGFloat) -> PKTool {
        let scale = canvasWidth / 390
        switch self {
        case .pen:
            return PKInkingTool(.pen, color: color, width: width(fraction) * scale)
        case .marker:
            return PKInkingTool(.monoline, color: color, width: width(fraction) * scale)
        case .highlighter:
            return PKInkingTool(.marker, color: color, width: width(fraction) * scale)
        case .eraser:
            return PKEraserTool(.bitmap, width: width(fraction) * scale)
        }
    }
}

enum StoryDrawingExport {
    /// The canvas pixel width a drawing goes up at. Tall as the canvas: 9:16.
    static let pixelWidth: CGFloat = 810

    /// A transparent PNG of the strokes, at the canvas aspect, in LIGHT trait
    /// so PencilKit does not invert black and white ink for dark mode.
    static func png(_ drawing: PKDrawing, canvas: CGSize) -> (data: Data, preview: UIImage, width: Int, height: Int)? {
        guard canvas.width > 0, canvas.height > 0, !drawing.strokes.isEmpty else { return nil }
        let scale = pixelWidth / canvas.width
        var image: UIImage?
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            image = drawing.image(from: CGRect(origin: .zero, size: canvas), scale: scale)
        }
        guard let image, let data = image.pngData(), data.count <= StoryLayerLimits.maxBytes else { return nil }
        return (data, image, Int((canvas.width * scale).rounded()), Int((canvas.height * scale).rounded()))
    }
}

struct StoryDrawView: View {
    let canvas: CGSize
    let initial: PKDrawing
    let onDone: (PKDrawing?) -> Void

    @State private var drawing: PKDrawing
    @State private var pen: StoryPen = .pen
    @State private var color: StoryTextColor = .white
    @State private var size = 0.35
    @State private var controller = StoryDrawController()
    @State private var tick = 0

    init(canvas: CGSize, initial: PKDrawing, onDone: @escaping (PKDrawing?) -> Void) {
        self.canvas = canvas
        self.initial = initial
        self.onDone = onDone
        _drawing = State(initialValue: initial)
    }

    private var tool: PKTool {
        pen.tool(color: UIColor(color.color), fraction: size, canvasWidth: canvas.width)
    }

    var body: some View {
        ZStack {
            // The canvas underneath stays visible: this overlay only hosts
            // the strokes and the tools, in the same frame as the canvas. The
            // strokes are the BOTTOM of the stack, so the top bar and the tools
            // always win a touch that lands where they overlap it.
            StoryPencilCanvas(drawing: $drawing, tool: tool, controller: controller)
                .frame(width: canvas.width, height: canvas.height)
                .accessibilityLabel(Text("Drawing canvas"))
                .accessibilityIdentifier("draw.canvas")
            // The tools sit inside the picture, in its corners, never across its
            // edge.
            ZStack {
                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                }
                VStack(spacing: 12) {
                    Spacer()
                    sizeRow
                    colorRow
                    penRow
                }
                .padding(.bottom, 10)
            }
            .frame(width: canvas.width, height: canvas.height)
        }
        .sensoryFeedback(.selection, trigger: tick)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { onDone(nil) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(.black.opacity(0.45)))
            }
            .accessibilityLabel(Text("Cancel"))
            .accessibilityIdentifier("draw.cancel")
            Button { controller.undo() } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(.black.opacity(0.45)))
            }
            .accessibilityLabel(Text("Undo"))
            .accessibilityIdentifier("draw.undo")
            Spacer()
            Button { onDone(drawing) } label: {
                Text("Done")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 16)
                    .frame(height: 40)
                    .background(Capsule().fill(Palette.signal))
            }
            .accessibilityIdentifier("draw.done")
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }

    private var sizeRow: some View {
        HStack(spacing: 12) {
            Circle().fill(.white).frame(width: 6, height: 6)
            Slider(value: $size, in: 0...1)
                .tint(.white)
                .accessibilityLabel(Text("Stroke size"))
                .accessibilityIdentifier("draw.size")
            Circle().fill(.white).frame(width: 18, height: 18)
        }
        .padding(.horizontal, 28)
    }

    private var colorRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(StoryTextColor.allCases, id: \.self) { value in
                    Button {
                        color = value
                        if pen == .eraser { pen = .pen }
                        tick += 1
                    } label: {
                        Circle()
                            .fill(value.color)
                            .frame(width: 28, height: 28)
                            .overlay(Circle().strokeBorder(.white, lineWidth: color == value ? 3 : 1.5))
                            .padding(3)
                    }
                    .accessibilityLabel(Text(verbatim: value.label))
                    .accessibilityAddTraits(color == value ? .isSelected : [])
                    .accessibilityIdentifier("draw.color.\(value.rawValue)")
                }
            }
            .padding(.horizontal, 14)
        }
    }

    private var penRow: some View {
        HStack(spacing: 14) {
            ForEach(StoryPen.allCases, id: \.self) { value in
                Button {
                    pen = value
                    tick += 1
                } label: {
                    Image(systemName: value.symbol)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(pen == value ? Palette.inkDeep : .white)
                        .frame(width: 50, height: 44)
                        .background(Capsule().fill(pen == value ? Color.white : Color.white.opacity(0.18)))
                }
                .accessibilityLabel(Text(verbatim: value.label))
                .accessibilityAddTraits(pen == value ? .isSelected : [])
                .accessibilityIdentifier("draw.pen.\(value.rawValue)")
            }
        }
    }
}

/// Reaches the canvas's undo manager from outside the representable.
@MainActor
final class StoryDrawController {
    weak var canvas: PKCanvasView?

    func undo() { canvas?.undoManager?.undo() }
}

private struct StoryPencilCanvas: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    let tool: PKTool
    let controller: StoryDrawController

    func makeUIView(context: Context) -> PKCanvasView {
        let view = PKCanvasView()
        view.backgroundColor = .clear
        view.isOpaque = false
        // A finger draws; this is a phone, not an iPad with a pencil.
        view.drawingPolicy = .anyInput
        // So black ink stays black in a dark app.
        view.overrideUserInterfaceStyle = .light
        view.drawing = drawing
        view.tool = tool
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        controller.canvas = view
        DispatchQueue.main.async { view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ view: PKCanvasView, context: Context) {
        view.tool = tool
        controller.canvas = view
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let parent: StoryPencilCanvas
        init(_ parent: StoryPencilCanvas) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            parent.drawing = canvasView.drawing
        }
    }
}
