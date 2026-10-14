import SwiftUI
import UIKit

/// Typing a text layer, IN PLACE: the line is edited where it sits on the
/// canvas, at the scale and the angle it has, so nothing moves when the
/// keyboard comes up and nothing jumps when Done is tapped. The canvas dims
/// behind it and only the text controls show: a size slider on the left (which
/// is the layer's SCALE, the same number a pinch changes), alignment and
/// background in the corner, the five fonts and the twelve colors above the
/// keyboard. Cancel and Done are one undoable step between them.
struct StoryTextEditView: View {
    @State var data: StoryTextData
    @State var scale: Double
    /// Where the layer's center is, in the editor's own coordinates.
    let center: CGPoint
    /// Radians, as the layer has it.
    let rotation: Double
    let canvasWidth: CGFloat
    /// The text and the scale it ended on; nil when it was cancelled.
    let onDone: ((StoryTextData, Double)?) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tick = 0
    @State private var colorTick = 0
    @State private var keyboard: CGFloat = 0

    private var fontSize: CGFloat { StoryCanvas.fontSize(for: data, canvasWidth: canvasWidth) }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.opacity(0.74)
                    .ignoresSafeArea()
                    .onTapGesture { finish() }
                    .accessibilityHidden(true)

                editor
                    .scaleEffect(scale)
                    .rotationEffect(.radians(rotation))
                    .position(x: center.x, y: center.y - lift(in: proxy.size))

                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    // The editor ignores the keyboard (the canvas must not
                    // shrink under the line being typed), so the controls ride
                    // on top of it themselves.
                    controls.padding(.bottom, max(0, keyboard - proxy.safeAreaInsets.bottom))
                }
                // Centered in the room between the top bar and the controls,
                // never under them.
                StoryVerticalSlider(value: scaleFraction, range: 0...1)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(.leading, 12)
                    .padding(.top, 56)
                    .padding(.bottom, 130 + max(0, keyboard - proxy.safeAreaInsets.bottom))
            }
        }
        .sensoryFeedback(.selection, trigger: tick)
        .sensoryFeedback(.selection, trigger: colorTick)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            keyboard = max(0, UIScreen.main.bounds.height - frame.minY)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    /// The line stays where it is. Only when the keyboard and the controls
    /// above it would cover it is it lifted, by exactly as much as it takes,
    /// and only on screen: the layer itself never moves.
    private func lift(in size: CGSize) -> CGFloat {
        let controlsHeight: CGFloat = 130
        let bottom = center.y + fontSize * scale * 1.6
        let free = size.height - keyboard - controlsHeight
        return keyboard > 0 ? max(0, bottom - free) : 0
    }

    /// The slider's 0...1 is the layer's scale on a log scale, so the same
    /// finger travel doubles the size anywhere along it.
    private var scaleFraction: Binding<Double> {
        let low = StoryLayerLimits.scaleMin
        let high = StoryLayerLimits.scaleMax
        return Binding(
            get: { log(min(max(scale, low), high) / low) / log(high / low) },
            set: { scale = low * pow(high / low, min(max($0, 0), 1)) }
        )
    }

    // MARK: Top

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { onDone(nil) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(.white.opacity(0.14)))
            }
            .accessibilityLabel(Text("Cancel"))
            .accessibilityIdentifier("text.cancel")
            Spacer()
            roundTool(symbol: data.align.symbol, label: String(localized: "Alignment"), id: "text.align") {
                data.align = data.align.next
                tick += 1
            }
            roundTool(symbol: data.background == .none ? "textformat" : "textformat.alt", label: String(localized: "Background"), id: "text.background") {
                data.background = data.background.next
                tick += 1
            }
            .overlay(alignment: .topTrailing) { backgroundBadge }
            Button(action: finish) {
                Text("Done")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 16)
                    .frame(height: 40)
                    .background(Capsule().fill(Palette.signal))
            }
            .accessibilityIdentifier("text.done")
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }

    /// Which of the three background looks is on, since the icon is the same.
    @ViewBuilder
    private var backgroundBadge: some View {
        if data.background != .none {
            Circle().fill(Palette.signal).frame(width: 9, height: 9).offset(x: -2, y: 2)
        }
    }

    private func roundTool(symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(.white.opacity(0.14)))
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    // MARK: Middle

    /// The line, drawn exactly the way the placed layer is (same font, same
    /// padding, same wrap width), so Done changes nothing but the caret.
    private var editor: some View {
        let inset = data.background == .none ? CGSize.zero : CGSize(width: fontSize * 0.55, height: fontSize * 0.28)
        return StoryTextInput(
            text: $data.text, font: data.font.uiFont(size: fontSize), color: foreground,
            alignment: data.align, maxWidth: canvasWidth * StoryCanvas.textMaxWidthFraction - inset.width * 2,
            placeholder: String(localized: "Type something")
        )
        .padding(.horizontal, inset.width)
        .padding(.vertical, inset.height)
        .background(fill)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: data.background)
        .accessibilityIdentifier("text.input")
        .onChange(of: data.text) { _, value in
            if value.count > StoryLimits.textMax { data.text = String(value.prefix(StoryLimits.textMax)) }
        }
    }

    private var foreground: Color {
        if data.font == .neon { return .white.opacity(0.92) }
        return data.background == .solid ? (data.color.isLight ? .black : .white) : data.color.color
    }

    @ViewBuilder
    private var fill: some View {
        let radius = fontSize * 0.42
        switch data.background {
        case .none: Color.clear
        case .solid: RoundedRectangle(cornerRadius: radius, style: .continuous).fill(data.color.color)
        case .soft: RoundedRectangle(cornerRadius: radius, style: .continuous).fill(data.color.color.opacity(0.34))
        }
    }

    // MARK: Bottom

    private var controls: some View {
        VStack(spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(StoryFont.allCases, id: \.self) { font in
                        Button {
                            data.font = font
                            tick += 1
                        } label: {
                            Text(verbatim: "Aa")
                                .font(Font(font.uiFont(size: 18)))
                                .foregroundStyle(data.font == font ? Palette.inkDeep : .white)
                                .padding(.horizontal, 14)
                                .frame(height: 36)
                                .background(Capsule().fill(data.font == font ? Color.white : Color.white.opacity(0.16)))
                        }
                        .accessibilityLabel(Text(verbatim: font.label))
                        .accessibilityAddTraits(data.font == font ? .isSelected : [])
                        .accessibilityIdentifier("text.font.\(font.rawValue)")
                    }
                }
                .padding(.horizontal, 14)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(StoryTextColor.allCases, id: \.self) { color in
                        Button {
                            data.color = color
                            colorTick += 1
                        } label: {
                            Circle()
                                .fill(color.color)
                                .frame(width: 28, height: 28)
                                .overlay(Circle().strokeBorder(.white, lineWidth: data.color == color ? 3 : 1.5))
                                .padding(3)
                        }
                        .accessibilityLabel(Text(verbatim: color.label))
                        .accessibilityAddTraits(data.color == color ? .isSelected : [])
                        .accessibilityIdentifier("text.color.\(color.rawValue)")
                    }
                }
                .padding(.horizontal, 14)
            }
        }
        .padding(.bottom, 10)
    }

    /// Done. What was typed is reported as it is, EMPTY included: the editor
    /// decides what an emptied line means (the layer goes away). Cancel, the X,
    /// reports nothing at all.
    private func finish() {
        onDone((data, scale))
    }
}

