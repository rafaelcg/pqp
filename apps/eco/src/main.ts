import type { JsonValue } from "@pqp/shared";
import { applyTheme, connect, PqpAppError, type Participant, type PqpApp } from "@pqp/app-sdk";
import { formatPing, pickLocale, STRINGS, type Strings } from "./i18n";
import { incrementPatch, initialOf, readCount } from "./model";

const FLASH_MS = 1800;
const PING_COOLDOWN_MS = 250;
const STALE_RETRIES = 3;
const CONNECT_ATTEMPTS = 4;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const root = el<HTMLElement>("eco");
const statusLine = el<HTMLElement>("status");
const countOut = el<HTMLOutputElement>("count");
const plusButton = el<HTMLButtonElement>("plus");
const pingButton = el<HTMLButtonElement>("ping");
const flash = el<HTMLElement>("flash");
const people = el<HTMLUListElement>("people");
const ended = el<HTMLElement>("ended");

function label(id: string, text: string) {
  el(id).textContent = text;
}

function setUi(state: "connecting" | "online" | "reconnecting" | "ended" | "outside") {
  root.dataset.state = state;
  const interactive = state === "online";
  plusButton.disabled = !interactive;
  pingButton.disabled = !interactive;
}

async function main() {
  const locale = pickLocale(navigator.language || "en");
  let t: Strings = STRINGS[locale];
  document.documentElement.lang = locale;
  label("counter-label", t.counter);
  label("ping-label", t.pingSection);
  pingButton.textContent = t.ping;
  label("people-label", t.people);
  statusLine.textContent = t.connecting;
  setUi("connecting");

  // Not inside a frame at all is final; a host that is slow or briefly unreachable is tried again
  let app: PqpApp | null = null;
  if (window.parent !== window) {
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !app; attempt += 1) {
      try {
        app = await connect();
      } catch {
        if (attempt + 1 < CONNECT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }
  if (!app) {
    statusLine.textContent = "";
    ended.textContent = window.parent === window ? t.outside : t.connectFailed;
    ended.hidden = false;
    setUi("outside");
    return;
  }

  // the host's locale wins over the browser's: it is the one the person picked in pqp
  const hostLocale = pickLocale(app.hello.locale);
  t = STRINGS[hostLocale];
  document.documentElement.lang = hostLocale;
  label("counter-label", t.counter);
  label("ping-label", t.pingSection);
  pingButton.textContent = t.ping;
  label("people-label", t.people);

  if (app.hello.reducedMotion) document.documentElement.dataset.reducedMotion = "true";
  applyTheme(app.hello.theme);
  app.on("theme", (theme) => applyTheme(theme));

  const selfSeat = app.hello.self.seatId;
  let roster: Participant[] = [];
  let rev = 0;
  let count = 0;

  const showConnection = (status: "online" | "reconnecting") => {
    // an ended session stays ended: a connection event that arrives after it must not enable the buttons
    if (root.dataset.state === "ended") return;
    statusLine.textContent = status === "online" ? t.online : t.reconnecting;
    setUi(status);
  };
  showConnection(app.connection);
  app.on("connection", showConnection);

  const nameOf = (seatId: string) => roster.find((p) => p.seatId === seatId)?.displayName ?? "?";

  function renderPeople() {
    people.replaceChildren(
      ...roster.map((person) => {
        const item = document.createElement("li");
        item.className = "eco-person";
        if (person.connection === "reconnecting") item.dataset.reconnecting = "true";

        const avatar = document.createElement("span");
        avatar.className = "eco-avatar";
        avatar.setAttribute("aria-hidden", "true");
        if (person.avatar) {
          const img = document.createElement("img");
          img.alt = "";
          img.width = 32;
          img.height = 32;
          img.src = person.avatar;
          avatar.append(img);
        } else {
          avatar.textContent = initialOf(person.displayName);
        }

        const name = document.createElement("span");
        name.className = "eco-name";
        name.textContent = person.displayName;

        const tags = document.createElement("span");
        tags.className = "eco-tags";
        const words: string[] = [];
        if (person.seatId === selfSeat) words.push(t.you);
        if (person.isHost) words.push(t.host);
        if (person.role === "spectator") words.push(t.spectator);
        if (person.connection === "reconnecting") words.push(t.reconnecting);
        tags.textContent = words.join(" · ");

        item.append(avatar, name, tags);
        return item;
      }),
    );
  }

  function setRoster(next: Participant[]) {
    roster = next;
    renderPeople();
  }

  function applyState(next: { rev: number; value: JsonValue }) {
    if (next.rev < rev) return;
    rev = next.rev;
    count = readCount(next.value);
    countOut.value = String(count);
    countOut.textContent = String(count);
  }

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function showPing(name: string) {
    clearTimeout(flashTimer);
    flash.textContent = formatPing(t.pingFrom, name);
    // restart the animation when pings arrive back to back
    flash.classList.remove("is-on");
    void flash.offsetWidth;
    flash.classList.add("is-on");
    flashTimer = setTimeout(() => {
      flash.classList.remove("is-on");
      flash.textContent = "";
    }, FLASH_MS);
  }

  // listeners first, then the values from before the listeners existed
  app.participants.on(setRoster);
  app.state.on(applyState);
  app.events.on("ping", ({ fromSeatId }) => {
    // our own ping already flashed locally; the host may or may not echo it back
    if (fromSeatId === selfSeat) return;
    showPing(nameOf(fromSeatId));
  });
  app.on("ended", () => {
    setUi("ended");
    statusLine.textContent = "";
    ended.textContent = t.ended;
    ended.hidden = false;
  });
  // the handlers below are installed whatever these reads do: a host that is slow to answer
  // must not leave the buttons dead, and a later push still brings the values in
  try {
    setRoster(await app.participants.get());
    applyState(await app.state.get());
  } catch {
    statusLine.textContent = t.failed;
  }

  let busy = false;
  plusButton.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    try {
      // a merge patch is not an atomic increment, so write against the revision we read
      for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
        try {
          const next = count + 1;
          const written = await app.state.patch(incrementPatch(count), { baseRev: rev });
          // the host may have pushed this very write's state before the call resolved; then the
          // authoritative value is already shown, and adding one again would put it a step ahead
          if (rev < written.rev) {
            rev = written.rev;
            count = next;
            countOut.value = String(count);
            countOut.textContent = String(count);
          }
          return;
        } catch (error) {
          if (error instanceof PqpAppError && error.code === "stale-rev" && attempt < STALE_RETRIES) {
            applyState(await app.state.get());
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (!(error instanceof PqpAppError) || (error.code !== "rate-limited" && error.code !== "ended")) {
        statusLine.textContent = t.failed;
      }
    } finally {
      busy = false;
    }
  });

  let cooling = false;
  pingButton.addEventListener("click", async () => {
    if (cooling) return;
    cooling = true;
    setTimeout(() => {
      cooling = false;
    }, PING_COOLDOWN_MS);
    try {
      await app.events.send("ping", {});
      // shown once the host took it, so a refused ping is never shown as sent
      showPing(nameOf(selfSeat));
    } catch (error) {
      statusLine.textContent = error instanceof PqpAppError && error.code === "rate-limited" ? t.slowDown : t.failed;
    }
  });
}

void main();
