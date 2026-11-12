/**
 * A room to try public jams by hand, as the Playwright spec leaves it, with
 * every state a screen has to draw: a published channel song, one answered and
 * one still waiting for an answer, an outside take in the inbox, a standalone
 * public jam, and a second server's public song for the "Públicas" shelf.
 *
 *   E2E_API_URL=http://localhost:3101 pnpm exec tsx e2e/jam-public-qa-seed.ts <tag>
 *
 * Prints the accounts (`pqp:dev-user-suffix` values) and the addresses. The API
 * needs `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS=0` and the flag `jam_public` on.
 */
import { addTrack, call, materialise, seedJamShare } from "./jam-share-seed";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const TOKEN = process.env.E2E_ADMIN_TOKEN ?? "e2e-admin-token-0123456789abcdef";
const tag = process.argv[2] ?? Date.now().toString(36).slice(-5);

async function main() {
  const seed = await seedJamShare(API, TOKEN, tag);
  const flip = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ key: "jam_public", enabled: true }),
  });
  if (!flip.ok) throw new Error(`flag -> ${flip.status}`);
  // "In Bloom" is public with three parts; the member has not answered for "Meu Riff" yet.
  await call(API, seed.host, "PUT", `/api/jam-songs/${seed.bloom}/public`, {});
  await call(API, seed.member, "PUT", `/api/jam-songs/${seed.bloom}/public-consent`, { choice: "yes" });
  await call(API, seed.host, "PUT", `/api/jam-songs/${seed.riff}/public`, {});
  // A standalone jam by a third account.
  const maker = `jsmaker${tag}`;
  await materialise(API, maker);
  const made = await call<{ song: { id: string } }>(API, maker, "POST", "/api/jam-public/songs", {
    title: "Jam sem casa",
    joinMode: "wanted",
    wantedInstruments: ["bass", "drums"],
  });
  await addTrack(API, maker, made.song.id, "guitar", false, 180, { publicConsent: "yes" });
  // An outside take on "In Bloom": it waits in the host's inbox.
  const guest = `jsguest${tag}`;
  await materialise(API, guest);
  await addTrack(API, guest, seed.bloom, "keys", false, 261, { publicConsent: "yes" });
  // eslint-disable-next-line no-console -- a script: the printout is the product
  console.log(JSON.stringify({ ...seed, maker, guest, standalone: made.song.id }, null, 2));
}

void main();
