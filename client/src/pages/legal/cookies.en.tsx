import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Source of truth for the Cookie notice. `cookies.pt-BR.tsx` translates it.
 */
export const cookiesEn: LegalDocument = {
  locale: "en",
  path: "/cookies",
  title: "Cookie Notice — pqp",
  description:
    "Exactly which cookies, local storage keys and caches pqp.gg puts on your device, and which third parties your browser contacts.",
  heading: "Cookie notice",
  updated: "29 September 2026",
  sections: [
    {
      id: "intro",
      body: (
        <p>
          This notice lists the cookies, storage keys and third parties{" "}
          <strong>pqp.gg</strong> uses today. If a key is missing, that is a
          bug in this page, not a secret. Self-hosted instances may differ
          depending on how they are configured.
        </p>
      ),
    },
    {
      id: "cookies",
      heading: "Cookies",
      body: (
        <>
          <p>
            <strong>The pqp app itself sets no cookies.</strong> Every cookie on
            pqp.gg is set by one of two third parties. The first is{" "}
            <a href="https://clerk.com" target="_blank" rel="noreferrer">
              Clerk
            </a>
            , the service that signs you in. Clerk uses cookies such as <code>__session</code> and{" "}
            <code>__client_uat</code> (and its own browser storage) to keep you logged in and to protect against
            session hijacking. These are <strong>strictly necessary</strong>:
            block them and you cannot sign in at all. Clerk documents the
            individual cookie names and lifetimes on its own site.
          </p>
          <p>
            The second is the <strong>Google Ads tag</strong>. pqp.gg buys a
            small amount of advertising, and Google&apos;s tag loads on every
            page here so we can tell whether an ad produced an account rather
            than just a click. It sets a first-party cookie on the pqp.gg domain
            called <code>_gcl_au</code> for every visitor, holding a random
            identifier. When you arrive from an ad, it also records that ad
            click in other cookies whose names begin <code>_gcl_</code>, so a
            later sign-up can be matched back to it. These are{" "}
            <strong>not</strong> strictly necessary: block them and everything
            works exactly as before, and the sign-up simply goes uncounted.
            Google documents the names and lifetimes on its own site.
          </p>
          <p>
            <strong>What the tag sends to Google.</strong> Each time you load a
            page, the tag reports the page view: the page address and title,
            your screen size, your browser and operating system, and the{" "}
            <code>_gcl_au</code> identifier. Some of these reports go to the
            addresses Google Ads uses to build remarketing audiences. Our code
            sets the tag up in the ordinary way and does not turn off ad
            personalisation, so Google can add your visit to an audience list
            for our ad account, and our ads can be shown to you again. When an
            account is created, our code sends the tag one more event: that a
            sign-up happened. It is addressed to our ad account and carries
            nothing else, so it has no name, email or user id. Those are the
            only two things our code sends. Our code does not use enhanced
            conversions, the Google Ads feature that sends a hashed email
            address with a conversion. The tag is Google&apos;s own script, so
            what Google does with what it receives, under the settings of our
            ad account, is for Google to describe.
          </p>
          <p>
            Those are all the cookies on pqp.gg. Our analytics and error
            reporting set none, and the players embedded in some pages can set
            their own on their own domains (see &quot;Third parties your
            browser contacts&quot;). When the tag contacts Google&apos;s servers, Google
            can also read and set its own cookies on Google&apos;s domains, if
            your browser allows third-party cookies. Those are Google&apos;s,
            under Google&apos;s terms.
          </p>
          <p>
            <strong>This applies to pqp.gg only.</strong> The Google tag is added
            when the hosted site is built, and only when that build is given our
            advertising account id, so a self-hosted copy of pqp contacts no
            Google advertising server and sets no Google cookie.
          </p>
        </>
      ),
    },
    {
      id: "local-storage",
      heading: "Local storage",
      body: (
        <>
          <p>
            Your browser keeps these under the pqp.gg origin, so other websites
            cannot read them. Our code sends none of them to an advertiser. Most
            are settings. The ones that hold something you typed, or an id, say
            so. Signing out does not clear them: see &quot;Managing this&quot;.
          </p>
          <p>
            <strong>Appearance and language</strong>
          </p>
          <ul>
            <li>
              <code>pqp-theme</code>: light, dark, or follow the system.
            </li>
            <li>
              <code>pqp-appearance</code>: Classic, Harmony, Hearth, or Night.
              The named look, separate from light and dark.
            </li>
            <li>
              <code>pqp-accent-hue</code>: a custom accent colour, or the
              look&apos;s default.
            </li>
            <li>
              <code>pqp-contrast</code>: default, high, or follow the system
              contrast setting.
            </li>
            <li>
              <code>pqp-chat-display</code>: chat text size and message spacing.
            </li>
            <li>
              <code>pqp:locale</code>: your chosen language (English,
              Portuguese or Spanish), when you have set one.
            </li>
          </ul>
          <p>
            <strong>Voice, video and sound</strong>
          </p>
          <ul>
            <li>
              <code>pqp-local-settings</code>: mute-on-join, compact participant
              list, voice activation or push-to-talk and its key, input and
              output volume, whether link previews are shown, your keyboard shortcuts, and your other voice and video
              preferences. It also holds which microphone,
              camera and speaker you picked, as the ids your browser gives
              those devices.
            </li>
            <li>
              <code>pqp-sounds</code>: whether message and call sounds play on
              this device, and which ringtone.
            </li>
            <li>
              <code>pqp:auto-mute-join-leave-large-rooms</code>: whether join
              and leave sounds go quiet in a large call.
            </li>
            <li>
              <code>pqp:receive-quality</code>: the video quality you asked to
              receive.
            </li>
            <li>
              <code>pqp:video-fit</code>: whether camera, screen and watch
              video fill the tile or fit inside it.
            </li>
            <li>
              <code>pqp:share-cursor</code>,{" "}
              <code>pqp:hide-screen-preview</code>: whether your cursor shows in
              a screen share, and whether you see a preview of your own share.
            </li>
            <li>
              <code>pqp:call-split</code>,{" "}
              <code>pqp:participant-rail</code>: how the call and the chat split
              the window, and whether the participant rail is open.
            </li>
          </ul>
          <p>
            <strong>Watch parties and music</strong>
          </p>
          <ul>
            <li>
              <code>pqp:hls-quality</code>, <code>pqp:hls-volume</code>: the
              quality and volume you picked when watching a stream.
            </li>
            <li>
              <code>pqp:watch-party-activity-open</code>,{" "}
              <code>pqp:watch-party-audience-monitor</code>,{" "}
              <code>pqp:watch-camera-pip</code>,{" "}
              <code>pqp:watch-camera-voice-volume</code>: how the watch party
              screen is laid out, and the volume of the host&apos;s camera.
            </li>
            <li>
              <code>pqp:mic-in-stream</code>,{" "}
              <code>pqp:voice-track-mode</code>,{" "}
              <code>pqp:stream-mix-mic-gain</code>,{" "}
              <code>pqp:stream-mix-display-gain</code>: for a host, whether your
              microphone goes into the stream, on which track, and how loud it
              is next to the film.
            </li>
            <li>
              <code>pqp:watch-party-stream-quality:</code> followed by your
              account id: for a host, the stream height you picked.
            </li>
            <li>
              <code>pqp:music-volume</code>, <code>pqp:music-placement</code>,{" "}
              <code>pqp:music-duck</code>, <code>pqp:music-auto-join</code>:
              the music player&apos;s volume, whether its video shows on the
              stage, whether it gets quieter while people talk, and whether it
              turns on by itself when a room starts music.
            </li>
          </ul>
          <p>
            <strong>Layout and notifications</strong>
          </p>
          <ul>
            <li>
              <code>pqp-notifications</code>: whether you allowed desktop
              notifications, and your notification levels, keyed by server and
              channel id.
            </li>
            <li>
              <code>pqp:collapsed-categories</code>: the ids of the channel
              categories you collapsed in the sidebar.
            </li>
            <li>
              <code>pqp:member-sidebar</code>, <code>pqp:channel-sidebar</code>,{" "}
              <code>pqp:channel-sidebar-width</code>: whether the member list
              and the channel list are open, and how wide.
            </li>
            <li>
              <code>pqp:overview-start-here:</code> followed by a server id: for
              server staff, the channels you picked for that server&apos;s
              &quot;Start here&quot; cards.
            </li>
            <li>
              <code>pqp:community-home-viewer</code>: which member view of Baú
              you are previewing, after you open a preview link.
            </li>
          </ul>
          <p>
            <strong>Things you have already seen</strong>
          </p>
          <ul>
            <li>
              <code>pqp:arrived-servers</code>: the ids of the last 50 servers
              you walked into, so the first-visit card does not show twice.
            </li>
            <li>
              <code>pqp:call-rating-asked</code>: when we last asked you to rate
              a call, so the prompt does not nag every hang-up.
            </li>
            <li>
              <code>pqp:whats-new</code>: which What&apos;s New card you have
              already seen. <code>pqp:whats-new-feed</code>: the newest release
              note you have seen.
            </li>
            <li>
              <code>pqp:community-home-settings-seen</code>, and{" "}
              <code>pqp:community-home-row-seen:</code> followed by a server
              id: Baú badges you have already seen.
            </li>
            <li>
              Dismissed product cards and hints, so they stay closed:{" "}
              <code>pqp:download-hint-dismissed</code>,{" "}
              <code>pqp:mobile-beta-hint-2026-08</code>,{" "}
              <code>pqp:qg-hint-2026-08</code>,{" "}
              <code>pqp:cargos-hint-2026-08</code>,{" "}
              <code>pqp:cinema-hint-2026-09</code>,{" "}
              <code>pqp:music-pip-2026-09</code>,{" "}
              <code>pqp:voice-clean-settings-seen</code>,{" "}
              <code>pqp:obs-virtual-camera-hint-dismissed</code>,{" "}
              <code>pqp:linux-share-audio-hint-2026-09</code>, every key that starts
              with <code>pqp:feature-hint-</code>, and{" "}
              <code>pqp:voice-capacity-</code> followed by a voice channel id.
            </li>
          </ul>
          <p>
            <strong>Sign-up and links</strong>
          </p>
          <ul>
            <li>
              <code>pqp:acquisition</code>: if the link that brought you here
              carried campaign parameters (<code>utm_source</code>,{" "}
              <code>utm_medium</code>, <code>utm_campaign</code>,{" "}
              <code>gclid</code> or <code>ref</code>), those values and the page you landed on, and when they were saved, so we can tell which link a sign-up came
              from. If you arrived from a Google ad, <code>gclid</code> is the
              identifier Google gave that ad click. Nothing else in it
              identifies you. Our code never gives it to a third party. It expires after 30 days, and while
              it is live a later campaign link does not replace it. The first time the app loads
              after you sign in, it is sent to your account once and deleted
              from your device, and if the account was created in the last day, our server keeps
              those values on it. Otherwise they are discarded. If you never
              sign up it simply expires. A link with no campaign parameters
              still saves the page you landed on and, if your browser
              volunteers one, the name of the site that sent you (the host
              only, never the address of the page you were on), so a sign-up
              from a plain link is not a blank.
            </li>
            <li>
              <code>pqp:acquisition-done</code>: a marker that the value above
              has already been sent from this device, so it is not saved again
              on every visit. It holds no data.
            </li>
            <li>
              <code>pqp:signup-started</code>: the time you opened the sign-up
              window, so we can tell how long sign-up takes. Only the length
              of time, rounded to five seconds, is sent when your account is
              ready; the time itself is deleted from your device and never
              sent. It expires after 15 minutes.
            </li>
            <li>
              <code>pqp:ads-signup-reported</code>: the identifier of the
              account whose sign-up has already been counted by the Google Ads
              tag described above, so that reloading the app cannot count the
              same sign-up twice. It is written once, when you create an
              account, and never leaves your device. If you never sign up it is
              never written at all.
            </li>
            <li>
              <code>pqp:pending-handle-claim</code>,{" "}
              <code>pqp:pending-handle-add</code>,{" "}
              <code>pqp:pending-community-join</code>,{" "}
              <code>pqp:pending-create-community</code>,{" "}
              <code>pqp:pending-invite-ref</code>: a handle you meant to claim,
              a person you meant to add, or a community, server or invite you
              meant to join or create before signing in, so we can finish that
              after you create an account. Each expires after an hour and is
              cleared once that step is done.
            </li>
            <li>
              <code>pqp:pending-watch-party-waitlist</code>: that you opened the
              watch party waitlist link before signing in, so the waitlist form
              opens after you create an account. It expires after an hour and
              is cleared once the form has opened.
            </li>
          </ul>
          <p>
            <strong>Text you typed</strong>
          </p>
          <ul>
            <li>
              <code>pqp:composer-drafts:</code> followed by your account id:
              <strong> message drafts.</strong> Text you typed in a channel and
              did not send waits there when you come back, as in Discord or
              Slack. Text only, never attachments. It keeps up to 50 channels,
              drops a draft after 30 days, and removes a draft when you send it
              or empty the box.
            </li>
            <li>
              <code>pqp:outbox:</code> followed by your account id: messages on
              their way. A text message you send in a channel is saved here
              first, so it is not lost if the connection drops or the tab
              closes, and it is removed the moment our server answers. Files,
              polls and thread replies are not saved here. It normally holds nothing
              for more than a moment. A message that never got through is sent
              again when you reconnect, or dropped after 24 hours.
            </li>
          </ul>
          <p>
            <strong>Kept by other software on the page</strong>
          </p>
          <ul>
            <li>
              <code>emoji-mart.frequently</code>,{" "}
              <code>emoji-mart.last</code>: the emoji picker&apos;s recently
              used emoji.
            </li>
            <li>
              <code>_gcl_ls</code>: written by the Google Ads tag, for the same
              purpose as its <code>_gcl_</code> cookies under &quot;Cookies&quot;.
            </li>
            <li>Clerk keeps its own entries here too, for the session.</li>
          </ul>
          <p>
            Your theme and look, chat display, sounds, notification levels and
            main voice settings (mute-on-join, input mode, volumes) are also
            saved to your account on our server so they follow you to another
            device. Your language is saved to your account too, but only to
            pick the language of push notifications, and it does not follow you
            to another device. Push notifications exist in English and
            Portuguese, so Spanish is saved as English. See the{" "}
            <Link to="/privacy">Privacy Policy</Link>.
          </p>
          <p>
            <strong>Session storage</strong> (gone when you close the tab)
            holds:
          </p>
          <ul>
            <li>
              <code>pqp.connection.callback</code> and{" "}
              <code>pqp.connection.error</code>, for a Steam, Battle.net or
              Twitch connect hop that leaves pqp.gg and comes back. Each is
              deleted as soon as it is read.
            </li>
            <li>
              <code>pqp:desktop-login</code>, while you sign in to the desktop
              app through the browser. Cleared when that finishes.
            </li>
            <li>
              <code>pqp:onboarding-started-at-ms</code>,{" "}
              <code>pqp:onboarded-at-ms</code>,{" "}
              <code>pqp:arrival_first_message</code>,{" "}
              <code>pqp:arrival_first_voice</code>: timings and one-time flags
              for your first steps, so each is counted once.
            </li>
            <li>
              <code>pqp:confetti-spent</code>: your account id, so the welcome
              confetti plays once.
            </li>
            <li>
              <code>pqp:stale-chunk-reload-at</code>: the time the app last
              reloaded itself after we published a new version, so it reloads
              at most once every 30 seconds.
            </li>
            <li>
              <code>com.grafana.faro.session</code> and{" "}
              <code>com.grafana.faro.lastNavigationId</code>: a random session
              id and page id for error reporting, described under &quot;Third
              parties your browser contacts&quot;. Neither is your account id.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "offline-cache",
      heading: "Offline cache",
      body: (
        <p>
          pqp.gg installs a service worker so the app can start when you are
          offline or on a bad connection. It caches the app&apos;s own static
          files — JavaScript, CSS and HTML — in your browser&apos;s Cache
          Storage. <strong>It does not cache your messages.</strong>
        </p>
      ),
    },
    {
      id: "third-parties",
      heading: "Third parties your browser contacts",
      body: (
        <>
          <p>
            These are not cookies we set, but they are requests your browser
            makes to other companies, and each one reveals your IP address to
            them. We list them so the picture is complete:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> — sign-in, and profile pictures served from{" "}
              <code>img.clerk.com</code>.
            </li>
            <li>
              <strong>Google Fonts</strong> — the site&apos;s typefaces load
              from <code>fonts.googleapis.com</code> and{" "}
              <code>fonts.gstatic.com</code> on every page, including these
              legal pages.
            </li>
            <li>
              <strong>KLIPY, GIPHY and Tenor</strong> — when a GIF is shown in
              a channel or in the GIF picker, the image loads directly from
              their servers. New GIFs come from KLIPY; older messages may still
              load from GIPHY or Tenor.
            </li>
            <li>
              <strong>DiceBear</strong> — the preset avatar images shown in
              Settings.
            </li>
            <li>
              <strong>STUN and TURN servers</strong> — contacted when you join a
              voice channel, to negotiate the connection. Includes public STUN
              servers run by Google and Cloudflare.
            </li>
            <li>
              <strong>Our object storage provider</strong> — when file
              attachments are enabled, your browser uploads and downloads those
              files directly to storage.
            </li>
            <li>
              <strong>Google Ads</strong>: the tag described under
              &quot;Cookies&quot; loads from{" "}
              <code>www.googletagmanager.com</code> on every page of pqp.gg,
              and sends its page-view reports to Google servers on{" "}
              <code>doubleclick.net</code> and <code>google.com</code>.
            </li>
            <li>
              <strong>Cloudflare Web Analytics</strong>: Cloudflare adds its
              script, from <code>static.cloudflareinsights.com</code>, to every
              page as it leaves their network. It counts visits and measures
              page speed. The privacy notice describes what it records.
            </li>
            <li>
              <strong>Umami</strong>: its script loads from{" "}
              <code>cloud.umami.is</code> and sends visit counts to{" "}
              <code>gateway.umami.is</code>. The privacy notice describes what
              it records.
            </li>
            <li>
              <strong>Grafana Faro</strong>, run by Grafana Labs, reports errors
              in the web app to us so we can fix them. It sends reports to
              Grafana&apos;s collector in São Paulo (
              <code>faro-collector-prod-sa-east-1.grafana.net</code>). A report
              holds the page address, the error message and where in our code
              it happened, messages the app writes to the browser console at the
              info, warning and error levels, reports of anything the browser
              blocked under the site&apos;s security policy, the pages you move
              between inside the app, page speed measurements, the addresses
              and timings of requests the app makes, and your browser and
              operating system. It carries the
              random session id in session storage listed above. Our code
              never tells it who you are, but it reports the addresses of the
              requests the app makes in full, query string included, and some
              contain ids. The link the app uses to fetch a watch-party stream
              carries a token that contains your account id, so a report can
              identify your account. Grafana also receives the IP address of
              each report, as any server does, and may derive an approximate
              location from it. It does not record clicks, keystrokes or the
              screen.
            </li>
            <li>
              <strong>YouTube</strong>: when a music queue is playing in a voice
              call you are in, your browser loads YouTube&apos;s player script
              and the player from <code>www.youtube.com</code>, and track
              thumbnails from <code>i.ytimg.com</code>. This is YouTube&apos;s
              standard player, not its privacy-enhanced one, and Google can set
              its own cookies on its own domains when it loads.
            </li>
            <li>
              <strong>YouTube, Twitch, TikTok and Instagram embeds in Baú</strong>:
              when a Baú post carries one of these videos, your browser loads
              the player as the post scrolls into view, from{" "}
              <code>www.youtube-nocookie.com</code> (YouTube&apos;s
              privacy-enhanced address), <code>player.twitch.tv</code> or{" "}
              <code>clips.twitch.tv</code>, <code>www.tiktok.com</code> or{" "}
              <code>www.instagram.com</code>. Each of them can set its own
              cookies on its own domain, under its own terms. A locked post
              shows only a YouTube thumbnail, loaded from{" "}
              <code>i.ytimg.com</code>.
            </li>
            <li>
              <strong>Steam, Battle.net and Twitch</strong> — only if you click
              Connect. Your browser leaves pqp.gg, signs in with that provider,
              and comes back. We do not keep their access tokens.
            </li>
            <li>
              <strong>The Android APK download button</strong> on pqp.gg posts a
              one-byte click count to our operator dashboard. No account travels
              with it. The dashboard rate-limits by IP for a minute.
            </li>
          </ul>
          <p>
            Link-preview images are the exception: we proxy those through our
            own server on purpose, so opening a channel does not tell the linked
            website that you looked at it.
          </p>
        </>
      ),
    },
    {
      id: "not-used",
      heading: "What we do not use",
      body: (
        <>
          <p>
            No session replay: nothing on pqp.gg records how you use the site
            or what you type. (A watch party is recorded as a broadcast; the{" "}
            <Link to="/privacy">Privacy Policy</Link> explains it.) No device
            fingerprinting by our code. Desktop notifications are raised
            locally by your own browser. Push notifications, when you turn them
            on, go through Apple for an iPhone, Google&apos;s Firebase Cloud
            Messaging for the Android app, and the browser&apos;s own push
            service for the web. None of them is a third-party analytics SDK,
            and no notification carries the text of a message. The Google tag
            under &quot;Cookies&quot; above is the one piece of advertising
            machinery here.
          </p>
          <p>
            <strong>Cloudflare Web Analytics</strong>, <strong>Umami</strong>{" "}
            and <strong>Grafana Faro</strong> set no cookie. Cloudflare Web
            Analytics and Umami also store nothing on your device and use no
            persistent identifier, so they cannot recognise you across visits
            or across sites. Grafana Faro keeps only the random session id in
            session storage listed above, which is gone when you close the tab.
            That is why the statement under &quot;Cookies&quot;, that our
            analytics and error reporting set no cookies, is true.
          </p>
        </>
      ),
    },
    {
      id: "managing",
      heading: "Managing this",
      body: (
        <>
          <p>
            You can clear cookies, local storage and cached data for pqp.gg in
            your browser settings, and block third-party requests with a
            browser extension if you prefer. Blocking Clerk&apos;s cookies will
            prevent sign-in. Blocking Google&apos;s costs you nothing and costs
            us one uncounted sign-up. You can also switch off ad
            personalisation in your Google account&apos;s ad settings, at{" "}
            <code>adssettings.google.com</code>. Clearing local storage resets your theme,
            language and notification preferences on that device but does not
            touch your account.
          </p>
          <p>
            <strong>Signing out does not clear local storage.</strong> Drafts
            and unsent messages stay on the device under your account id, so
            they are there when you sign back in and the next person to sign in
            on the same browser does not see them. Settings belong to the
            browser, not the account, so the next person gets yours. If you
            share a device and want all of it gone, clear the site data for
            pqp.gg in your browser settings.
          </p>
        </>
      ),
    },
    {
      id: "more",
      heading: "More",
      body: (
        <p>
          See the <Link to="/privacy">Privacy Policy</Link> for how we handle
          personal data, and the <Link to="/terms">Terms of Service</Link> for
          use of the hosted product.
        </p>
      ),
    },
    {
      id: "contact",
      heading: "Contact",
      body: (
        <p>
          Questions about anything on this page go to{" "}
          <strong>contato@pqp.gg</strong> — the single address for pqp.gg, read
          by the one person who runs it.
        </p>
      ),
    },
  ],
};
