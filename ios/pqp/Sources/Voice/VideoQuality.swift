import Foundation

/// What the camera and the screen share are asked for, and what their encoders
/// are allowed to spend.
///
/// The iOS half of `client/src/lib/video-quality.ts`. It has to stay the same
/// five words with the same meanings: the choice is per device, but the picture
/// it produces is what everyone else in the room receives, so "720p" cannot mean
/// one thing on a laptop and something else on a phone.
///
/// ## Read this before changing a number
///
/// The web ladder shipped once as a bitrate ceiling and nothing else, and every
/// rung below 1080p still arrived at the far end as 1920x1080. A ceiling with
/// nothing behind it does not make a smaller picture, it makes the same picture
/// worse: the encoder ramps up to the capture size, stays there, and pays the
/// smaller allowance in artefacts rather than in pixels. Somebody picked 360p
/// and got a blocky full-size picture, which was reported by eye and fixed in
/// PR #84 by pinning the size as well as the rate.
///
/// So every rung below `auto` names a size, and that size is applied with
/// `scaleResolutionDownBy`, which is a **divisor** rather than a size. A divisor
/// only means something against the source it divides, which is why nothing here
/// hard-codes one: a hard-coded 3 is 360p on a 1080-line source and 480p on a
/// 1440-line one, and the same label has to mean the same picture on both.
///
/// `auto` deliberately pins nothing. It is the one rung that names no size, so
/// the encoder stays free to climb and fall with the link, which is the whole
/// meaning of the word.
enum VideoQuality: String, CaseIterable, Sendable {
    case auto
    case p1080 = "1080p"
    case p720 = "720p"
    case p480 = "480p"
    case p360 = "360p"

    /// Storage and launch arguments hand back strings that may be anything.
    /// This is the only door in, matching `parseVideoQuality` on the web.
    static func parse(_ raw: String?) -> VideoQuality {
        guard let raw, let quality = VideoQuality(rawValue: raw) else { return .auto }
        return quality
    }

    /// The number of picture lines this label promises the far end, or nil for
    /// `auto`, which promises nothing on purpose.
    ///
    /// Lines rather than pixels across, because that is what "360p" has always
    /// meant and because it stays meaningful whichever way the phone is held.
    var lines: Int? {
        switch self {
        case .auto: nil
        case .p1080: 1080
        case .p720: 720
        case .p480: 480
        case .p360: 360
        }
    }

    /// What the picker says. `auto` is a word and is translated; the rest are
    /// measurements and are not.
    var label: String {
        switch self {
        case .auto: String(localized: "Auto")
        case .p1080: "1080p"
        case .p720: "720p"
        case .p480: "480p"
        case .p360: "360p"
        }
    }
}

/// The two things a quality controls for a camera, and nothing else.
struct CameraVideoProfile: Equatable, Sendable {
    /// Lines to capture. Used to pick the smallest `AVCaptureDevice.Format`
    /// that can carry the choice, and then to solve the encoder's divisor.
    let lines: Int
    let frameRate: Int
    /// Ceiling for the sender, in bits per second. Never a target: WebRTC's own
    /// bandwidth estimate is consulted several times a second and the lower of
    /// the two is what goes out. On a link that cannot do 2.5 Mbps this number
    /// is inert, which is why lowering it "to be safe" helps nobody and costs
    /// the person on a good uplink their sharp picture.
    let maxBitrate: Int
}

extension VideoQuality {
    /// Bitrates sized for one peer on a domestic uplink, copied from the web
    /// ladder so the same word costs the same on both clients.
    ///
    /// They exist mainly to stop a camera and a simultaneous screen share from
    /// bidding against each other for one bandwidth estimate on one connection,
    /// which is how a camera ends up at 240p while the share looks fine.
    private static let cameraProfiles: [VideoQuality: CameraVideoProfile] = [
        .p1080: CameraVideoProfile(lines: 1080, frameRate: 30, maxBitrate: 2_500_000),
        .p720: CameraVideoProfile(lines: 720, frameRate: 30, maxBitrate: 1_500_000),
        .p480: CameraVideoProfile(lines: 480, frameRate: 30, maxBitrate: 700_000),
        .p360: CameraVideoProfile(lines: 360, frameRate: 30, maxBitrate: 400_000),
    ]

    /// What `auto` asks the camera for.
    ///
    /// 720p30, matching the web. Auto is not "no opinion": that is exactly what
    /// produced the old 480p ceiling, here as well as there, because
    /// `bestFormat` used to pick the smallest format at or above 640x480 and a
    /// mesh call could never climb out of it. 720 rather than 1080 because a
    /// mesh uploads a full copy per peer from a battery, so 1080p is a choice
    /// with a cost rather than a free upgrade.
    static let autoCameraProfile = CameraVideoProfile(
        lines: 720, frameRate: 30, maxBitrate: 1_500_000
    )

