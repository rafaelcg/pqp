// Load test for GET /api/music/resolve against the local API (real YouTube/Spotify upstream).
// Each request uses a distinct dev identity so the per-user limiter never fires;
// what we measure is upstream behaviour plus the aggregate limiter.
const API = process.env.API ?? "http://localhost:3001";
const artists = ["tim maia","legião urbana","caetano veloso","gilberto gil","chico buarque","elis regina","jorge ben jor","marisa monte","cazuza","raul seixas","djavan","milton nascimento","skank","los hermanos","o rappa","charlie brown jr","racionais mcs","emicida","anitta","ludmilla","matuê","teto","veigh","kayblack","mc hariel","henrique e juliano","marília mendonça","jorge e mateus","gusttavo lima","zé neto e cristiano","alceu valença","nando reis","cássia eller","titãs","paralamas do sucesso","engenheiros do hawaii","capital inicial","pitty","cpm 22","natiruts","armandinho","seu jorge","criolo","bk","froid","sabotage","mano brown","projota","luan santana","wesley safadão"];
const songs = ["ao vivo","acústico","clipe oficial","2024","letra","remix","versão","live","especial","completo"];
const queries = [];
for (const a of artists) for (const s of songs) queries.push(`${a} ${s}`);

// A pool of age-checked identities, round-robin, so the per-user limiter
// (20 burst, 0.5/s) never decides the result; the aggregate music limiter
// (120 burst, 2/s) and the upstream do.
const POOL = Number(process.env.POOL ?? 40);
const users = Array.from({ length: POOL }, (_, i) => `dev-local-token:load${i + 1}`);
for (const token of users) {
  await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  await fetch(`${API}/api/me/age-check`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  await new Promise(r => setTimeout(r, 40));
}
console.log(`pool of ${POOL} age-checked users ready`);
let userSeq = 0;
function headers() { userSeq += 1; return { Authorization: `Bearer ${users[userSeq % users.length]}` }; }

async function one(q) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${API}/api/music/resolve?q=${encodeURIComponent(q)}`, { headers: headers() });
    const ms = performance.now() - t0;
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ms, status: res.status, tracks: body?.tracks?.length ?? 0, error: body?.error ?? null };
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, tracks: 0, error: String(e) };
  }
}

async function pool(items, concurrency, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); }
function report(name, results, wall) {
  const ok = results.filter(r => r.status === 200);
  const lat = ok.map(r => r.ms);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const errors = {};
  for (const r of results) if (r.status !== 200) errors[r.error ?? r.status] = (errors[r.error ?? r.status] ?? 0) + 1;
  console.log(`\n== ${name}: ${results.length} req in ${(wall / 1000).toFixed(1)}s (${(results.length / (wall / 1000)).toFixed(1)} req/s)`);
  console.log(`   status: ${JSON.stringify(byStatus)}`);
  if (lat.length) console.log(`   ok latency ms: p50=${pct(lat, 0.5)} p95=${pct(lat, 0.95)} p99=${pct(lat, 0.99)} max=${Math.round(Math.max(...lat))}`);
  if (Object.keys(errors).length) console.log(`   errors: ${JSON.stringify(errors)}`);
  return { ok: ok.length, total: results.length };
}

async function scenario(name, items, concurrency, fn = one) {
  const t0 = performance.now();
  const results = await pool(items, concurrency, fn);
  return report(name, results, performance.now() - t0);
}

const which = process.argv[2] ?? "all";

if (which === "all" || which === "cold") {
  await scenario("cold unique searches, concurrency 10", queries.slice(0, 100), 10);
}
if (which === "all" || which === "cached") {
  await scenario("same 100 again (cache)", queries.slice(0, 100), 10);
}
if (which === "all" || which === "burst") {
  await scenario("burst: 60 unique searches, concurrency 20", queries.slice(100, 160), 20);
}
if (which === "all" || which === "playlist") {
  const lists = ["PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI","PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i","PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG","PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj","PL4o29bINVT4EG_y-k5jGoOu3-Am8Nvi10","PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI","PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i","PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG","PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj","PL4o29bINVT4EG_y-k5jGoOu3-Am8Nvi10"].map(id => `https://www.youtube.com/playlist?list=${id}`);
  await scenario("10 playlists, concurrency 10", lists, 10);
}
if (which === "all" || which === "spotify") {
  const sp = ["37i9dQZF1DX0FOF1IUWK1W","37i9dQZF1DXcBWIGoYBM5M","37i9dQZF1DX10zKzsJ2jva","37i9dQZF1DWTJ7xPn4vNaz","37i9dQZF1DX4dyzvuaRJ0n"].map(id => `https://open.spotify.com/playlist/${id}`);
  await scenario("5 Spotify playlists (25 tracks each), concurrency 5", sp, 5);
}
if (which === "all" || which === "sustained") {
  // 1.5 req/s for 3 minutes, unique queries, to see whether YouTube starts refusing.
  const t0 = performance.now(); const results = [];
  const subset = queries.slice(160, 160 + 270);
  for (let i = 0; i < subset.length; i++) {
    const at = t0 + i * (1000 / 1.5);
    const wait = at - performance.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    results.push(one(subset[i]));
    if (i % 45 === 44) { const done = await Promise.all(results.slice(-45)); const bad = done.filter(r => r.status !== 200).length; console.log(`   minute ${Math.round((i + 1) / 90 * 1)}: ${done.length} sent, ${bad} failed, p95=${pct(done.filter(r=>r.status===200).map(r=>r.ms),0.95)}ms`); }
  }
  report("sustained 1.5 req/s for 3 min", await Promise.all(results), performance.now() - t0);
}
