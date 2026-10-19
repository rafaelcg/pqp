/**
 * A cooperative app: the real SDK, in the real sandbox. It writes what it
 * learns into the DOM so a spec can read it through the frame.
 */
import { connect } from "@pqp/app-sdk";

const say = (id: string, text: string) => {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
};

async function main() {
  const app = await connect();
  say("hello", `${app.hello.app.id}@${app.hello.app.version} ${app.hello.locale} ${app.hello.self.seatId}`);
  const people = await app.participants.get();
  say("people", people.map((p) => p.displayName).join(","));
  app.state.on((s) => say("state", `rev:${s.rev}:${JSON.stringify(s.value)}`));
  app.on("ended", (reason) => say("ended", reason));

  document.getElementById("patch")!.addEventListener("click", async () => {
    try {
      say("patched", `rev:${(await app.state.patch({ n: 1 })).rev}`);
    } catch (error) {
      say("patched", `err:${(error as { code?: string }).code}`);
    }
  });
  document.getElementById("ping")!.addEventListener("click", async () => {
    await app.events.send("ping", { a: 1 });
    say("pinged", "ok");
  });
  document.getElementById("pick")!.addEventListener("click", async () => {
    try {
      const picked = await app.files.pickLocal();
      say("picked", picked ? `ext=${picked.ext},len=${picked.bytes.byteLength},keys=${Object.keys(picked).sort().join("+")}` : "cancelled");
    } catch (error) {
      say("picked", `err:${(error as { code?: string }).code}`);
    }
  });
}

main().catch((error) => say("hello", `failed:${String(error)}`));