    var cameraProfile: CameraVideoProfile {
        Self.cameraProfiles[self] ?? Self.autoCameraProfile
    }

    /// The chosen ceiling for a screen sender, in bits per second.
    ///
    /// NOT the camera's numbers, deliberately. "1080p" names a picture, not a
    /// bitrate, and what that picture costs depends on what is in it: a talking
    /// head is a still background with a moving oval and inter-frame prediction
    /// eats it alive, while a shared screen is full-frame motion with hard edges
    /// and text that becomes unreadable the moment the codec blurs it. The same
    /// 1080p30 costs roughly twice as much.
    ///
    /// `auto` is 3 Mbps: above the 2.5 Mbps every share used to get and below
    /// what a deliberate 1080p asks for. It has to be the right number for
    /// somebody who will never open this menu, on an uplink nobody has measured.
    var screenBitrate: Int {
        switch self {
        case .auto: 3_000_000
        case .p1080: 4_000_000
        case .p720: 2_000_000
        case .p480: 1_000_000
        case .p360: 600_000
        }
    }
}

/// Total upload a presenter may spend on the screen, and the floor the split
/// cannot go below. Both are the web's numbers, for the web's reasons.
///
/// A full mesh uploads a separate copy to every peer, so a per-peer rate
/// multiplies by the room: without this, a six-way call asks one domestic uplink
/// for six times the chosen ceiling and gets congestion collapse rather than
/// video. This client never had it, which mattered less while the screen was
/// pinned at 12 fps and matters a great deal now that it is not.
private let screenUploadBudgetBps = 5_000_000
private let screenMinBitrateBps = 600_000

/// What one screen sender is allowed, given the room and the chosen quality.
///
/// Three terms, in the order they matter, and the order is the point:
///
///  - the **chosen ceiling** is the user's answer to how much upload they are
///    willing to spend, and always wins as an upper bound. Picking 480p cannot
///    be overruled into sending 4 Mbps by an empty room.
///  - the **budget share** is the room's answer, and is what stops the mesh
///    multiplying.
///  - the **floor** only ever lifts the *share*, never the chosen ceiling, so
///    the division cannot produce something unwatchable in a crowded room. Past
///    the point where it binds, the honest fix is the SFU rather than a smaller
///    number.
func meshScreenBitrate(peerCount: Int, quality: VideoQuality) -> Int {
    let share = screenUploadBudgetBps / max(1, peerCount)
    return min(quality.screenBitrate, max(screenMinBitrateBps, share))
}

/// How much to divide a source picture by so it arrives at the size the menu
/// names.
///
/// WHY A DIVISOR AND NOT A SIZE. `RTCRtpEncodingParameters` offers
/// `scaleResolutionDownBy` and nothing else: a ratio applied to whatever the
/// track is currently producing. So the source's own line count is an argument
/// rather than an assumption, and it is read again on every re-tune, because a
/// rotated phone, a resized window and a camera format change all move it under
/// a live sender.
///
/// NEVER BELOW 1. A divisor under one is an upscale, which spends bitrate
/// inventing pixels that carry no detail. Somebody on a 720-line source who
/// picks 1080p gets their 720 lines unchanged, which is the honest reading of
/// the label.
///
/// - Parameters:
///   - sourceLines: what the source is really producing, or nil/0 when nothing
///     has arrived yet.
///   - fallbackLines: what to assume until it has. Assuming the size we asked
///     for beats assuming "no scaling", which would send full size to somebody
///     who chose 360p until something happened to re-tune the sender.
func videoScaleFactor(
    for quality: VideoQuality,
    sourceLines: Int?,
    fallbackLines: Int
) -> Double {
    guard let target = quality.lines, target > 0 else { return 1 }
    let lines = (sourceLines ?? 0) > 0 ? (sourceLines ?? 0) : fallbackLines
    guard lines > target else { return 1 }
    // Two decimals: enough for every rung on every panel and phone screen, and
    // short of the float noise that would make a re-tune look like a change
    // when nothing moved.
    return ((Double(lines) / Double(target)) * 100).rounded() / 100
}

/// The line count of a frame once it is the right way up.
///
/// WebRTC carries rotation beside the buffer rather than rotating it, and
/// ReplayKit hands the extension a buffer whose axes are already swapped for a
/// landscape device. The label is a promise about the picture a person sees, so
/// the promise is solved against the upright picture: at 90 or 270 degrees the
/// buffer's width is what ends up being its height.
func uprightVideoLines(width: Int, height: Int, rotation: Int) -> Int {
    (rotation == 90 || rotation == 270) ? width : height
}