// MARK: - The text field

/// A `UITextView` that is exactly as wide as its text (up to the wrap width),
/// so the box drawn behind it hugs the words the way the placed layer will.
struct StoryTextInput: UIViewRepresentable {
    @Binding var text: String
    let font: UIFont
    let color: Color
    let alignment: StoryTextAlign
    let maxWidth: CGFloat
    let placeholder: String

    /// Takes the keyboard the moment it is in a window: asking before then
    /// does nothing, which is what a focus flag set in `onAppear` does.
    final class FocusingTextView: UITextView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil, !isFirstResponder {
                DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
            }
        }
    }

    func makeUIView(context: Context) -> UITextView {
        let view = FocusingTextView()
        view.backgroundColor = .clear
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.delegate = context.coordinator
        view.autocorrectionType = .default
        view.keyboardAppearance = .dark
        view.returnKeyType = .default
        view.setContentHuggingPriority(.required, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.font = font
        view.textColor = UIColor(color)
        view.tintColor = UIColor(Palette.signal)
        view.textAlignment = alignment == .left ? .left : (alignment == .right ? .right : .center)
        context.coordinator.placeholderLabel(for: view, text: placeholder, font: font)
        view.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let limit = max(60, maxWidth)
        let sample = text.isEmpty ? placeholder : text
        let rect = (sample as NSString).boundingRect(
            with: CGSize(width: limit, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil
        )
        // A little slack, and room for the caret on an empty field.
        let width = min(limit, max(36, ceil(rect.width) + 3))
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: max(height, font.lineHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: StoryTextInput
        private weak var label: UILabel?

        init(parent: StoryTextInput) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            label?.isHidden = !textView.text.isEmpty
            textView.invalidateIntrinsicContentSize()
        }

        func placeholderLabel(for view: UITextView, text: String, font: UIFont) {
            let label: UILabel
            if let existing = self.label {
                label = existing
            } else {
                label = UILabel()
                label.isUserInteractionEnabled = false
                label.isAccessibilityElement = false
                view.addSubview(label)
                self.label = label
            }
            label.text = text
            label.font = font
            label.textColor = UIColor.white.withAlphaComponent(0.4)
            label.textAlignment = view.textAlignment
            label.frame = CGRect(x: 0, y: 0, width: max(view.bounds.width, 1), height: font.lineHeight)
            label.isHidden = !view.text.isEmpty
        }
    }
}

// MARK: - A vertical slider

/// The size control: a pill on the left edge, dragged up for bigger. Built by
/// hand because a rotated `Slider` reads and lays out wrong.
struct StoryVerticalSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    private let height: CGFloat = 200

    var body: some View {
        let fraction = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
        ZStack(alignment: .bottom) {
            Capsule().fill(.white.opacity(0.22)).frame(width: 6, height: height)
            Capsule().fill(.white).frame(width: 6, height: max(6, height * fraction))
            Circle()
                .fill(.white)
                .frame(width: 24, height: 24)
                .shadow(color: .black.opacity(0.3), radius: 3)
                .offset(y: 12 - height * fraction)
        }
        .frame(width: 34, height: height + 24)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0).onChanged { drag in
                let t = 1 - min(max(0, (drag.location.y - 12) / height), 1)
                value = range.lowerBound + (range.upperBound - range.lowerBound) * Double(t)
            }
        )
        .accessibilityElement()
        .accessibilityLabel(Text("Text size"))
        .accessibilityValue(Text(verbatim: "\(Int((fraction * 100).rounded()))%"))
        .accessibilityAdjustableAction { direction in
            let step = (range.upperBound - range.lowerBound) / 8
            switch direction {
            case .increment: value = min(range.upperBound, value + step)
            case .decrement: value = max(range.lowerBound, value - step)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("text.size")
    }
}
