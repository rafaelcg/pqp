import SwiftUI
import UIKit

/// The microphone that replaces Send while the field is empty.
///
/// The touch is read by a UIKit recognizer rather than a SwiftUI `DragGesture`
/// on purpose: a hold that the system takes away (a notification pulled down, a
/// call, the app switcher) must come back as `.cancelled`, and `DragGesture`
/// reports nothing in that case, which would leave the recorder open with no
/// finger on the glass.
struct VoiceMicButton: View {
    let recorder: VoiceRecorder
    let callIsLive: Bool
    let seatedInVoiceRoom: Bool
    var isDisabled = false

    private var holding: Bool { recorder.phase == .holding }

    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.signal.opacity(holding ? 0.2 : 0))
                .frame(width: 40, height: 40)
                .scaleEffect(holding ? 2.4 : 1)
            Circle()
                .fill(isDisabled ? Palette.border : Palette.signal)
                .frame(width: 40, height: 40)
                .scaleEffect(holding ? 1.7 : 1)
            Image(systemName: "mic.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isDisabled ? Palette.paperMuted : Palette.inkDeep)
                .scaleEffect(holding ? 1.5 : 1)
        }
        .frame(width: 40, height: 40)
        .animation(Motion.press, value: holding)
        .overlay(alignment: .top) {
            if holding {
                VoiceLockHint(progress: recorder.lockProgress)
                    .offset(y: -128 + (-30 * recorder.lockProgress))
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .overlay {
            if !isDisabled {
                MicTouchSurface(
                    onDown: { recorder.touchDown(callIsLive: callIsLive, seatedInVoiceRoom: seatedInVoiceRoom) },
                    onMove: { recorder.touchMoved(dx: $0, dy: $1) },
                    onUp: { recorder.touchUp() },
                    onCancel: { recorder.interrupt() }
                )
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("composer.mic")
        .accessibilityLabel(Text("Hold to record a voice message"))
        .accessibilityAddTraits(.isButton)
        // A hold-and-slide cannot be done with VoiceOver, so its action opens a
        // recording that is already locked: Pause and Send are ordinary buttons.
        .accessibilityAction(named: Text("Record voice message")) {
            guard !isDisabled else { return }
            recorder.touchDown(callIsLive: callIsLive, seatedInVoiceRoom: seatedInVoiceRoom)
            recorder.touchMoved(dx: 0, dy: -VoiceGesture.lockDistance)
            recorder.touchMoved(dx: 0, dy: -VoiceGesture.lockDistance - 1)
        }
    }
}

/// A zero-delay press recognizer that tracks the finger wherever it goes.
private struct MicTouchSurface: UIViewRepresentable {
    let onDown: () -> Void
    let onMove: (CGFloat, CGFloat) -> Void
    let onUp: () -> Void
    let onCancel: () -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let press = UILongPressGestureRecognizer(
            target: context.coordinator, action: #selector(Coordinator.handle(_:))
        )
        press.minimumPressDuration = 0
        press.allowableMovement = .greatestFiniteMagnitude
        view.addGestureRecognizer(press)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject {
        var parent: MicTouchSurface
        private var origin: CGPoint = .zero

        init(_ parent: MicTouchSurface) { self.parent = parent }

        @objc func handle(_ recognizer: UILongPressGestureRecognizer) {
            // In the window's space, not the view's: the button grows under the
            // finger while recording, which would move a local origin.
            let point = recognizer.location(in: nil)
            switch recognizer.state {
            case .began:
                origin = point
                parent.onDown()
            case .changed:
                parent.onMove(point.x - origin.x, point.y - origin.y)
            case .ended:
                parent.onUp()
            case .cancelled, .failed:
                parent.onCancel()
            default:
                break
            }
        }
    }
}

/// The padlock above the microphone: slide up into it to lock.
struct VoiceLockHint: View {
    let progress: CGFloat

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: progress > 0.6 ? "lock.fill" : "lock.open.fill")
                .font(.system(size: 15, weight: .semibold))
            Image(systemName: "chevron.up")
                .font(.system(size: 12, weight: .bold))
                .opacity(1 - progress)
        }
        .foregroundStyle(Palette.paper)
        .frame(width: 44, height: 84)
        .background(Capsule().fill(Palette.surfaceRaised))
        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
        .scaleEffect(1 + progress * 0.1)
    }
}

