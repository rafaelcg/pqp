import Foundation

/// What a tap on the camera control means, and what to say when the camera is
/// not sending a picture.
///
/// Pure and separate from the two models that own a camera (`VoiceModel` for a
/// voice channel, `CallModel` for a DM call) because the bug this exists to
/// close was invisible by construction: the mesh reported a camera as started
/// whether or not `AVCaptureSession` had actually opened, so a failed start
/// looked exactly like a working one. Nothing about that is testable on a
/// simulator, which has no camera at all. The decisions around it are.
///
/// Two rules live here.
///
/// **One toggle at a time.** `enableCamera` is asynchronous: it asks for
/// permission, opens a capture device and renegotiates with every peer, which
/// on a phone on mobile data is comfortably long enough to tap the button
/// again. Two starts in flight build two `AVCaptureSession`s against the same
/// `AVCaptureDevice`, and the second one's `lockForConfiguration` fails or
/// interrupts the first. That is a camera that "sometimes does not turn on"
/// with nothing in the log and nothing on the screen.
///
/// **A failure is a sentence, not a silence.** Every way the camera can refuse
/// gets copy, in both languages, the same way `ScreenShareController` explains
/// a broadcast that starts and sends no frames.
enum CameraGate {
    /// A tap, resolved against what the model already knows.
    enum Action: Equatable {
        case start
        case stop
        /// A tap that changes nothing: a toggle is already in flight, the call
        /// is not up, or this seat may not publish.
        case ignore
    }

    /// - Parameters:
    ///   - isOn: what the button is currently showing.
    ///   - isBusy: a start or a stop is already running.
    ///   - isLive: the room (or call) is connected.
    ///   - canPublish: the server's SPEAK rule for this seat.
    static func act(isOn: Bool, isBusy: Bool, isLive: Bool, canPublish: Bool) -> Action {
        // Deliberately first, and deliberately above the `isOn` branch: a stop
        // racing a start is the same collision as two starts, and the losing
        // half of it is a capture device nobody released.
        if isBusy { return .ignore }
        // Turning the camera off is always allowed. A seat that just lost
        // SPEAK, or a room that just dropped, must still be able to close a
        // capture that is open; refusing here would leave the light on.
        if isOn { return .stop }
        guard isLive, canPublish else { return .ignore }
        return .start
    }
}

/// Why the camera is not sending a picture.
///
/// Every case reaches somebody. `noFrames` is the one that did not exist: a
/// capture session can start, report success and then deliver nothing, because
/// iOS interrupted it (another app took the camera, the phone went to the
/// background between the tap and the first frame) or because it never really
/// opened. The far end sees a black tile, this end sees a lit button, and
/// before this the app said nothing at all.
enum CameraFailure: Error, Equatable {
    /// Permission was refused, now or previously.
    case permission
    /// No usable capture device, or no format on it we can run.
    case noDevice
    /// `AVCaptureSession` refused to start. Usually the device is held by
    /// something else.
    case captureFailed
    /// It started and no frame ever arrived.
    case noFrames

    var message: String {
        switch self {
        case .permission:
            String(localized: "Camera access is off. Enable it in Settings.")
        case .noDevice:
            String(localized: "No camera is available on this phone.")
        case .captureFailed:
            String(localized: "Could not start the camera. Close anything else using it and try again.")
        case .noFrames:
            String(localized: "The camera turned on but no picture is getting through. Turn it off and on again.")
        }
    }

    /// How long a started capture may go without a frame before it is called a
    /// failure. Generous: a cold camera on an older phone takes a moment, and
    /// crying wolf here would train people to ignore the one message that
    /// means something.
    static let firstFrameDeadline: Duration = .seconds(5)
}
