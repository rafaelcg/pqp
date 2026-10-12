import SwiftUI
import WebKit

/**
 A YOUTUBE BAÚ POST, PLAYED WHERE IT SITS.

 Until this file a tap on a YouTube post left the app for the YouTube app.
 The web has always embedded it (`community-home-media.tsx`), so the phone
 now does what the web does: the poster first, and on the first tap a
 `WKWebView` with YouTube's IFrame Player, served from `youtube-nocookie.com`
 like the web's iframe.

 POSTER FIRST. Nothing from YouTube loads while a person scrolls past: the
 card is the public `i.ytimg.com` thumbnail until somebody taps it, and only
 then is the web view built. The tap is the user gesture, so the player
 starts with sound (`mediaTypesRequiringUserActionForPlayback = []`).

 IT NEVER LEAVES THE CARD. YouTube's player is full of links out (its logo,
 the title, "watch later", the end screen), and a WKWebView that follows one
 of them is how a tap ends up in the YouTube app again through a universal
 link. So the page's own frame may never navigate, a new window is refused,
 and a non-web scheme is refused anywhere (`BauYoutubeEmbed.decide`). The way
 out is the explicit "Open on YouTube" under the player, and nothing else.

 THE REFERRER. YouTube refuses an embed whose request names no referrer
 (player error 153), and a web view that loads the embed URL directly sends
 none. The player page is loaded with the instance's web origin as its base
 URL, so the iframe asks YouTube exactly as pqp.gg's own iframe does.

 SAME RULES AS AN UPLOADED VIDEO (`BauVideoPlayer.swift`): one Baú video holds
 the floor at a time, so this player starting pauses an uploaded one and the
 other way round (`BauPlayback.claimEmbed`); the audio session follows
 `BauPlaybackPolicy.audioPlan`, which leaves a live call's session exactly as
 it is; and scrolling away stops it and lets the web view go (the card is
 its poster again), since an embed has no Picture in Picture for the card to
 hand it to. Full screen is the player's own button,
 and it unlocks landscape through `WatchOrientation` while it is up.

 The VIP lock is upstream: a locked post carries no media at all, so this
 view is never built for one.
 */

// MARK: - Decisions (pure, so they can be tested without a device)

enum BauYoutubeEmbed {
    /// The origin the player page says it lives on: the instance's web app.
    static let pageOrigin = URL(string: "https://pqp.gg")!

    /// Where the IFrame Player is served from. The same privacy host the web
    /// iframe uses (`youtubeEmbedSrc` in shared).
    static let playerHost = "https://www.youtube-nocookie.com"

    /// The page the web view loads: a full-bleed player that starts at once
    /// (the tap that built it is the gesture), plays inline, and reports its
    /// state to the app. `videoId` is the eleven characters `YoutubeLinks`
    /// already validated, so it cannot carry markup.
    static func playerPage(videoId: String, origin: URL = pageOrigin) -> String {
        let origin = originString(origin)
        return """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
        <style>
        html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
        #player,iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}
        </style>
        </head>
        <body>
        <div id="player"></div>
        <script>
        function send(m){try{window.webkit.messageHandlers.\(messageHandler).postMessage(m)}catch(e){}}
        var player;
        function onYouTubeIframeAPIReady(){
          player=new YT.Player('player',{
            host:'\(playerHost)',
            videoId:'\(videoId)',
            width:'100%',height:'100%',
            playerVars:{playsinline:1,autoplay:1,rel:0,fs:1,origin:'\(origin)'},
            events:{
              onReady:function(e){e.target.playVideo()},
              onStateChange:function(e){send({state:e.data})},
              onError:function(e){send({error:e.data})}
            }
          });
        }
        function bauPause(){if(player&&player.pauseVideo){player.pauseVideo()}}
        </script>
        <script src="https://www.youtube.com/iframe_api" onerror="send({error:-1})"></script>
        </body>
        </html>
        """
    }

    /// The name the page posts its state under.
    static let messageHandler = "bauYoutube"

    enum NavigationDecision: Equatable { case allow, cancel }

    /// What the web view may load. The page itself only ever loads once (the
    /// HTML string, under `pageOrigin`); every later main-frame navigation is
    /// a link out of the player and is refused. The player's own frames may
    /// load what they need, over the web only: a `youtube:` or `intent:`
    /// scheme is a way into another app.
    static func decide(url: URL?, isMainFrame: Bool, opensNewWindow: Bool, pageOrigin: URL = pageOrigin) -> NavigationDecision {
        if opensNewWindow { return .cancel }
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == "about" { return .allow }
        if isMainFrame {
            let samePage = scheme == pageOrigin.scheme?.lowercased()
                && url.host?.lowercased() == pageOrigin.host?.lowercased()
                && url.port == pageOrigin.port
                && (url.path.isEmpty || url.path == "/")
            return samePage ? .allow : .cancel
        }
        return ["https", "http", "blob", "data"].contains(scheme) ? .allow : .cancel
    }