/// While the finger is down: the red dot, the clock and "slide to cancel".
struct VoiceRecordingBar: View {
    let recorder: VoiceRecorder

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Palette.danger).frame(width: 10, height: 10)
            Text(clock(recorder.elapsedMs))
                .font(.system(size: 15, weight: .semibold).monospacedDigit())
                .foregroundStyle(Palette.paper)
                .accessibilityIdentifier("voice.clock")
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                Text("Slide to cancel").font(Typography.callout)
            }
            .foregroundStyle(Palette.paperMuted)
            // The hint leans away as the finger commits to cancelling.
            .offset(x: -40 * recorder.cancelProgress)
            .opacity(1 - Double(recorder.cancelProgress))
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Palette.border, lineWidth: 1)
        )
    }
}

/// Locked: hands free, with Discard, Pause and Send.
struct VoiceLockedPanel: View {
    let recorder: VoiceRecorder

    private var paused: Bool {
        if case .locked(let paused, _) = recorder.phase { return paused }
        return false
    }

    private var canResume: Bool {
        if case .locked(_, let canResume) = recorder.phase { return canResume }
        return false
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Circle()
                    .fill(paused ? Palette.paperMuted : Palette.danger)
                    .frame(width: 10, height: 10)
                Text(clock(recorder.elapsedMs))
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Palette.paper)
                    .accessibilityIdentifier("voice.clock")
                LiveBars(levels: recorder.levels, dimmed: paused)
                    .frame(height: 28)
            }

            HStack {
                Button { recorder.discardTapped() } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 19, weight: .regular))
                        .foregroundStyle(Palette.danger)
                        .frame(width: 48, height: 48)
                }
                .accessibilityIdentifier("voice.discard")
                .accessibilityLabel(Text("Discard voice message"))

                Spacer()

                if canResume {
                    Button {
                        paused ? recorder.resume() : recorder.pause()
                    } label: {
                        Image(systemName: paused ? "mic.fill" : "pause.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Palette.paper)
                            .frame(width: 48, height: 48)
                            .overlay(Circle().strokeBorder(Palette.border, lineWidth: 1))
                    }
                    .accessibilityIdentifier("voice.pause")
                    .accessibilityLabel(paused ? Text("Resume recording") : Text("Pause recording"))
                    Spacer()
                }

                Button { recorder.sendTapped() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 52, height: 52)
                        .background(Circle().fill(Palette.signal))
                }
                .accessibilityIdentifier("voice.send")
                .accessibilityLabel(Text("Send voice message"))
            }

            if canResume {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill").font(.system(size: 10))
                    Text("Locked. You can let go.").font(Typography.caption)
                }
                .foregroundStyle(Palette.paperMuted)
            } else {
                Text("You reached the 5 minute limit.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.border, lineWidth: 1)
        )
    }
}

/// The newest readings scrolling in from the right, as in the mock.
private struct LiveBars: View {
    let levels: [Float]
    let dimmed: Bool

    var body: some View {
        Canvas { context, size in
            let step: CGFloat = 5
            let capacity = max(1, Int(size.width / step))
            let shown = levels.suffix(capacity)
            let offset = size.width - CGFloat(shown.count) * step
            for (index, level) in shown.enumerated() {
                let height = max(3, CGFloat(level) * size.height)
                let rect = CGRect(
                    x: offset + CGFloat(index) * step, y: (size.height - height) / 2,
                    width: 3, height: height
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: 1.5),
                    with: .color(dimmed ? Palette.paperMuted : Palette.signal)
                )
            }
        }
        .accessibilityHidden(true)
    }
}

/// "Áudio descartado (0:11)  Desfazer": a cancelled note, for five seconds.
struct VoiceUndoBanner: View {
    let note: VoiceRecorder.UndoableNote
    let onUndo: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "trash").font(.system(size: 15))
            Text("Voice message discarded (\(formatNoteDuration(milliseconds: note.durationMs)))")
                .font(Typography.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onUndo) {
                Text("Undo")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.inkDeep))
            }
            .accessibilityIdentifier("voice.undo")
        }
        .foregroundStyle(Palette.danger)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.danger.opacity(0.18))
        )
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .id(note.id)
    }
}

/// What the composer says when the microphone button says no.
enum VoiceRecordRefusalCopy {
    static func message(for refusal: VoiceRecordRefusal) -> String {
        switch refusal {
        case .inCall:
            String(localized: "You are on a call. Leave it to record a voice message.")
        case .permissionDenied:
            String(localized: "Microphone access is off. Enable it in Settings to record voice messages.")
        case .failedToStart:
            String(localized: "Could not start recording. Try again.")
        }
    }

    static var tooShort: String {
        String(localized: "Hold the microphone to record a voice message.")
    }
}

/// `0:04`. A running clock, not a duration: it shows what has elapsed, so it
/// starts at 0:00.
private func clock(_ milliseconds: Int) -> String {
    let seconds = max(0, milliseconds / 1000)
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}
