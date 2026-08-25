import Foundation

/// The extension's end of the bridge: connect, write frames, notice when the app
/// is gone.
///
/// Deliberately blocking. `processSampleBuffer` is already called on ReplayKit's
/// own serial queue, and a blocking write there is the backpressure: if the app
/// cannot keep up, the extension waits rather than growing a queue inside a
/// process with a 50 MB ceiling.
///
/// AT 30 fps THAT BACKPRESSURE NEEDED A LITTLE SLACK. A frame is ~1.38 MB and
/// the default send buffer on a Unix stream socket is a few kilobytes, so every
/// write used to be several hundred round trips through the kernel, each one
/// parked until the app happened to read again. At 12 fps there were 83 ms of
/// room per frame to absorb that; at 30 there are 33. So the buffer is raised to
/// hold roughly one frame and a half: enough that a frame's write is usually one
/// pass and a moment of app-side jitter is absorbed rather than felt, and small
/// enough that it cannot become a queue measured in seconds, which is the whole
/// thing blocking writes exist to prevent.
final class ScreenShareSocketClient {
    private var descriptor: Int32 = -1

    /// Roughly one and a half 720p NV12 frames. Requested, not demanded: the
    /// kernel clamps to its own maximum and a refusal is not worth failing over.
    private static let sendBufferBytes: Int32 = 2 * 1024 * 1024

    var isConnected: Bool { descriptor >= 0 }