    /// The IFrame Player's states, as the page posts them.
    enum PlayerEvent: Equatable {
        case playing
        case stopped
        case buffering
        case failed(Int)
    }

    /// `{ state: n }` or `{ error: n }`, or nil for anything else.
    /// https://developers.google.com/youtube/iframe_api_reference#onStateChange
    static func event(from body: Any) -> PlayerEvent? {
        guard let dict = body as? [String: Any] else { return nil }
        if let code = (dict["error"] as? NSNumber)?.intValue { return .failed(code) }
        guard let state = (dict["state"] as? NSNumber)?.intValue else { return nil }
        switch state {
        case 1: return .playing
        case 3: return .buffering
        case 0, 2, 5, -1: return .stopped
        default: return nil
        }
    }

    private static func originString(_ url: URL) -> String {
        var raw = url.absoluteString
        while raw.hasSuffix("/") { raw.removeLast() }
        return raw
    }
}

// MARK: - Session

/// One tapped YouTube card: the web view and what it reports. Built on the
/// first tap and owned by the card, so a row the feed throws away takes its
/// player with it.
@MainActor
@Observable
final class BauYoutubeSession: NSObject {
    let id = UUID()
    let videoId: String
    private(set) var failed = false
    /// The web view was let go; the card shows its poster until the next tap.
    private(set) var isTornDown = false
    @ObservationIgnored var callActive = false
    @ObservationIgnored private(set) var isFullScreen = false
    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored private var fullscreenObservation: NSKeyValueObservation?
    @ObservationIgnored private var orientationOwner: UUID?
    @ObservationIgnored private var letGoWhenFullScreenEnds = false
    /// Another video displaced this one and its pause is on the way.
    @ObservationIgnored private var yielding = false

    init(videoId: String) {
        self.videoId = videoId
        super.init()
    }

    func makeWebView() -> WKWebView {
        if let webView { return webView }
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.preferences.isElementFullscreenEnabled = true
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(
            BauYoutubeMessageProxy(owner: self), name: BauYoutubeEmbed.messageHandler
        )

        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.navigationDelegate = self
        view.uiDelegate = self
        view.accessibilityIdentifier = "bau.media.youtube.player"
        fullscreenObservation = view.observe(\.fullscreenState, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                self?.fullScreenChanged(view.fullscreenState != .notInFullscreen)
            }
        }
        view.loadHTMLString(
            BauYoutubeEmbed.playerPage(videoId: videoId),
            baseURL: BauYoutubeEmbed.pageOrigin
        )
        webView = view
        return view
    }

    /// Pause, and give up the floor. Kept for full screen: the card leaving
    /// the feed under a full-screen player is not the person leaving it, so
    /// the player is let go when the full screen ends instead.
    func pause() {
        guard !isFullScreen else {
            letGoWhenFullScreenEnds = true
            return
        }
        forcePause()
    }

    /// Another video took the floor: pause whatever is showing.
    private func forcePause() {
        webView?.evaluateJavaScript("bauPause()", completionHandler: nil)
        webView?.pauseAllMediaPlayback(completionHandler: nil)
        BauPlayback.shared.releaseEmbed(id)
    }

    /// The card is back on screen: a pause it asked for on the way out no
    /// longer applies.
    func cardDidAppear() { letGoWhenFullScreenEnds = false }

    /// Stop and let go of the web view and its page, so a feed scrolled past
    /// several played videos does not keep a WebKit view for each.
    func tearDown() {
        isTornDown = true
        forcePause()
        fullscreenObservation = nil
        if let webView {
            webView.stopLoading()
            webView.configuration.userContentController
                .removeScriptMessageHandler(forName: BauYoutubeEmbed.messageHandler)
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
        }
        webView = nil
    }

    fileprivate func receive(_ body: Any) {
        guard let event = BauYoutubeEmbed.event(from: body) else { return }
        switch event {
        case .playing:
            // A "playing" still in flight from before another video displaced
            // this one must not take the floor back: pause again, and accept
            // a claim only after the player has said it stopped.
            guard !yielding else {
                forcePause()
                return
            }
            BauPlayback.shared.claimEmbed(id, callActive: callActive) { [weak self] in
                self?.yielding = true
                self?.forcePause()
            }
        case .buffering:
            break
        case .stopped:
            yielding = false
            BauPlayback.shared.releaseEmbed(id)
        case .failed:
            BauPlayback.shared.releaseEmbed(id)
            failed = true
        }
    }

    private func fullScreenChanged(_ inFullScreen: Bool) {
        guard inFullScreen != isFullScreen else { return }
        isFullScreen = inFullScreen
        if inFullScreen {
            let owner = UUID()
            orientationOwner = owner
            WatchOrientation.enterBauVideo(owner)
        } else {
            if let owner = orientationOwner {
                orientationOwner = nil
                WatchOrientation.leaveBauVideo(owner)
            }
            // The card left the feed under the full screen: finish what its
            // disappearance started, and the card shows its poster again.
            if letGoWhenFullScreenEnds {
                letGoWhenFullScreenEnds = false
                tearDown()
            }
        }
    }
}