// MARK: - SFU screen share plan

/// One simulcast rung of a screen share on the SFU, as the web declares it
/// (`SCREEN_SIMULCAST_RUNGS` in `client/src/lib/video-quality.ts`).
struct ScreenLayer: Equatable, Sendable {
    let width: Int
    let height: Int
    let maxBitrate: Int
    let maxFramerate: Int
}

/// The rungs a share can go up as beside its top layer. Same two as the web,
/// so a viewer on a weak link is offered the same 360p and 720p pictures
/// whether the presenter is a laptop or a phone.
let sfuScreenSimulcastRungs: [ScreenLayer] = [
    ScreenLayer(width: 640, height: 360, maxBitrate: 450_000, maxFramerate: 30),
    ScreenLayer(width: 1280, height: 720, maxBitrate: 1_400_000, maxFramerate: 30),
]

/// Past this many people in a room, a share that was not asked for by name
/// is held at `sfuLargeRoomScreenHeight` and `sfuLargeRoomScreenBitrate`.
/// The web's `LARGE_ROOM_PARTICIPANTS`, for the web's reason: a hundred
/// phones each receiving one full-rate 1080p stream is what fell over on
/// 5 Sep 2026, and the top layer is the one every viewer defaults to.
let sfuLargeRoomParticipants = 20
let sfuLargeRoomScreenHeight = 720
let sfuLargeRoomScreenBitrate = 1_500_000

/// What `auto` asks a screen capture for, in lines. The web's
/// `SCREEN_CAPTURE_HEIGHT`; on a phone the bridge already caps the long
/// side at `ScreenShareWire.maxLongSide`, so this is a ceiling the capture
/// rarely reaches rather than a size it is scaled up to.
let sfuScreenCaptureHeight = 1080

/// Frames per second a share may spend. The web's `VIDEO_MAX_FRAMERATE`.
let sfuScreenMaxFramerate = 30

/// The layers and the ceiling one SFU share goes up with.
///
/// Mirrors `screenSimulcastPlan` in `client/src/lib/video-quality.ts` field
/// for field, because a phone presenting to a room full of browsers has to
/// cost the room what a browser presenting would.
struct SfuScreenPlan: Equatable, Sendable {
    /// Lines the top layer promises.
    let topHeight: Int
    /// Ceiling for the top layer, in bits per second. A ceiling, not a target.
    let topBitrate: Int
    /// Every rung strictly below the top, smallest first.
    let lowerLayers: [ScreenLayer]
    /// True when the room's size, not the chosen quality, held the top down.
    let capped: Bool
}

/// Whether the room's size caps a share that was not chosen by name.
///
/// Somebody who picked 1080p in a big room asked for it and gets it; the cap
/// is for the presenter who never opened the menu.
func sfuIsLargeRoomCapped(quality: VideoQuality, participantCount: Int) -> Bool {
    participantCount > sfuLargeRoomParticipants && quality != .p1080
}

func sfuScreenPlan(quality: VideoQuality, participantCount: Int) -> SfuScreenPlan {
    let chosenHeight = quality.lines ?? sfuScreenCaptureHeight
    let capped = sfuIsLargeRoomCapped(quality: quality, participantCount: participantCount)
    let topHeight = capped ? min(chosenHeight, sfuLargeRoomScreenHeight) : chosenHeight
    let topBitrate = capped
        ? min(quality.screenBitrate, sfuLargeRoomScreenBitrate)
        : quality.screenBitrate
    return SfuScreenPlan(
        topHeight: topHeight,
        topBitrate: topBitrate,
        lowerLayers: sfuScreenSimulcastRungs.filter { $0.height < topHeight },
        // Only "the room decided" counts, as on the web: a chosen 720p in a
        // big room is what was asked for, not a cap.
        capped: capped && topHeight < chosenHeight
    )
}

/// Whether the share control is offered at all.
///
/// Two independent reasons to hide it, and hiding rather than disabling in
/// both cases: a broadcast this build cannot host (`isAvailable`, the
/// simulator or a missing App Group) would open a sheet leading nowhere, and
/// a share the server would refuse (`canSpeak == false`, the channel's SPEAK
/// permission, which is also the screen and camera grant) would end in a
/// `screen-share-denied` after the person has already started a system
/// broadcast. The web hides it for the same reason (`welcome.canSpeak`).
func screenShareIsOffered(isAvailable: Bool, canSpeak: Bool) -> Bool {
    isAvailable && canSpeak
}
