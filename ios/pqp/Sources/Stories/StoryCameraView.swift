@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// The story camera: full screen, tap for a photo, hold for a video up to 30 s
/// with a progress ring, front and back, flash, pinch to zoom, double tap to
/// flip. The composer puts its own close button and its mode bar over it; this
/// view owns everything between them.
///
/// Photos picked from the library never need camera permission, so every
/// refusal state here still offers the gallery.
struct StoryCameraView: View {
    /// False while a draft or a sheet is up: the camera is released, not just
    /// hidden, so the next screen (and a call) can have it.
    let isActive: Bool
    /// In a call the microphone belongs to the call. Videos shot meanwhile are
    /// silent, because a capture session with a mic input takes the audio
    /// session from WebRTC.
    let recordsAudio: Bool
    /// The call has the camera on: a device has one owner at a time.
    var blockedByCall = false
    let onCapture: (StoryCameraResult) -> Void
    let onGallery: () -> Void
    let onFiles: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    @State private var access: StoryCameraAccess = .needsPrompt
    @State private var engine: (any StoryCameraEngine)?
    @State private var running = false
    @State private var position: StoryCameraPosition = .back
    @State private var flash: StoryFlash = .off
    @State private var zoom: Double = 1
    @State private var pinchStart: Double?
    @State private var zoomRange: ClosedRange<Double> = 1...1
    @State private var hasFlash = false
    @State private var hasTwoCameras = false
    @State private var silent = false

    @State private var press = StoryShutterPress()
    @State private var holdTask: Task<Void, Never>?
    @State private var limitTask: Task<Void, Never>?
    @State private var pressed = false
    @State private var isRecording = false
    @State private var recordingStartedAt: Date?
    @State private var dragZoomStart: Double?
    @State private var busy = false

    @State private var shutterTick = 0
    @State private var holdTick = 0
    @State private var flipTick = 0
    @State private var flipping = false
    @State private var flipTurns = 0.0
    @State private var blink = false
    @State private var screenFlash = false
    @State private var focusPoint: CGPoint?
    @State private var focusTick = 0
    @State private var message: String?

