import { applyTheme, connect, PqpAppError, type Participant, type PqpApp } from "@pqp/app-sdk";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const count = $("count");
const plus = $<HTMLButtonElement>("plus");
const ping = $<HTMLButtonElement>("ping");
const flash = $("flash");
const people = $("people");

function setButtons(on: boolean) {
  plus.disabled = !on;
  ping.disabled = !on;
}

/** The state is whatever JSON the app wrote. Read it defensively: it is shared, so anybody may have written it. */
function readCount(value: unknown): number {
  return typeof value === "object" && value !== null && "count" in value && typeof value.count === "number"
    ? value.count
    : 0;
}

async function main() {
  let app: PqpApp;
  try {
    app = await connect(); // the handshake; rejects when this page is not inside pqp
  } catch {
    status.textContent = "Open Tiny Eco inside pqp.";
    return;
  }

  // pqp's colors, as CSS custom properties, now and whenever the person changes theme
  applyTheme(app.hello.theme);
  app.on("theme", (theme) => applyTheme(theme));

  // 1. Register every listener first. A push that arrives before its listener exists is not replayed.
  let rev = -1;
  let roster: Participant[] = [];
  app.state.on((next) => {
    if (next.rev < rev) return;
    rev = next.rev;
    count.textContent = String(readCount(next.value));
  });
  app.participants.on(renderPeople);
  app.events.on("ping", ({ fromSeatId }) => showPing(fromSeatId));
  app.on("connection", (connection) => {
    status.textContent = connection === "online" ? "Connected" : "Reconnecting...";
    setButtons(connection === "online");
  });
  app.on("ended", () => {
    status.textContent = "The session ended.";
    setButtons(false);
  });

  // 2. Then read what was there before the listeners existed.
  renderPeople(await app.participants.get());
  const first = await app.state.get();
  rev = Math.max(rev, first.rev);
  count.textContent = String(readCount(first.value));
  status.textContent = app.connection === "online" ? "Connected" : "Reconnecting...";
  setButtons(app.connection === "online");

  function renderPeople(next: Participant[]) {
    roster = next;
    people.replaceChildren(
      ...roster.map((person) => {
        const item = document.createElement("li");
        const tags = [person.seatId === app.hello.self.seatId ? "you" : "", person.isHost ? "host" : ""];
        item.textContent = [person.displayName, ...tags.filter(Boolean)].join(" · ");
        return item;
      }),
    );
  }

  function showPing(fromSeatId: string) {
    const name = roster.find((person) => person.seatId === fromSeatId)?.displayName ?? "Somebody";
    flash.textContent = `${name} sent a ping`;
    setTimeout(() => (flash.textContent = ""), 1800);
  }

  // +1 is read, add, write, so two people clicking at once could overwrite each other. `baseRev` makes the
  // write conditional on the revision we read; `stale-rev` means somebody was faster, so read again.
  plus.addEventListener("click", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { rev: seen, value } = await app.state.get();
      try {
        await app.state.patch({ count: readCount(value) + 1 }, { baseRev: seen });
        return;
      } catch (error) {
        if (!(error instanceof PqpAppError) || error.code !== "stale-rev") {
          status.textContent = "That did not work. Try again.";
          return;
        }
      }
    }
  });

  ping.addEventListener("click", async () => {
    try {
      await app.events.send("ping", {});
      showPing(app.hello.self.seatId); // events are not echoed back to the sender
    } catch {
      status.textContent = "Slow down.";
    }
  });
}

void main();
