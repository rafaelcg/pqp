import CoreVideo
import Foundation

/// The app's end of the ReplayKit bridge: turns the extension's NV12 frames back
/// into `CVPixelBuffer`s that WebRTC can publish.
///
/// Lives in the app because the peer connections do. See `ScreenShareWire` for
/// the transport's reasoning; this class is only the pixel side of it.
///
/// `@unchecked Sendable`: the only mutable state is the pixel-buffer pool, which
/// is touched exclusively on the socket server's serial queue.
final class ScreenShareReceiver: @unchecked Sendable {
    /// A decoded frame, plus how far it must be rotated to be upright.
    typealias FrameHandler = @Sendable (UncheckedBox<CVPixelBuffer>, Int) -> Void

    private let onFrame: FrameHandler
    private var server: ScreenShareSocketServer?
    private var pool: CVPixelBufferPool?
    private var poolSize: (width: Int, height: Int) = (0, 0)
    private var synthetic: Task<Void, Never>?

    init(onFrame: @escaping FrameHandler) {
        self.onFrame = onFrame
    }

    deinit { server?.stop(); synthetic?.cancel() }

    /// Starts listening for a broadcast.
    ///
    /// False means the bridge cannot exist on this build — no App Group
    /// container, or a container path too long for a Unix socket, which is the
    /// simulator's case. Callers surface that as "screen sharing needs a device"
    /// rather than leaving a share button that does nothing.
    @discardableResult
    func start(socketURL: URL? = ScreenShareWire.socketURL()) -> Bool {
        stop()
        guard let socketURL else { return false }
        let server = ScreenShareSocketServer { [weak self] header, payload in
            self?.deliver(header: header, payload: payload)
        }
        guard server.start(at: socketURL) else { return false }
        self.server = server
        return true
    }

    func stop() {
        synthetic?.cancel()
        synthetic = nil
        server?.stop()
        server = nil
    }

    private func deliver(header: ScreenShareFrameHeader, payload: Data) {
        guard payload.count == header.payloadLength,
              let buffer = pixelBuffer(for: header, payload: payload) else { return }
        onFrame(UncheckedBox(buffer), header.rotation)
    }

    /// Copies packed NV12 into a pooled buffer.
    ///
    /// Row by row rather than one `memcpy`: a `CVPixelBuffer`'s rows are padded
    /// to an alignment the allocator chooses, and assuming they are tight
    /// produces a picture that shears further with every row.
    private func pixelBuffer(
        for header: ScreenShareFrameHeader,
        payload: Data
    ) -> CVPixelBuffer? {
        guard let pool = pool(width: header.width, height: header.height) else { return nil }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
              let buffer else { return nil }
        guard CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        let copied = payload.withUnsafeBytes { source -> Bool in
            guard let base = source.baseAddress,
                  let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
                  let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) else { return false }
            let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
            let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
            for row in 0..<header.height {
                memcpy(
                    luma.advanced(by: row * lumaStride),
                    base.advanced(by: row * header.width),
                    header.width
                )
            }
            let chromaRows = header.height / 2
            for row in 0..<chromaRows {
                memcpy(
                    chroma.advanced(by: row * chromaStride),
                    base.advanced(by: header.lumaLength + row * header.width),
                    header.width
                )
            }
            return true
        }
        return copied ? buffer : nil
    }

    private func pool(width: Int, height: Int) -> CVPixelBufferPool? {
        if let pool, poolSize == (width, height) { return pool }
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String:
                Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        var created: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(
            nil,
            // Small on purpose: a deep pool of 720p frames is megabytes of
            // resident memory holding pictures nobody will ever draw.
            [kCVPixelBufferPoolMinimumBufferCountKey as String: 3] as CFDictionary,
            attributes as CFDictionary,
            &created
        ) == kCVReturnSuccess, let created else { return nil }
        pool = created
        poolSize = (width, height)
        return created
    }

    // MARK: - Debug

    #if DEBUG
    /// A moving test pattern in place of a real broadcast.
    ///
    /// The extension cannot run in the simulator, and the *wire* half of screen
    /// sharing — publishing under a stream id the far end classifies as a share —
    /// is exactly what a simulator can prove. This feeds the same publish path
    /// the bridge does, so what the far end sees is produced by the real code.
    /// Debug-only and only reachable from `-pqp.fakeScreenShare`.
    func startSynthetic(width: Int = 640, height: Int = 360) {
        stop()
        synthetic = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                self.emitSynthetic(width: width, height: height, tick: tick)
                tick += 1
                try? await Task.sleep(for: .milliseconds(83))
            }
        }
    }

    private func emitSynthetic(width: Int, height: Int, tick: Int) {
        let header = ScreenShareFrameHeader(width: width, height: height)
        var payload = Data(count: header.payloadLength)
        payload.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for row in 0..<height {
                for column in 0..<width {
                    // A diagonal band that walks, so a frozen frame is obvious.
                    let value = (row + column + tick * 8) % 256
                    base[row * width + column] = UInt8(value)
                }
            }
            // Neutral chroma: greyscale is enough to prove frames are moving.
            for index in 0..<header.chromaLength {
                base[header.lumaLength + index] = 128
            }
        }
        deliver(header: header, payload: payload)
    }
    #endif
}
