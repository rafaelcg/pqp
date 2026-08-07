import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function CookiesPage() {
  return (
    <LegalPage
      title="Cookie Notice — pqp"
      description="Exactly which cookies, local storage keys and caches pqp.gg puts on your device, and which third parties your browser contacts."
      path="/cookies"
      heading="Cookie notice"
      updated="7 August 2026"
    >
      <p>
        This notice lists everything <strong>pqp.gg</strong> stores on your
        device and every third party your browser contacts while you use it. It
        is a complete list, not a category summary. Self-hosted instances may
        differ depending on how they are configured.
      </p>

      <h2>Cookies</h2>
      <p>
        <strong>The pqp app itself sets no cookies.</strong> The only cookies on
        pqp.gg come from{" "}
        <a href="https://clerk.com" target="_blank" rel="noreferrer">
          Clerk
        </a>
        , the service that signs you in. Clerk uses session cookies (and its own
        browser storage) to keep you logged in and to protect against session
        hijacking. These are <strong>strictly necessary</strong>: block them and
        you cannot sign in at all. Clerk documents the individual cookie names
        and lifetimes on its own site.
      </p>
      <p>
        We set no advertising cookies, no analytics cookies, and no cross-site
        tracking cookies of any kind — not on the app and not on the marketing
        pages.
      </p>

      <h2>Local storage</h2>
      <p>
        These are stored by your browser under the pqp.gg origin. They stay on
        your device, are never used for advertising, and are readable only by
        pqp.gg.
      </p>
      <ul>
        <li>
          <code>pqp-theme</code> — light, dark, or follow-the-system.
        </li>
        <li>
          <code>pqp:locale</code> — your chosen language (English or
          Portuguese), when you have set one.
        </li>
        <li>
          <code>pqp-local-settings</code> — mute-on-join, compact peer list,
          which microphone and speaker you picked, input and output volume, and
          whether link previews are shown.
        </li>
        <li>
          <code>pqp-notifications</code> — whether you allowed desktop
          notifications, and your per-server and per-channel notification levels.
        </li>
        <li>
          <code>pqp:collapsed-categories</code> — which channel categories you
          have collapsed in the sidebar.
        </li>
      </ul>
      <p>
        Most of these settings are also saved to your account on our server so
        they follow you to another device — see the{" "}
        <Link to="/privacy">Privacy Policy</Link>. Clerk keeps its own entries
        here too, for the session.
      </p>
      <p>
        <strong>Message drafts are not stored.</strong> Anything half-typed in
        the message box lives in the page&apos;s memory and is gone when you
        close the tab.
      </p>

      <h2>Offline cache</h2>
      <p>
        pqp.gg installs a service worker so the app can start when you are
        offline or on a bad connection. It caches the app&apos;s own static files
        — JavaScript, CSS, HTML and fonts — in your browser&apos;s Cache Storage.{" "}
        <strong>It does not cache your messages.</strong>
      </p>

      <h2>Third parties your browser contacts</h2>
      <p>
        These are not cookies we set, but they are requests your browser makes to
        other companies, and each one reveals your IP address to them. We list
        them so the picture is complete:
      </p>
      <ul>
        <li>
          <strong>Clerk</strong> — sign-in, and profile pictures served from{" "}
          <code>img.clerk.com</code>.
        </li>
        <li>
          <strong>Google Fonts</strong> — the site&apos;s typefaces load from{" "}
          <code>fonts.googleapis.com</code> and <code>fonts.gstatic.com</code> on
          every page, including these legal pages.
        </li>
        <li>
          <strong>GIPHY and Tenor</strong> — when a GIF is shown in a channel or
          in the GIF picker, the image loads directly from their servers.
        </li>
        <li>
          <strong>DiceBear</strong> — the preset avatar images shown in Settings.
        </li>
        <li>
          <strong>STUN and TURN servers</strong> — contacted when you join a
          voice channel, to negotiate the connection. Includes public STUN
          servers run by Google and Cloudflare.
        </li>
        <li>
          <strong>Our object storage provider</strong> — when file attachments
          are enabled, your browser uploads and downloads those files directly to
          storage.
        </li>
      </ul>
      <p>
        Link-preview images are the exception: we proxy those through our own
        server on purpose, so opening a channel does not tell the linked website
        that you looked at it.
      </p>

      <h2>What we do not use</h2>
      <p>
        No analytics or product-analytics tool, no advertising or retargeting
        pixel, no session recording, no error-reporting SDK, no device
        fingerprinting, and no push-notification service. Desktop notifications
        are raised locally by your own browser and are not routed through anyone
        else. If we ever add analytics, we will update this notice and ask for
        consent where consent is required.
      </p>

      <h2>Managing this</h2>
      <p>
        You can clear cookies, local storage and cached data for pqp.gg in your
        browser settings, and block third-party requests with a browser extension
        if you prefer. Blocking Clerk&apos;s cookies will prevent sign-in.
        Clearing local storage resets your theme, language and notification
        preferences on that device but does not touch your account.
      </p>

      <h2>More</h2>
      <p>
        See the <Link to="/privacy">Privacy Policy</Link> for how we handle
        personal data, and the <Link to="/terms">Terms of Service</Link> for use
        of the hosted product.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about anything on this page go to{" "}
        <strong>contato@pqp.gg</strong> — the single address for pqp.gg,
        read by the one person who runs it.
      </p>
    </LegalPage>
  );
}
