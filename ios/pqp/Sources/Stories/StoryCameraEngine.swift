@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// What a story camera can do, whichever implementation is behind it: the
/// device's (`AVStoryCameraEngine`) or the scripted one a simulator and the UI
/// tests use (`MockStoryCameraEngine`, which has no hardware to ask).
@MainActor
protocol StoryCameraEngine: AnyObject {
    var position: StoryCameraPosition { get }
    var hasFlash: Bool { get }
    var hasMultipleCameras: Bool { get }
    /// What the zoom pill calls 1x is `1`; ultra-wide is below it.
    var zoomRange: ClosedRange<Double> { get }
    var zoom: Double { get }
    var recordsAudio: Bool { get }

    /// Called on the main actor when the engine loses the camera (another app
    /// took it, the session failed). A recording in progress is stopped first
    /// and its file delivered through `stopRecording`.
    var onInterruption: (@MainActor (StoryCameraFailure) -> Void)? { get set }

    func makePreviewView() -> UIView
    func start() async throws
    func stop()
    func flip() async
    func setZoom(_ display: Double)
    func focus(at point: CGPoint, in size: CGSize)
    func capturePhoto(flash: StoryFlash) async throws -> UIImage
    func startRecording(torch: Bool) async throws
    func stopRecording() async throws -> URL
}

/// Why the camera screen cannot show a picture right now.
enum StoryCameraFailure: Error, Equatable {
    case permission
    case noDevice
    case captureFailed
    case interrupted
}

enum StoryCameraEngineFactory {
    /// The scripted camera is chosen on a debug build with
    /// `PQP_STORY_CAMERA=mock`, and never on a release build, where a flag in
    /// the environment must not be able to swap the real camera for a fake.
    @MainActor
    static func make(recordsAudio: Bool) -> any StoryCameraEngine {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PQP_STORY_CAMERA"] == "mock" {
            return MockStoryCameraEngine()
        }
        #endif
        return AVStoryCameraEngine(recordsAudio: recordsAudio)
    }

    /// Whether there is a camera at all, asked without opening it.
    static var hasCameraDevice: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PQP_STORY_CAMERA"] == "mock" { return true }
        #endif
        return AVStoryCameraEngine.device(for: .back) != nil || AVStoryCameraEngine.device(for: .front) != nil
    }

    /// The camera permission as the screen should see it. The scripted camera
    /// is always authorised.
    static var authorizationStatus: AVAuthorizationStatus {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PQP_STORY_CAMERA"] == "mock" { return .authorized }
        if let forced = ProcessInfo.processInfo.environment["PQP_STORY_CAMERA_ACCESS"] {
            switch forced {
            case "denied": return .denied
            case "restricted": return .restricted
            case "undetermined": return .notDetermined
            default: break
            }
        }
        #endif
        return AVCaptureDevice.authorizationStatus(for: .video)
    }

    static func requestAccess() async -> Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PQP_STORY_CAMERA"] == "mock" { return true }
        #endif
        return await AVCaptureDevice.requestAccess(for: .video)
    }
}

// MARK: - The device camera

/// `AVCaptureSession` behind a serial queue. Every AVFoundation call that can
/// block (`startRunning`, a configuration commit) runs there; the main actor
/// only asks and awaits. The class is `@unchecked Sendable` on exactly that
/// rule: nothing touches `session` or the outputs off `queue`.
final class StoryCaptureCore: @unchecked Sendable {
    let queue = DispatchQueue(label: "gg.pqp.story-camera")
    let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let movieOutput = AVCaptureMovieFileOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var audioInput: AVCaptureDeviceInput?
    private(set) var device: AVCaptureDevice?
    private var photoDelegates: [Int64: PhotoDelegate] = [:]
    private var recordingDelegate: RecordingDelegate?
    private var observers: [NSObjectProtocol] = []

    /// 1.0 on a wide-only phone; the ultra-wide's switch-over factor on a
    /// phone that has one, so the pill can say 0.5x below 1x.
    private(set) var zoomBase: Double = 1
    private(set) var zoomMaxDisplay: Double = 1