extension BauYoutubeSession: WKNavigationDelegate, WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let decision = BauYoutubeEmbed.decide(
            url: navigationAction.request.url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
            opensNewWindow: navigationAction.targetFrame == nil
        )
        decisionHandler(decision == .allow ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        failed = true
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        failed = true
    }

    /// `target="_blank"` from inside the player: refused, never a new view.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        BauPlayback.shared.releaseEmbed(id)
        failed = true
    }
}

/// The content controller holds its handlers strongly; this keeps it from
/// holding the session (and so the web view) forever.
private final class BauYoutubeMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: BauYoutubeSession?

    init(owner: BauYoutubeSession) { self.owner = owner }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let body = message.body
        MainActor.assumeIsolated { owner?.receive(body) }
    }
}

// MARK: - The view

struct BauYoutubeVideo: View {
    @Environment(\.openURL) private var openURL
    @Environment(VoiceModel.self) private var voice
    @Environment(CallModel.self) private var call
    let videoId: String
    /// The URL the author pasted, which is what "Open on YouTube" opens.
    let watchURL: URL?
    let name: String

    /// Nil until the first tap: no web view, and nothing fetched from YouTube
    /// but the poster.
    @State private var session: BauYoutubeSession?

    private var callActive: Bool { voice.holdsSeat || call.phase.isInRoom }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Group {
                if let session, session.failed {
                    failure
                } else if let session, !session.isTornDown {
                    BauYoutubeSurface(session: session)
                } else {
                    poster
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))

            if let watchURL {
                Button { openURL(watchURL) } label: {
                    Label("Open on YouTube", systemImage: "arrow.up.right.square")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("bau.media.youtube.open")
            }
        }
        .onChange(of: callActive, initial: true) { _, now in session?.callActive = now }
        .onAppear { session?.cardDidAppear() }
        .onDisappear {
            // Scrolled away: the card goes back to its poster and the web view
            // is let go. Under a full screen it is kept until the full screen
            // ends, and let go then.
            guard let session else { return }
            if session.isFullScreen {
                session.pause()
            } else {
                session.tearDown()
                self.session = nil
            }
        }
    }

    private var poster: some View {
        Button(action: start) {
            // The base fixes the 16:9 and the thumbnail is an overlay, so its
            // 4:3 (letterboxed by YouTube) is cropped rather than let grow
            // the card.
            Palette.surfaceRaised
                .overlay {
                    AsyncImage(url: URL(string: "https://i.ytimg.com/vi/\(videoId)/hqdefault.jpg")) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        } else {
                            Palette.surfaceRaised
                        }
                    }
                }
                .clipped()
                .overlay {
                    Circle()
                        .fill(Palette.signal)
                        .frame(width: 56, height: 56)
                        .overlay(
                            Image(systemName: "play.fill")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(Palette.inkDeep)
                                .offset(x: 1)
                        )
                        .shadow(color: Palette.signal.opacity(0.35), radius: 14, y: 6)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name.isEmpty ? Text("Play video") : Text(name))
        .accessibilityIdentifier("bau.media.youtube")
    }

    private var failure: some View {
        ZStack {
            Palette.surfaceRaised
            VStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Palette.warning)
                Text("This video does not play here.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            }
        }
        .accessibilityIdentifier("bau.media.youtube.failed")
    }

    private func start() {
        let next = BauYoutubeSession(videoId: videoId)
        next.callActive = callActive
        session = next
    }
}

private struct BauYoutubeSurface: UIViewRepresentable {
    let session: BauYoutubeSession

    func makeUIView(context: Context) -> WKWebView { session.makeWebView() }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: ()) {
        (view.navigationDelegate as? BauYoutubeSession)?.pause()
    }
}
