import Accelerate
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import QuartzCore
import ReplayKit

/// The ReplayKit broadcast upload extension.
///
/// This is the only way an iOS app can share the *system* screen rather than its
/// own window — the same mechanism Discord uses. It runs as a separate process
/// with a hard memory ceiling (~50 MB, enforced by termination), which is why it
/// links nothing but Accelerate, ReplayKit and two files of this app's own.
///
/// Its whole job: take the frames, shrink them, and hand them to the app, where
/// the WebRTC peer connections live. See `ScreenShareWire` for why the bridge is
/// a Unix domain socket carrying raw NV12.
///
/// **Cannot run in the simulator.** ReplayKit broadcast picks a *real* screen;
/// there is no simulator equivalent, so everything below is exercised on device
/// only.
class SampleHandler: RPBroadcastSampleHandler {
    private let client = ScreenShareSocketClient()
    private var clock = ScreenShareFrameClock()
    private let scaler = ScreenShareScaler()
    /// When the app first refused the connection. The app has to be running and
    /// in a call to listen, and a broadcast started before that is a mistake
    /// worth reporting rather than a black rectangle nobody can explain.
    private var firstConnectAttempt: TimeInterval?
    private var lastConnectAttempt: TimeInterval = 0

    /// How long the app is given to start listening before the broadcast gives
    /// up and says why.
    private static let connectDeadline: TimeInterval = 10
    private static let connectRetryInterval: TimeInterval = 0.5

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        _ = tryConnect(now: CACurrentMediaTime())
    }

    override func broadcastFinished() {
        client.close()
    }

    override func processSampleBuffer(
        _ sampleBuffer: CMSampleBuffer,
        with type: RPSampleBufferType
    ) {
        // Audio is deliberately ignored. The app already has the microphone open
        // for the call, and app audio would arrive as a second, unmixable track.
        guard type == .video else { return }

        let now = CACurrentMediaTime()
        guard client.isConnected || tryConnect(now: now) else { return }

        // Rate limiting comes before any pixel work: the cheapest frame is the
        // one that is never scaled.
        guard clock.shouldPublish(at: now) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let source = (
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
        let target = screenShareTargetSize(width: source.width, height: source.height)
        guard target.width > 0, target.height > 0 else { return }

        guard scaler.scale(pixelBuffer, to: target) else { return }
        let header = ScreenShareFrameHeader(
            width: target.width,
            height: target.height,
            rotation: Self.rotation(of: sampleBuffer)
        )
        // Header and planes go out in place. Joining them into one buffer first
        // would cost two 1.38 MB allocations and copies per frame, which at 30
        // fps is 83 MB/s of churn in a process the OS kills rather than warns.
        let outcome = scaler.withPlanes { luma, chroma in
            client.write(header: header.encoded(), luma: luma, chroma: chroma)
        }
        if outcome == .failed {
            // The app went away. Closing means the next frame reconnects rather
            // than writing into a dead descriptor forever.
            client.close()
        }
    }

    /// Connects, at most every `connectRetryInterval`, and gives up loudly once
    /// the deadline passes.
    private func tryConnect(now: TimeInterval) -> Bool {
        guard now - lastConnectAttempt >= Self.connectRetryInterval else { return false }
        lastConnectAttempt = now
        if let url = ScreenShareWire.socketURL(), client.connect(to: url) {
            firstConnectAttempt = nil
            clock = ScreenShareFrameClock()
            return true
        }
        let started = firstConnectAttempt ?? now
        firstConnectAttempt = started
        if now - started >= Self.connectDeadline {
            finishBroadcastWithError(NSError(
                domain: "gg.pqp.app.broadcast",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: NSLocalizedString(
                    "Join a pqp call first, then share your screen.",
                    comment: "Shown when a broadcast starts with no call to share into"
                )]
            ))
        }
        return false
    }

    /// ReplayKit rotates the *buffer*, not the frame, when the device turns, and
    /// reports which way through this attachment.
    ///
    /// **Device-only to confirm.** The `.left`/`.right` ↔ 90°/270° pairing is the
    /// one thing here that no simulator can settle; if a landscape share arrives
    /// upside down, swapping these two cases is the whole fix.
    private static func rotation(of sampleBuffer: CMSampleBuffer) -> Int {
        guard let attachment = CMGetAttachment(
            sampleBuffer,
            key: RPVideoSampleOrientationKey as CFString,
            attachmentModeOut: nil
        ) as? NSNumber else { return 0 }
        switch CGImagePropertyOrientation(rawValue: attachment.uint32Value) {
        case .down: return 180
        case .left: return 90
        case .right: return 270
        default: return 0
        }
    }
}

