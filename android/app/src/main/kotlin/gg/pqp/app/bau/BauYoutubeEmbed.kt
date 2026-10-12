package gg.pqp.app.bau

import java.net.URI

/**
 * The rules behind the inline YouTube player in the Baú (`BauYoutube.kt`),
 * pure so they are tested on the JVM.
 *
 * The web has always embedded a YouTube post (`community-home-media.tsx`); the
 * phone used to hand the link to the YouTube app. Now it plays in the card, in
 * a WebView running YouTube's IFrame Player from `youtube-nocookie.com`, the
 * same host as the web's iframe. The iOS twin is `BauYoutubePlayer.swift`.
 */
object BauYoutubeEmbed {
    /**
     * The origin the player page says it lives on. YouTube refuses an embed
     * whose request names no referrer (player error 153), and a WebView that
     * loads the embed URL directly sends none, so the page is loaded with this
     * as its base URL and the iframe asks YouTube exactly as pqp.gg's does.
     */
    const val PAGE_ORIGIN = "https://pqp.gg"

    /** Where the IFrame Player is served from (`youtubeEmbedSrc` in shared). */
    const val PLAYER_HOST = "https://www.youtube-nocookie.com"

    /** The name of the JavaScript interface the page reports to. */
    const val BRIDGE = "bauYoutube"

    /** The public thumbnail every video has, shown until the first tap. */
    fun posterUrl(videoId: String): String = "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"

    /**
     * A full-bleed player that starts at once (the tap that built it is the
     * gesture), plays inline and reports its state. [videoId] is the eleven
     * characters [YoutubeLinks.videoId] already validated, so it cannot carry
     * markup.
     */
    fun playerPage(videoId: String, origin: String = PAGE_ORIGIN): String {
        val cleanOrigin = origin.trimEnd('/')
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
            function sendState(n){try{window.$BRIDGE.onState(n)}catch(e){}}
            function sendError(n){try{window.$BRIDGE.onError(n)}catch(e){}}
            var player;
            function onYouTubeIframeAPIReady(){
              player=new YT.Player('player',{
                host:'$PLAYER_HOST',
                videoId:'$videoId',
                width:'100%',height:'100%',
                playerVars:{playsinline:1,autoplay:1,rel:0,fs:1,origin:'$cleanOrigin'},
                events:{
                  onReady:function(e){e.target.playVideo()},
                  onStateChange:function(e){sendState(e.data)},
                  onError:function(e){sendError(e.data)}
                }
              });
            }
            function bauPause(){if(player&&player.pauseVideo){player.pauseVideo()}}
            </script>
            <script src="https://www.youtube.com/iframe_api" onerror="sendError(-1)"></script>
            </body>
            </html>
        """.trimIndent()
    }

    /**
     * Whether the WebView may follow a navigation. The page loads once (the
     * HTML, under [PAGE_ORIGIN]); every later main-frame navigation is a link
     * out of the player (its logo, the title, the end screen) and is refused,
     * which is what keeps a tap from landing in the YouTube app through an app
     * link. The player's own frames may load what they need over the web; a
     * `youtube:` or `intent:` scheme is a way into another app.
     */
    fun mayLoad(url: String?, isMainFrame: Boolean, pageOrigin: String = PAGE_ORIGIN): Boolean {
        val uri = url?.let { runCatching { URI(it) }.getOrNull() } ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme == "about") return true
        if (isMainFrame) {
            val page = runCatching { URI(pageOrigin) }.getOrNull() ?: return false
            val path = uri.rawPath.orEmpty()
            return scheme == page.scheme?.lowercase() &&
                uri.host?.lowercase() == page.host?.lowercase() &&
                uri.port == page.port &&
                (path.isEmpty() || path == "/")
        }
        return scheme in setOf("https", "http", "blob", "data")
    }

    /** What the player reports, as the app acts on it. */
    enum class Event { PLAYING, BUFFERING, STOPPED }

    /**
     * The IFrame Player's `onStateChange` codes, or null for one the app does
     * not act on. https://developers.google.com/youtube/iframe_api_reference#onStateChange
     */
    fun event(state: Int): Event? = when (state) {
        1 -> Event.PLAYING
        3 -> Event.BUFFERING
        0, 2, 5, -1 -> Event.STOPPED
        else -> null
    }
}