    // Config, all on `queue`.
    func configure(position: StoryCameraPosition, wantsAudio: Bool) throws {
        guard let device = AVStoryCameraEngine.device(for: position) else { throw StoryCameraFailure.noDevice }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.sessionPreset != .high, session.canSetSessionPreset(.high) { session.sessionPreset = .high }
        if let videoInput { session.removeInput(videoInput) }
        guard session.canAddInput(input) else { throw StoryCameraFailure.captureFailed }
        session.addInput(input)
        videoInput = input
        self.device = device

        if !session.outputs.contains(photoOutput) {
            guard session.canAddOutput(photoOutput) else { throw StoryCameraFailure.captureFailed }
            session.addOutput(photoOutput)
        }
        if !session.outputs.contains(movieOutput) {
            guard session.canAddOutput(movieOutput) else { throw StoryCameraFailure.captureFailed }
            session.addOutput(movieOutput)
            movieOutput.maxRecordedDuration = CMTime(seconds: Double(StoryLimits.maxVideoMs) / 1000, preferredTimescale: 600)
        }
        if wantsAudio, audioInput == nil,
           AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
           let mic = AVCaptureDevice.default(for: .audio),
           let micInput = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(micInput) {
            session.addInput(micInput)
            audioInput = micInput
        }
        applyOrientationAndMirroring(position: position)
        resetZoom()
    }

    private func applyOrientationAndMirroring(position: StoryCameraPosition) {
        for output in [photoOutput as AVCaptureOutput, movieOutput] {
            guard let connection = output.connection(with: .video) else { continue }
            // The picture is mirrored to match the preview, the way every
            // selfie camera of a social app does it: what you framed is what
            // you posted. (The rear camera is never mirrored.)
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = position == .front
            }
        }
        if let connection = movieOutput.connection(with: .video),
           movieOutput.availableVideoCodecTypes.contains(.h264) {
            movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
        }
    }

    private func resetZoom() {
        guard let device else { return }
        var base = 1.0
        if let first = device.virtualDeviceSwitchOverVideoZoomFactors.first?.doubleValue,
           device.constituentDevices.first?.deviceType == .builtInUltraWideCamera {
            base = first
        }
        zoomBase = base
        zoomMaxDisplay = min(max(1, device.maxAvailableVideoZoomFactor / base), 10)
        if (try? device.lockForConfiguration()) != nil {
            device.videoZoomFactor = min(max(base, device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
            device.unlockForConfiguration()
        }
    }

    var zoomRange: ClosedRange<Double> {
        guard let device else { return 1...1 }
        let low = max(device.minAvailableVideoZoomFactor / zoomBase, 0.5)
        return low...max(low, zoomMaxDisplay)
    }

    func setZoom(_ display: Double) {
        guard let device else { return }
        let factor = min(max(display * zoomBase, device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
        guard (try? device.lockForConfiguration()) != nil else { return }
        device.videoZoomFactor = factor
        device.unlockForConfiguration()
    }

    func focus(devicePoint: CGPoint) {
        guard let device, (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
            device.focusPointOfInterest = devicePoint
            device.focusMode = .autoFocus
        }
        if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.autoExpose) {
            device.exposurePointOfInterest = devicePoint
            device.exposureMode = .autoExpose
        }
    }

    func setTorch(_ on: Bool) {
        guard let device, device.hasTorch, (try? device.lockForConfiguration()) != nil else { return }
        if on {
            try? device.setTorchModeOn(level: 1)
        } else {
            device.torchMode = .off
        }
        device.unlockForConfiguration()
    }

    func startRunning(onInterruption: @escaping @Sendable (StoryCameraFailure) -> Void) {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = [
            NotificationCenter.default.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { _ in
                onInterruption(.interrupted)
            },
            NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { _ in
                onInterruption(.captureFailed)
            },
        ]
        if !session.isRunning { session.startRunning() }
    }

    func stopRunning() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if movieOutput.isRecording { movieOutput.stopRecording() }
        setTorch(false)
        if session.isRunning { session.stopRunning() }
    }

    var hasFlash: Bool { device?.hasFlash ?? false }

    // MARK: Photo

    func capturePhoto(flash: StoryFlash, rotation: CGFloat, completion: @escaping @Sendable (Result<Data, Error>) -> Void) {
        if let connection = photoOutput.connection(with: .video), connection.isVideoRotationAngleSupported(rotation) {
            connection.videoRotationAngle = rotation
        }
        let settings = AVCapturePhotoSettings()
        if hasFlash, photoOutput.supportedFlashModes.contains(flash.avMode) {
            settings.flashMode = flash.avMode
        }
        let id = settings.uniqueID
        let delegate = PhotoDelegate { [weak self] result in
            self?.queue.async { self?.photoDelegates[id] = nil }
            completion(result)
        }
        photoDelegates[id] = delegate
        photoOutput.capturePhoto(with: settings, delegate: delegate)
    }

    private final class PhotoDelegate: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
        let done: @Sendable (Result<Data, Error>) -> Void
        init(done: @escaping @Sendable (Result<Data, Error>) -> Void) { self.done = done }

        func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
            if let error {
                done(.failure(error))
            } else if let data = photo.fileDataRepresentation() {
                done(.success(data))
            } else {
                done(.failure(StoryCameraFailure.captureFailed))
            }
        }
    }

    // MARK: Video

    func startRecording(torch: Bool, rotation: CGFloat, completion: @escaping @Sendable (Result<URL, Error>) -> Void) throws {
        guard !movieOutput.isRecording else { throw StoryCameraFailure.captureFailed }
        if let connection = movieOutput.connection(with: .video), connection.isVideoRotationAngleSupported(rotation) {
            connection.videoRotationAngle = rotation
        }
        if torch { setTorch(true) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("story-shot-\(UUID().uuidString).mov")
        let delegate = RecordingDelegate { [weak self] result in
            self?.setTorch(false)
            self?.queue.async { self?.recordingDelegate = nil }
            completion(result)
        }
        recordingDelegate = delegate
        movieOutput.startRecording(to: url, recordingDelegate: delegate)
    }

    func stopRecording() {
        if movieOutput.isRecording { movieOutput.stopRecording() }
    }

    var isRecording: Bool { movieOutput.isRecording }

    private final class RecordingDelegate: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
        let done: @Sendable (Result<URL, Error>) -> Void
        init(done: @escaping @Sendable (Result<URL, Error>) -> Void) { self.done = done }

        func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
            if let error {
                // The duration cap and an interruption both end a recording
                // "with an error" and still leave a complete file.
                let finished = (error as NSError).userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false
                if finished { done(.success(outputFileURL)) } else { done(.failure(error)) }
            } else {
                done(.success(outputFileURL))
            }
        }
    }
}

