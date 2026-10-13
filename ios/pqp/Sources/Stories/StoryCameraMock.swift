@preconcurrency import AVFoundation
import UIKit

/// A scripted story camera: a moving gradient for a preview, a rendered frame
/// for a photo and a real H.264 file for a video. It exists because a
/// simulator has no capture device, so without it nothing above the engine
/// (the shutter, the hold, the ring, the flip, the flash, the draft that
/// follows) could be run or tested anywhere but a phone. Chosen only on a
/// debug build with `PQP_STORY_CAMERA=mock`, see `StoryCameraEngineFactory`.
@MainActor
final class MockStoryCameraEngine: StoryCameraEngine {
    private(set) var position: StoryCameraPosition = .back
    private(set) var zoom: Double = 1
    let zoomRange: ClosedRange<Double> = 0.5...5
    var hasFlash: Bool { position == .back }
    let hasMultipleCameras = true
    let recordsAudio = false
    var onInterruption: (@MainActor (StoryCameraFailure) -> Void)?

    private var recordingStartedAt: Date?
    private weak var preview: MockPreviewView?
    private(set) var photosTaken = 0
    private(set) var lastFlash: StoryFlash = .off

    func makePreviewView() -> UIView {
        let view = MockPreviewView()
        view.apply(position: position, zoom: zoom)
        preview = view
        return view
    }

    func start() async throws {}
    func stop() {}

    func flip() async {
        position = position.flipped
        zoom = 1
        preview?.apply(position: position, zoom: zoom)
    }

    func setZoom(_ display: Double) {
        zoom = min(max(display, zoomRange.lowerBound), zoomRange.upperBound)
        preview?.apply(position: position, zoom: zoom)
    }

    func focus(at point: CGPoint, in size: CGSize) {}

    func capturePhoto(flash: StoryFlash) async throws -> UIImage {
        photosTaken += 1
        lastFlash = flash
        let size = CGSize(width: 1080, height: 1920)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let position = position
        let count = photosTaken
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            MockPreviewView.draw(position: position, in: context.cgContext, size: size, phase: Double(count) / 4)
            let label = (position == .front ? "FRONT" : "BACK") + " #\(count)"
            (label as NSString).draw(
                at: CGPoint(x: 80, y: 120),
                withAttributes: [.font: UIFont.systemFont(ofSize: 96, weight: .heavy), .foregroundColor: UIColor.white]
            )
        }
    }

    func startRecording(torch: Bool) async throws {
        recordingStartedAt = Date()
    }

    func stopRecording() async throws -> URL {
        let elapsed = min(Date().timeIntervalSince(recordingStartedAt ?? Date()), Double(StoryLimits.maxVideoMs) / 1000)
        recordingStartedAt = nil
        return try await StoryTestVideo.write(duration: max(0.5, elapsed))
    }
}

private final class MockPreviewView: UIView {
    private let label = UILabel()
    private let content = CAGradientLayer()
    private let orb = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        layer.addSublayer(content)
        orb.backgroundColor = UIColor(white: 1, alpha: 0.35).cgColor
        orb.cornerRadius = 70
        orb.bounds = CGRect(x: 0, y: 0, width: 140, height: 140)
        layer.addSublayer(orb)
        label.font = .systemFont(ofSize: 22, weight: .heavy)
        label.textColor = .white
        label.textAlignment = .center
        label.isAccessibilityElement = true
        label.accessibilityIdentifier = "camera.mock.preview"
        addSubview(label)
        let move = CABasicAnimation(keyPath: "position.x")
        move.fromValue = 90
        move.toValue = 300
        move.duration = 2.4
        move.autoreverses = true
        move.repeatCount = .infinity
        orb.add(move, forKey: "move")
        orb.position = CGPoint(x: 90, y: 300)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = bounds
        label.frame = CGRect(x: 0, y: bounds.height * 0.42, width: bounds.width, height: 60)
    }

    func apply(position: StoryCameraPosition, zoom: Double) {
        let colors = Self.colors(position)
        content.colors = colors
        content.startPoint = CGPoint(x: 0, y: 0)
        content.endPoint = CGPoint(x: 1, y: 1)
        let name = position == .front ? "front camera" : "back camera"
        label.text = "mock \(name) \(StoryZoom.label(zoom))"
        label.accessibilityValue = position == .front ? "front" : "back"
        // A front preview is mirrored; flip the orb's travel to show it.
        orb.setAffineTransform(position == .front ? CGAffineTransform(scaleX: -1, y: 1) : .identity)
    }

    nonisolated static func colors(_ position: StoryCameraPosition) -> [CGColor] {
        position == .front
            ? [UIColor(red: 0.95, green: 0.55, blue: 0.35, alpha: 1).cgColor, UIColor(red: 0.45, green: 0.2, blue: 0.55, alpha: 1).cgColor]
            : [UIColor(red: 0.15, green: 0.55, blue: 0.7, alpha: 1).cgColor, UIColor(red: 0.07, green: 0.2, blue: 0.3, alpha: 1).cgColor]
    }

    nonisolated static func draw(position: StoryCameraPosition, in context: CGContext, size: CGSize, phase: Double) {
        let space = CGColorSpaceCreateDeviceRGB()
        if let gradient = CGGradient(colorsSpace: space, colors: colors(position) as CFArray, locations: [0, 1]) {
            context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        context.setFillColor(UIColor(white: 1, alpha: 0.35).cgColor)
        let x = size.width * (0.2 + 0.6 * (phase.truncatingRemainder(dividingBy: 1)))
        context.fillEllipse(in: CGRect(x: x - 140, y: size.height * 0.55, width: 280, height: 280))
    }
}

/// A real, playable MP4 of a moving gradient. Used by the mock camera and by
/// the trimmer's tests, which need a 35 s file without shipping a fixture.
enum StoryTestVideo {
    static func write(duration: TimeInterval, size: CGSize = CGSize(width: 360, height: 640), fps: Int32 = 10) async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("story-test-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
            ]
        )
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? StoryCameraFailure.captureFailed }
        writer.startSession(atSourceTime: .zero)
        let frames = max(2, Int((duration * Double(fps)).rounded()))
        for index in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            guard let pool = adaptor.pixelBufferPool else { throw StoryCameraFailure.captureFailed }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw StoryCameraFailure.captureFailed }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let context = CGContext(
                data: CVPixelBufferGetBaseAddress(buffer), width: Int(size.width), height: Int(size.height),
                bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            ) {
                MockPreviewView.draw(position: .back, in: context, size: size, phase: Double(index) / Double(fps * 3))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps))
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? StoryCameraFailure.captureFailed }
        return url
    }
}