    /// Opens the connection. False means the app is not listening — which is the
    /// normal case when a broadcast is started while the app is not in a call.
    func connect(to url: URL) -> Bool {
        close()
        guard var address = sockaddrUn(for: url.path) else { return false }
        let socketDescriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else { return false }
        // Without this a write to a socket the app has closed raises SIGPIPE and
        // takes the extension down with it, mid-broadcast.
        var on: Int32 = 1
        setsockopt(socketDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var sendBuffer = Self.sendBufferBytes
        setsockopt(
            socketDescriptor, SOL_SOCKET, SO_SNDBUF,
            &sendBuffer, socklen_t(MemoryLayout<Int32>.size)
        )

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(socketDescriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(socketDescriptor)
            return false
        }
        descriptor = socketDescriptor
        return true
    }

    /// What happened to one frame.
    ///
    /// `dropped` is not `failed`, and conflating them is how a busy moment
    /// would tear down a working broadcast. A dropped frame is the bridge doing
    /// its job; a failed one means the app is gone.
    enum WriteOutcome {
        case sent
        case dropped
        case failed
    }

    /// Writes one frame: its header, then its two planes, in place.
    ///
    /// NOTHING IS CONCATENATED. The three regions go out back to back on a
    /// stream socket, which is exactly what the reader reassembles anyway, so
    /// joining them first would only buy two 1.38 MB allocations and copies per
    /// frame. At 30 fps that is 83 MB/s of churn inside a process the OS kills
    /// rather than warns.
    ///
    /// A frame is dropped whole or sent whole. The check is made before the
    /// first byte, because a stream has no way to un-send half a frame: once the
    /// header is out, the reader is waiting for exactly that many bytes and
    /// abandoning it desynchronises the link.
    func write(
        header: Data,
        luma: UnsafeRawBufferPointer,
        chroma: UnsafeRawBufferPointer
    ) -> WriteOutcome {
        guard descriptor >= 0 else { return .failed }
        // Not writable at all means the app has stopped reading: its own queue
        // is full and ours is about to be. Better to skip this frame than to
        // park ReplayKit's thread inside a write while more frames arrive
        // behind it.
        guard isWritable() else { return .dropped }
        return header.withUnsafeBytes { headerBytes -> WriteOutcome in
            for region in [headerBytes, luma, chroma] where region.count > 0 {
                guard writeAll(region) else { return .failed }
            }
            return .sent
        }
    }

    /// Writes every byte of one region, retrying short writes.
    private func writeAll(_ region: UnsafeRawBufferPointer) -> Bool {
        guard let base = region.baseAddress else { return true }
        var offset = 0
        while offset < region.count {
            let written = Darwin.write(descriptor, base.advanced(by: offset), region.count - offset)
            if written > 0 {
                offset += written
                continue
            }
            if written < 0 && errno == EINTR { continue }
            return false
        }
        return true
    }

    /// Whether the kernel would take anything at all right now.
    private func isWritable() -> Bool {
        var descriptorSet = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
        let result = withUnsafeMutablePointer(to: &descriptorSet) {
            Darwin.poll($0, 1, 0)
        }
        // A poll that errors is not evidence the link is dead; let the write
        // find out for certain rather than dropping frames on a guess.
        guard result >= 0 else { return true }
        return result > 0 && descriptorSet.revents & Int16(POLLOUT) != 0
    }

    func close() {
        guard descriptor >= 0 else { return }
        Darwin.close(descriptor)
        descriptor = -1
    }
}

/// The app's end: listen, accept one broadcast at a time, hand whole frames up.
///
/// Polled rather than blocking, so `stop()` is a flag rather than closing a
/// descriptor another thread is parked inside.
///
/// `@unchecked Sendable` because every mutable field is touched only on `queue`
/// (or, for `isRunning`, through a lock) — the type is a serial actor in all but
/// name, and cannot be an actor because its loop is a blocking `poll`.
final class ScreenShareSocketServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "gg.pqp.screenshare.bridge")
    private let lock = NSLock()
    private var running = false
    private var listenDescriptor: Int32 = -1
    private var clientDescriptor: Int32 = -1
    private var parser = ScreenShareFrameParser()
    private let onFrame: @Sendable (ScreenShareFrameHeader, Data) -> Void
    /// Held across reads rather than allocated per read. A 720p frame is ~1.38
    /// MB, so at 30 fps this loop runs a few hundred times a second and a fresh
    /// buffer each time would be pure garbage.
    private var chunk = [UInt8](repeating: 0, count: readChunkBytes)

    /// Longest `sockaddr_un.sun_path` Darwin accepts, including its terminator.
    static let maximumPathLength = 104

    /// 256 KB rather than 64: a frame is about 1.38 MB, so this is the
    /// difference between six syscalls per frame and twenty two, and at 30 fps
    /// that is 180 a second instead of 660.
    private static let readChunkBytes = 256 * 1024

    /// The other half of the client's raised send buffer. A reader with a small
    /// receive buffer makes the sender block whatever the sender asked for.
    private static let receiveBufferBytes: Int32 = 2 * 1024 * 1024

    init(onFrame: @escaping @Sendable (ScreenShareFrameHeader, Data) -> Void) {
        self.onFrame = onFrame
    }

    deinit { stop() }

    /// Binds and starts accepting. False means the socket could not be created —
    /// no App Group entitlement, or a container path too long for `sockaddr_un`,
    /// which is the simulator's situation and one reason the extension is
    /// device-only.
    func start(at url: URL) -> Bool {
        stop()
        // A socket file from a previous run is not reusable and `bind` fails on
        // it, so it goes first. Nothing else lives at this name.
        try? FileManager.default.removeItem(at: url)
        guard var address = sockaddrUn(for: url.path) else { return false }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(descriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            return false
        }
        setNonBlocking(descriptor)
        listenDescriptor = descriptor
        lock.withLock { running = true }
        queue.async { [weak self] in self?.loop() }
        return true
    }

    func stop() {
        lock.withLock { running = false }
        // Closed here rather than on the queue: the loop only ever polls with a
        // timeout, so it notices the flag within one tick and touches nothing
        // after that.
        if clientDescriptor >= 0 {
            Darwin.close(clientDescriptor)
            clientDescriptor = -1
        }
        if listenDescriptor >= 0 {
            Darwin.close(listenDescriptor)
            listenDescriptor = -1
        }
    }

    private var isRunning: Bool { lock.withLock { running } }

    private func loop() {
        while isRunning {
            if clientDescriptor < 0 {
                acceptOne()
                continue
            }
            readAvailable()
        }
    }

    private func acceptOne() {
        let descriptor = listenDescriptor
        guard descriptor >= 0, poll(descriptor, timeoutMs: 200) else { return }
        let accepted = accept(descriptor, nil, nil)
        guard accepted >= 0 else { return }
        setNonBlocking(accepted)
        var on: Int32 = 1
        setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var receiveBuffer = Self.receiveBufferBytes
        setsockopt(
            accepted, SOL_SOCKET, SO_RCVBUF,
            &receiveBuffer, socklen_t(MemoryLayout<Int32>.size)
        )
        parser.reset()
        clientDescriptor = accepted
    }

    private func readAvailable() {
        let descriptor = clientDescriptor
        guard descriptor >= 0, poll(descriptor, timeoutMs: 200) else { return }
        let read = chunk.withUnsafeMutableBytes { raw in
            Darwin.read(descriptor, raw.baseAddress, raw.count)
        }
        if read > 0 {
            guard let frames = parser.append(Data(chunk[0..<read])) else {
                // Out of sync. Dropping the connection makes the extension
                // reconnect with a fresh stream, which is the only recovery
                // worth having on a link only this app writes to.
                dropClient()
                return
            }
            for frame in frames { onFrame(frame.header, frame.payload) }
            return
        }
        if read < 0 && (errno == EAGAIN || errno == EINTR) { return }
        // 0 is a clean close by the extension, anything else is a broken link;
        // both mean "wait for the next broadcast".
        dropClient()
    }

    private func dropClient() {
        if clientDescriptor >= 0 {
            Darwin.close(clientDescriptor)
            clientDescriptor = -1
        }
        parser.reset()
    }

    private func poll(_ descriptor: Int32, timeoutMs: Int32) -> Bool {
        var descriptorSet = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let result = withUnsafeMutablePointer(to: &descriptorSet) {
            Darwin.poll($0, 1, timeoutMs)
        }
        return result > 0 && descriptorSet.revents & Int16(POLLIN) != 0
    }

    private func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL, 0)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    }
}

/// Fills a `sockaddr_un`, or refuses a path Darwin cannot hold.
///
/// The limit is 104 bytes including the terminator, which is why the socket is
/// named `s.sock`: an App Group container path on a device is already ~90
/// characters, and a longer name would silently truncate into a path nobody
/// binds.
private func sockaddrUn(for path: String) -> sockaddr_un? {
    let bytes = Array(path.utf8)
    guard !bytes.isEmpty,
          bytes.count < ScreenShareSocketServer.maximumPathLength else { return nil }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    return address
}
