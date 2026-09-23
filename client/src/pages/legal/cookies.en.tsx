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
  updated: "23 September 2026",
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
            , the service that signs you in. Clerk uses session cookies (and its
            own browser storage) to keep you logged in and to protect against
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
            addresses Google Ads uses to build remarketing audiences, so Google
            Ads can add your visit to an audience list for our ad account. When
            an account is created, the tag sends one more event: that a sign-up
            happened. That event carries no name, no email, no user id and
            nothing you typed. Our code gives the tag no account data at all.
          </p>
          <p>
            Those are all the cookies on pqp.gg. Our analytics and error
            reporting set none (see &quot;Third parties your browser
            contacts&quot;). When the tag contacts Google&apos;s servers, Google
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
              <code>pqp:locale</code>: your chosen language (English or
              Portuguese), when you have set one.
            </li>
          </ul>
          <p>
            <strong>Voice, video and sound</strong>
          </p>
          <ul>
            <li>
              <code>pqp-local-settings</code>: mute-on-join, compact participant
              list, voice activation or push-to-talk and its key, input and
              output volume, whether link previews are shown, and your other
              voice and video preferences. It also holds which microphone,
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
              <code>pqp:community-home-viewer</code>: for server staff, which
              member view of Baú you are previewing.
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
              <code>pqp:whats-new</code>, <code>pqp:whats-new-feed</code>: the
              newest release note you have seen.
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
              <code>pqp:voice-clean-settings-seen</code>, every key that starts
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
              <code>gclid</code> or <code>ref</code>), those values and the
              page you landed on, so we can tell which link a sign-up came
              from. It holds no identifier of any kind, our code never gives it
              to a third party, it expires after 30 days, it is written only once (a
              later campaign link does not replace it), and is deleted from
              your device the first time the app loads after you sign in,
              when it is sent to your account once. If you never sign up it
              simply expires.
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
              cleared once used.
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
            Your theme and look, language, chat display, sounds, notification
            levels and main voice settings (mute-on-join, input mode, volumes)
            are also saved to your account on our server so they follow you to
            another device. See the{" "}
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
          files — JavaScript, CSS, HTML and fonts — in your browser&apos;s Cache
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
              it happened, errors the app writes to the browser console, page
              speed measurements, the addresses and timings of requests the app
              makes, and your browser and operating system. It carries the
              random session id in session storage listed above. Our code
              never tells it who you are, but some request addresses contain
              ids, and the link for watching a watch-party stream contains your
              account id. It does not record clicks, keystrokes or the screen.
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
            No session replay: nothing on pqp.gg records your screen or what
            you type. No device fingerprinting by our code.
            Desktop notifications are raised locally by your own browser.
            Phone and web push exist when the hosted API is configured with
            VAPID or APNs; those go through Apple or the browser&apos;s push
            service, not through a third-party analytics SDK. The Google tag
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
            us one uncounted sign-up. Clearing local storage resets your theme,
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