/// Shrinks a biplanar 420 buffer into tightly packed NV12.
///
/// vImage rather than Core Image or `VTPixelTransferSession`: both of those pull
/// a rendering stack into a 50 MB process for what is two plane scales, and
/// `vImageScale_CbCr8` exists precisely so interleaved chroma can be resampled
/// without splitting Cb from Cr (scaling the plane as 16-bit greyscale, the
/// obvious shortcut, blends the two channels into each other and tints the
/// picture).
///
/// The destination buffers are held across frames on purpose: allocating two
/// megabytes per frame in this process is how a broadcast extension gets killed.
/// They are also *handed out* rather than copied into a `Data`, for the same
/// reason at three times the rate: see `withPlanes`.
final class ScreenShareScaler {
    private var luma: [UInt8] = []
    private var chroma: [UInt8] = []
    /// Whether the planes hold a whole frame. False before the first scale and
    /// after a failed one, so a caller cannot send the previous frame twice.
    private var isFilled = false

    /// Scales one frame into the planes this object keeps. They stay valid until
    /// the next call, which is exactly as long as the caller needs them.
    @discardableResult
    func scale(_ pixelBuffer: CVPixelBuffer, to size: (width: Int, height: Int)) -> Bool {
        isFilled = fill(from: pixelBuffer, size: size)
        return isFilled
    }

    /// Reads the scaled planes in place.
    ///
    /// The whole point is that nothing is copied: `body` receives the same
    /// memory `vImageScale` just wrote, which the socket then writes straight
    /// out. A version of this that returned `Data` would allocate and copy 1.38
    /// MB per frame, and the caller would concatenate it into another 1.38 MB.
    func withPlanes<R>(
        _ body: (UnsafeRawBufferPointer, UnsafeRawBufferPointer) -> R
    ) -> R? {
        guard isFilled else { return nil }
        return luma.withUnsafeBytes { lumaBytes in
            chroma.withUnsafeBytes { chromaBytes in
                body(lumaBytes, chromaBytes)
            }
        }
    }

    private func fill(from pixelBuffer: CVPixelBuffer, size: (width: Int, height: Int)) -> Bool {
        guard CVPixelBufferGetPlaneCount(pixelBuffer) == 2 else { return false }
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else {
            return false
        }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let lumaSource = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
              let chromaSource = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
            return false
        }
        let lumaBytes = size.width * size.height
        let chromaBytes = size.width * (size.height / 2)
        if luma.count != lumaBytes { luma = [UInt8](repeating: 0, count: lumaBytes) }
        if chroma.count != chromaBytes { chroma = [UInt8](repeating: 0, count: chromaBytes) }

        var sourceLuma = vImage_Buffer(
            data: lumaSource,
            height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)),
            width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)),
            rowBytes: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        )
        var sourceChroma = vImage_Buffer(
            data: chromaSource,
            height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)),
            width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(pixelBuffer, 1)),
            rowBytes: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        )

        let flags = vImage_Flags(kvImageNoFlags)
        var scaled = kvImageNoError
        luma.withUnsafeMutableBytes { destination in
            var destinationLuma = vImage_Buffer(
                data: destination.baseAddress,
                height: vImagePixelCount(size.height),
                width: vImagePixelCount(size.width),
                rowBytes: size.width
            )
            scaled = vImageScale_Planar8(&sourceLuma, &destinationLuma, nil, flags)
        }
        guard scaled == kvImageNoError else { return false }

        chroma.withUnsafeMutableBytes { destination in
            // `width` counts CbCr *pairs*, so the row is twice as many bytes.
            var destinationChroma = vImage_Buffer(
                data: destination.baseAddress,
                height: vImagePixelCount(size.height / 2),
                width: vImagePixelCount(size.width / 2),
                rowBytes: size.width
            )
            scaled = vImageScale_CbCr8(&sourceChroma, &destinationChroma, nil, flags)
        }
        guard scaled == kvImageNoError else { return false }

        return true
    }
}