    var body: some View {
        ZStack {
            Color.black
            if blockedByCall {
                refusal(.busyInCall)
            } else {
                switch access {
                case .ready:
                    liveCamera
                case .needsPrompt:
                    ProgressView().tint(.white)
                case .denied, .restricted, .noDevice, .busyInCall:
                    refusal(access)
                }
            }
        }
        .ignoresSafeArea()
        .task(id: isActive && !blockedByCall) { await sync() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await sync() } } else { releaseCamera() }
        }
        .onDisappear { releaseCamera() }
        .sensoryFeedback(.impact(flexibility: .rigid, intensity: 0.7), trigger: shutterTick)
        .sensoryFeedback(.impact(weight: .heavy), trigger: holdTick)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: flipTick)
        .sensoryFeedback(.selection, trigger: focusTick)
    }

    // MARK: - Live

    private var liveCamera: some View {
        GeometryReader { proxy in
            ZStack {
                if let engine {
                    PreviewHost(engine: engine)
                        .blur(radius: flipping && !reduceMotion ? 22 : 0)
                        .animation(.easeInOut(duration: 0.18), value: flipping)
                        .gesture(
                            SpatialTapGesture(count: 2).onEnded { _ in Task { await flip() } }
                                .exclusively(before: SpatialTapGesture(count: 1).onEnded { tap in
                                    focus(at: tap.location, in: proxy.size)
                                })
                        )
                        .simultaneousGesture(
                            MagnifyGesture()
                                .onChanged { value in
                                    let start = pinchStart ?? zoom
                                    pinchStart = start
                                    setZoom(StoryZoom.pinched(from: start, scale: value.magnification, range: zoomRange))
                                }
                                .onEnded { _ in pinchStart = nil }
                        )
                }
                if let focusPoint {
                    FocusSquare()
                        .position(focusPoint)
                        .id(focusTick)
                        .allowsHitTesting(false)
                }
                if screenFlash { Color.white.opacity(0.92).allowsHitTesting(false) }
                if blink { Color.white.opacity(0.55).allowsHitTesting(false) }

                VStack(spacing: 0) {
                    Spacer()
                    if let message {
                        Text(verbatim: message)
                            .font(Typography.callout)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(.black.opacity(0.6)))
                            .padding(.bottom, 10)
                            .accessibilityIdentifier("camera.message")
                    }
                    if StoryZoom.isZoomable(zoomRange) { zoomPill.padding(.bottom, 14) }
                    controls
                        // Clear of the composer's mode bar, which sits under this.
                        .padding(.bottom, 76)
                }

                sideColumn
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.top, 64)
                    .padding(.trailing, 14)

                if isRecording { recordingBadge.frame(maxHeight: .infinity, alignment: .top).padding(.top, 20) }
            }
        }
    }

    // MARK: Side tools

    private var sideColumn: some View {
        VStack(spacing: 14) {
            if hasFlash || position == .front {
                tool(symbol: flash.symbol, label: flash.label, id: "camera.flash") {
                    flash = flash.next
                    flipTick += 1
                }
                .accessibilityValue(flash.label)
            }
            tool(symbol: "folder", label: String(localized: "Choose a file"), id: "camera.files") { onFiles() }
        }
        .opacity(isRecording ? 0 : 1)
        .animation(.easeOut(duration: 0.15), value: isRecording)
    }

    private func tool(symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Circle().fill(.black.opacity(0.4)))
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    // MARK: Shutter row

    private var controls: some View {
        HStack(alignment: .center) {
            Button(action: onGallery) {
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.black.opacity(0.4)))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.white.opacity(0.85), lineWidth: 2))
            }
            .accessibilityLabel(Text("Gallery"))
            .accessibilityIdentifier("composer.gallery")
            .opacity(isRecording ? 0 : 1)
            .frame(maxWidth: .infinity)

            shutter

            Button { Task { await flip() } } label: {
                Image(systemName: "arrow.triangle.2.circlepath.camera")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                    .rotationEffect(.degrees(flipTurns * 180))
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(.black.opacity(0.4)))
            }
            .accessibilityLabel(Text("Flip camera"))
            .accessibilityValue(position == .front ? Text("Front") : Text("Back"))
            .accessibilityIdentifier("camera.flip")
            .disabled(!hasTwoCameras || busy)
            .opacity(isRecording || !hasTwoCameras ? 0 : 1)
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
    }

    private var shutter: some View {
        ZStack {
            Circle().strokeBorder(.white.opacity(0.95), lineWidth: 4)
                .frame(width: 84, height: 84)
                .scaleEffect(isRecording ? 1.28 : 1)
            if isRecording, let recordingStartedAt {
                TimelineView(.animation) { context in
                    Circle()
                        .trim(from: 0, to: StoryRecordingClock.progress(elapsed: context.date.timeIntervalSince(recordingStartedAt)))
                        .stroke(Palette.danger, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 84 * 1.28, height: 84 * 1.28)
                }
                .accessibilityHidden(true)
            }
            Circle()
                .fill(isRecording ? Palette.danger : .white)
                .frame(width: isRecording ? 34 : 66, height: isRecording ? 34 : 66)
                .scaleEffect(pressed && !isRecording ? 0.9 : 1)
        }
        .frame(width: 112, height: 112)
        .contentShape(Circle())
        .animation(reduceMotion ? nil : Motion.press, value: pressed)
        .animation(reduceMotion ? nil : Motion.standard, value: isRecording)
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { value in shutterChanged(value) }
                .onEnded { _ in shutterEnded() }
        )
        .accessibilityElement()
        .accessibilityLabel(isRecording ? Text("Stop recording") : Text("Take photo"))
        .accessibilityHint(Text("Hold to record a video up to 30 seconds"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("camera.shutter")
        .accessibilityAction {
            if isRecording { Task { await finishRecording() } } else { Task { await takePhoto() } }
        }
        .accessibilityAction(named: Text("Record video")) {
            if !isRecording { Task { await beginRecording() } }
        }
    }

    private var zoomPill: some View {
        Button {
            cycleZoom()
        } label: {
            Text(verbatim: StoryZoom.label(zoom))
                .font(.system(size: 13, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(Palette.warning)
                .frame(minWidth: 44, minHeight: 28)
                .background(Capsule().fill(.black.opacity(0.45)))
        }
        .accessibilityLabel(Text("Zoom"))
        .accessibilityValue(Text(verbatim: StoryZoom.label(zoom)))
        .accessibilityAdjustableAction { direction in
            let step = 0.5
            switch direction {
            case .increment: setZoom(min(zoomRange.upperBound, zoom + step))
            case .decrement: setZoom(max(zoomRange.lowerBound, zoom - step))
            @unknown default: break
            }
        }
        .accessibilityIdentifier("camera.zoom")
    }

    private var recordingBadge: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { context in
            HStack(spacing: 8) {
                Circle().fill(Palette.danger).frame(width: 8, height: 8)
                Text(verbatim: StoryRecordingClock.label(context.date.timeIntervalSince(recordingStartedAt ?? context.date)))
                    .font(.system(size: 14, weight: .bold))
                    .monospacedDigit()
                if silent {
                    Image(systemName: "mic.slash.fill").font(.system(size: 12))
                        .accessibilityLabel(Text("No sound"))
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(.black.opacity(0.55)))
        }
        .accessibilityIdentifier("camera.recording")
    }

    // MARK: Refusal

    private func refusal(_ access: StoryCameraAccess) -> some View {
        VStack(spacing: 14) {
            Image(systemName: access == .noDevice ? "camera.metering.unknown" : "camera.fill")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.white.opacity(0.85))
                .accessibilityHidden(true)
            Text(verbatim: access.title)
                .font(Typography.title(19))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("camera.refusal.title")
            Text(verbatim: access.detail)
                .font(Typography.callout)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if access.offersSettings {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    Text("Open Settings").frame(maxWidth: 260)
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.signal)
                .foregroundStyle(Palette.inkDeep)
                .accessibilityIdentifier("camera.openSettings")
            }
            HStack(spacing: 10) {
                Button(action: onGallery) { Label("Gallery", systemImage: "photo") }
                    .accessibilityIdentifier("composer.gallery")
                Button(action: onFiles) { Label("Choose a file", systemImage: "folder") }
                    .accessibilityIdentifier("camera.files")
            }
            .buttonStyle(.bordered)
            .tint(.white)
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Lifecycle

    private func sync() async {
        guard isActive, !blockedByCall, scenePhase == .active else {
            releaseCamera()
            return
        }
        guard !running else { return }
        access = StoryCameraAccess.resolve(
            status: StoryCameraEngineFactory.authorizationStatus,
            hasDevice: StoryCameraEngineFactory.hasCameraDevice
        )
        if access == .needsPrompt {
            let granted = await StoryCameraEngineFactory.requestAccess()
            access = granted ? .ready : .denied
        }
        guard access == .ready else { return }
        // The microphone is optional: no permission, or a call holding it, and
        // the camera still works and the video is silent.
        if recordsAudio, AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        let next = engine ?? StoryCameraEngineFactory.make(recordsAudio: recordsAudio)
        next.onInterruption = { failure in
            Task { @MainActor in handleInterruption(failure) }
        }
        do {
            try await next.start()
        } catch {
            access = .noDevice
            engine = nil
            return
        }
        engine = next
        running = true
        position = next.position
        zoomRange = next.zoomRange
        zoom = next.zoom
        hasFlash = next.hasFlash
        hasTwoCameras = next.hasMultipleCameras
        silent = !next.recordsAudio
    }

    private func releaseCamera() {
        holdTask?.cancel()
        limitTask?.cancel()
        if isRecording { Task { await finishRecording() } }
        engine?.stop()
        running = false
    }

    private func handleInterruption(_ failure: StoryCameraFailure) {
        if isRecording { Task { await finishRecording() } }
        message = String(localized: "The camera was interrupted. Try again.")
        running = false
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            message = nil
            await sync()
        }
    }

    // MARK: - Actions

    private func flip() async {
        guard let engine, !busy, !isRecording, hasTwoCameras else { return }
        busy = true
        flipTick += 1
        flipping = true
        if !reduceMotion { withAnimation(Motion.standard) { flipTurns += 1 } }
        await engine.flip()
        position = engine.position
        zoomRange = engine.zoomRange
        zoom = engine.zoom
        hasFlash = engine.hasFlash
        flipping = false
        busy = false
    }

    private func setZoom(_ value: Double) {
        zoom = value
        engine?.setZoom(value)
    }

    private func cycleZoom() {
        let stops = ([0.5, 1, 2, 3, 5].filter { zoomRange.contains($0) })
        guard !stops.isEmpty else { return }
        flipTick += 1
        let next = stops.first { $0 > zoom + 0.05 } ?? stops[0]
        setZoom(next)
    }

    private func focus(at point: CGPoint, in size: CGSize) {
        guard !isRecording else { return }
        engine?.focus(at: point, in: size)
        focusPoint = point
        focusTick += 1
        let tick = focusTick
        Task {
            try? await Task.sleep(for: .seconds(1))
            if focusTick == tick { focusPoint = nil }
        }
    }

    // MARK: Shutter

    private func shutterChanged(_ value: DragGesture.Value) {
        if !press.isDown {
            guard !busy else { return }
            press.down(at: Date())
            pressed = true
            holdTask?.cancel()
            holdTask = Task {
                try? await Task.sleep(for: .seconds(StoryShutterPress.holdThreshold))
                guard !Task.isCancelled else { return }
                if press.holdElapsed(at: Date()) { await beginRecording() }
            }
        }
        if isRecording {
            // Drag up while holding: zoom, the way Instagram does it.
            let start = dragZoomStart ?? zoom
            dragZoomStart = start
            setZoom(StoryZoom.dragged(from: start, translationY: value.translation.height, range: zoomRange))
        }
    }

    private func shutterEnded() {
        pressed = false
        holdTask?.cancel()
        dragZoomStart = nil
        switch press.up(at: Date()) {
        case .photo: Task { await takePhoto() }
        case .recordingStopped: Task { await finishRecording() }
        case .nothing: break
        }
    }

    private func takePhoto() async {
        guard let engine, !busy, !isRecording else { return }
        busy = true
        defer { busy = false }
        shutterTick += 1
        if flash != .off, position == .front {
            screenFlash = true
            try? await Task.sleep(for: .milliseconds(260))
        }
        do {
            let image = try await engine.capturePhoto(flash: flash)
            screenFlash = false
            blink = true
            Task {
                try? await Task.sleep(for: .milliseconds(120))
                blink = false
            }
            onCapture(.image(image))
        } catch {
            screenFlash = false
            toast(String(localized: "Couldn't take the photo. Try again."))
        }
    }

    private func beginRecording() async {
        guard let engine, !isRecording, !busy else { return }
        busy = true
        holdTick += 1
        do {
            try await engine.startRecording(torch: flash.torchesVideo && position == .back)
            recordingStartedAt = Date()
            isRecording = true
            limitTask?.cancel()
            limitTask = Task {
                try? await Task.sleep(for: .milliseconds(StoryLimits.maxVideoMs))
                guard !Task.isCancelled else { return }
                // The 30 s are up with the finger still down: end it now, and
                // make sure the release that follows is not read as a photo.
                press.recordingEnded()
                await finishRecording()
            }
        } catch {
            press.recordingEnded()
            toast(String(localized: "Couldn't start recording. Try again."))
        }
        busy = false
    }

    private func finishRecording() async {
        guard let engine, isRecording else { return }
        isRecording = false
        limitTask?.cancel()
        recordingStartedAt = nil
        pressed = false
        flipTick += 1
        do {
            let url = try await engine.stopRecording()
            onCapture(.video(url))
        } catch {
            toast(String(localized: "Couldn't save the video. Try again."))
        }
    }

    private func toast(_ text: String) {
        message = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if message == text { message = nil }
        }
    }
}

/// Hosts the engine's preview view. The view is made once per engine.
private struct PreviewHost: UIViewRepresentable {
    let engine: any StoryCameraEngine

    func makeUIView(context: Context) -> UIView { engine.makePreviewView() }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

private struct FocusSquare: View {
    @State private var settled = false

    var body: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .strokeBorder(Palette.warning, lineWidth: 1.5)
            .frame(width: 72, height: 72)
            .scaleEffect(settled ? 1 : 1.3)
            .opacity(settled ? 0.9 : 0.4)
            .onAppear { withAnimation(.easeOut(duration: 0.22)) { settled = true } }
    }
}