/// The preview: an `AVCaptureVideoPreviewLayer` as the view's own layer, so it
/// resizes with the view and needs no layout code.
final class StoryCameraPreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

@MainActor
final class AVStoryCameraEngine: StoryCameraEngine {
    private let core = StoryCaptureCore()
    private weak var previewView: StoryCameraPreviewUIView?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var previewObservation: NSKeyValueObservation?
    private var wantsAudio: Bool

    private(set) var position: StoryCameraPosition = .back
    private(set) var zoom: Double = 1
    private(set) var zoomRange: ClosedRange<Double> = 1...1
    private(set) var hasFlash = false
    private(set) var recordsAudio = false
    var onInterruption: (@MainActor (StoryCameraFailure) -> Void)?

    var hasMultipleCameras: Bool {
        Self.device(for: .back) != nil && Self.device(for: .front) != nil
    }

    init(recordsAudio: Bool) {
        wantsAudio = recordsAudio
    }

    /// Back: the widest virtual device the phone has (it zooms across its
    /// lenses without the picture jumping); front: the TrueDepth/wide camera.
    nonisolated static func device(for position: StoryCameraPosition) -> AVCaptureDevice? {
        let types: [AVCaptureDevice.DeviceType] = position == .back
            ? [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
            : [.builtInTrueDepthCamera, .builtInWideAngleCamera]
        let found = AVCaptureDevice.DiscoverySession(
            deviceTypes: types, mediaType: .video, position: position == .back ? .back : .front
        ).devices
        for type in types {
            if let match = found.first(where: { $0.deviceType == type }) { return match }
        }
        return nil
    }

    func makePreviewView() -> UIView {
        let view = StoryCameraPreviewUIView()
        view.previewLayer.session = core.session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        previewView = view
        return view
    }

    func start() async throws {
        let core = core
        let position = position
        let wantsAudio = wantsAudio
        let hook: @Sendable (StoryCameraFailure) -> Void = { [weak self] failure in
            Task { @MainActor in self?.onInterruption?(failure) }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            core.queue.async {
                do {
                    try core.configure(position: position, wantsAudio: wantsAudio)
                    core.startRunning(onInterruption: hook)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
        refreshAfterConfiguration()
    }

    func stop() {
        let core = core
        previewObservation = nil
        rotationCoordinator = nil
        core.queue.async { core.stopRunning() }
    }

    func flip() async {
        let core = core
        let next = position.flipped
        guard Self.device(for: next) != nil else { return }
        let wantsAudio = wantsAudio
        let ok: Bool = await withCheckedContinuation { continuation in
            core.queue.async {
                do {
                    try core.configure(position: next, wantsAudio: wantsAudio)
                    continuation.resume(returning: true)
                } catch {
                    continuation.resume(returning: false)
                }
            }
        }
        guard ok else { return }
        position = next
        refreshAfterConfiguration()
    }

    private func refreshAfterConfiguration() {
        let core = core
        hasFlash = core.queue.sync { core.hasFlash }
        zoomRange = core.queue.sync { core.zoomRange }
        zoom = 1
        recordsAudio = wantsAudio && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if let device = core.queue.sync(execute: { core.device }), let layer = previewView?.previewLayer {
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
            rotationCoordinator = coordinator
            layer.connection?.videoRotationAngle = coordinator.videoRotationAngleForHorizonLevelPreview
            previewObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, change in
                guard let angle = change.newValue else { return }
                Task { @MainActor in self?.previewView?.previewLayer.connection?.videoRotationAngle = angle }
            }
        }
    }

    func setZoom(_ display: Double) {
        let clamped = min(max(display, zoomRange.lowerBound), zoomRange.upperBound)
        zoom = clamped
        let core = core
        core.queue.async { core.setZoom(clamped) }
    }

    func focus(at point: CGPoint, in size: CGSize) {
        guard let layer = previewView?.previewLayer, size.width > 0, size.height > 0 else { return }
        let devicePoint = layer.captureDevicePointConverted(fromLayerPoint: point)
        let core = core
        core.queue.async { core.focus(devicePoint: devicePoint) }
    }

    private var captureAngle: CGFloat {
        rotationCoordinator?.videoRotationAngleForHorizonLevelCapture ?? 90
    }

    func capturePhoto(flash: StoryFlash) async throws -> UIImage {
        let core = core
        let angle = captureAngle
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            core.queue.async {
                core.capturePhoto(flash: flash, rotation: angle) { continuation.resume(with: $0) }
            }
        }
        guard let image = UIImage(data: data) else { throw StoryCameraFailure.captureFailed }
        return image
    }

    private var recordingContinuation: CheckedContinuation<URL, Error>?
    private var recordingResult: Result<URL, Error>?

    func startRecording(torch: Bool) async throws {
        let core = core
        let angle = captureAngle
        recordingResult = nil
        try await withCheckedThrowingContinuation { (started: CheckedContinuation<Void, Error>) in
            core.queue.async { [weak self] in
                do {
                    try core.startRecording(torch: torch, rotation: angle) { result in
                        Task { @MainActor in self?.recordingFinished(result) }
                    }
                    started.resume()
                } catch {
                    started.resume(throwing: error)
                }
            }
        }
    }

    private func recordingFinished(_ result: Result<URL, Error>) {
        if let waiting = recordingContinuation {
            recordingContinuation = nil
            waiting.resume(with: result)
        } else {
            recordingResult = result
        }
    }

    func stopRecording() async throws -> URL {
        let core = core
        return try await withCheckedThrowingContinuation { continuation in
            if let ready = recordingResult {
                recordingResult = nil
                continuation.resume(with: ready)
                return
            }
            recordingContinuation = continuation
            core.queue.async { core.stopRecording() }
        }
    }
}
