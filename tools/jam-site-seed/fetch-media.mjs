#!/usr/bin/env node
/**
 * Downloads the public-domain / CC0 media that `seed.mjs --media <dir>` uses in
 * place of its synthetic tones, gradients and monograms, so the public jam site
 * can be judged on something that looks like the real thing.
 *
 *   node tools/jam-site-seed/fetch-media.mjs --out /tmp/jam-media [--format webm|mp4]
 *
 * Only Wikimedia Commons, only files whose own licence line says public domain
 * or CC0. The script asks the Commons API for each file's licence and author at
 * download time and REFUSES any file that is neither, so the manifest below
 * cannot drift into "free to use" territory unnoticed. It writes
 * `<out>/media.json` (what the seed reads) and prints the table that
 * `ATTRIBUTION.md` carries (`--write-attribution` rewrites that file).
 *
 * Nothing it downloads belongs in git: the output directory is yours, and
 * `tools/jam-site-seed/.media/` is gitignored for the default.
 *
 * Needs ffmpeg and ffprobe. No account, no key, no paid service.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, value, index, all) => {
    if (value.startsWith("--")) acc.push([value.slice(2), all[index + 1]?.startsWith("--") ? "true" : (all[index + 1] ?? "true")]);
    return acc;
  }, []),
);
const OUT = args.out ?? join(here, ".media");
const FORMAT = args.format === "mp4" ? "mp4" : "webm";
const SECONDS = 20;
const UA = "pqp-jam-seed/1.0 (open-source test fixtures; public-domain media only)";
const API = "https://commons.wikimedia.org/w/api.php";

// ---------------------------------------------------------------- manifest

/** Album-art-like covers: paintings, prints, posters and vintage photographs. */
const COVERS = [
  "The Great Wave off Kanagawa.jpg",
  "Vincent van Gogh - Starry Night - Google Art Project.jpg",
  "Mucha-job.jpg",
  "Grand Canyon poster 1938.jpg",
  "Hiroshige, Heavy rain on a pine tree.jpg",
  "Girl with a Pearl Earring.jpg",
  "The Kiss - Gustav Klimt - Google Cultural Institute.jpg",
  "Edvard Munch - The Scream - Google Art Project.jpg",
  "(Albi) Moulin-rouge. La Goulue et Valentin le desossé - Toulouse-Lautrec 1891 - Inv.138.jpg",
  "The national parks preserve wild life, WPA poster, ca. 1938.jpg",
  "Billie Holiday, Downbeat, New York, N.Y., ca. Feb. 1947 (William P. Gottlieb 04251).jpg",
  "Claude Monet - Seerosen.jpg",
  "(Portrait of Dizzy Gillespie, John Lewis, Cecil Payne, Miles Davis, and Ray Brown, Downbeat, New York, N.Y., between 1946 and 1948) (LOC) (4843129109).jpg",
];

/** Historical photographs (Library of Congress, William P. Gottlieb) used as avatars. */
const PORTRAITS = [
  "(Portrait of Count Basie, Aquarium, New York, N.Y., between 1946 and 1948) (LOC) (4843735328).jpg",
  "(Portrait of Lionel Hampton, Aquarium, New York, N.Y., ca. June 1946) (LOC) (4843131247).jpg",
  "(Portrait of Doris Day, Aquarium, New York, N.Y., ca. July 1946) (LOC) (5268907067).jpg",
  "(Portrait of Django Reinhardt, Aquarium, New York, N.Y., ca. Nov. 1946) (LOC) (4843142229).jpg",
  "(Portrait of Oscar Pettiford, Aquarium, New York, N.Y., ca. Nov. 1946) (LOC) (4843755904).jpg",
  "(Portrait of Mildred Bailey, Aquarium, New York, N.Y., ca. Aug. 1946) (LOC) (4888657750).jpg",
  "(Portrait of Art Tatum, Rochester, N.Y.(?), ca. May 1946) (LOC) (5148796890).jpg",
  "(Portrait of Chubby Jackson, Downbeat, New York, N.Y., ca. Nov. 1946) (LOC) (5354783618).jpg",
];

/** `role` is the jam instrument the clip is used for; `start` is where in the source the 20 s begin. */
const CLIPS = [
  { id: "drums-street", role: "drums", title: "Street drummer in Portland, Oregon.webm", start: 6 },
  { id: "drums-russell", role: "drums", title: "Andy Russell Drum Solo from The Stork Club 1945.ogv", start: 25 },
  { id: "bass-spalding", role: "bass", title: "Esperanza Spalding Performs at the White House Poetry Jam- (5 of 8).webm", start: 45 },
  { id: "guitar-ticotico", role: "guitar", title: "티코티코(우쿨렐레,카혼,기타)-Tico Tico(ukulele,cajon,guitar).webm", start: 6 },
  { id: "guitar-isbin", role: "guitar", title: "20091104 Sharon Isbin - Isaac Albéniz's Asturias.ogv", start: 40 },
  { id: "guitar-requinto", role: "guitar", title: "Octavio Vega clase de requinto.webm", start: 0 },
  { id: "guitar-bernal", role: "guitar", title: "Los hermanos Bernal tocando el Palomo, Un son jarocho.webm", start: 8 },
  { id: "guitar-ukulele", role: "guitar", title: "Ukulele jam session at Table Rocks (42261446172).webm", start: 6 },
  { id: "vocals-jolson", role: "vocals", title: "Sonny Boy (The Singing Fool clip, Jolson).webm", start: 25 },
  { id: "vocals-mojado", role: "vocals", title: "Grupo mojado tocando Piensa en mi.webm", start: 0 },
  { id: "vocals-spalding", role: "vocals", title: "Esperanza Spalding Performs at the White House Poetry Jam- (5 of 8).webm", start: 120 },
  { id: "keys-pratt", role: "keys", title: "Awadagin Pratt Performs at the White House- 2 of 8.webm", start: 90 },
  { id: "keys-rachmaninoff", role: "keys", title: "Rachmaninoff Piano Concerto No. 3 Ossia Cadenza.webm", start: 12 },
  { id: "other-wind", role: "other", label: "sax", title: "Anchors Aweigh by 215th Army Band's \"Liberty Winds\".webm", start: 6 },
  { id: "other-cello", role: "other", label: "violoncelo", title: "20091104 Alisa Weilerstein and Jason Yoder - Saint Saëns' The Swan.ogv", start: 30 },
  { id: "other-accordion", role: "other", label: "acordeão", title: "Akkordeonorchester Hof - Tritsch-Tratsch Polka.webm", start: 12 },
  { id: "other-jarocho", role: "other", label: "jarana", title: "Enarmonia tocando son jarocho en el escenario.webm", start: 6 },
  { id: "other-harp", role: "other", label: "harpa", title: "Harpo Marx performs \"When My Dreams come True\" (1929 Cocoanuts).webm", start: 40 },
];

// ---------------------------------------------------------------- Commons

const strip = (html) => (html ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCEPTED = /public domain|^pd\b|^cc0|^cc-0/i;

async function commonsInfo(titles) {
  const info = new Map();
  for (let i = 0; i < titles.length; i += 25) {
    const batch = titles.slice(i, i + 25);
    const url = new URL(API);
    for (const [k, v] of Object.entries({
      action: "query", format: "json", prop: "imageinfo", iiprop: "url|extmetadata|size|mime", origin: "*",
      titles: batch.map((t) => `File:${t}`).join("|"),
    })) url.searchParams.set(k, v);
    let body = null;
    for (let attempt = 0; attempt < 8 && !body; attempt++) {
      const response = await fetch(url, { headers: { "user-agent": UA } });
      const text = await response.text();
      if (text.startsWith("{")) body = JSON.parse(text);
      else await sleep(10_000);
    }
    if (!body) throw new Error("Commons API kept rate limiting");
    const alias = new Map((body.query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of Object.values(body.query.pages)) {
      const ii = page.imageinfo?.[0];
      const from = (alias.get(page.title) ?? page.title).replace(/^File:/, "");
      if (!ii) throw new Error(`not on Commons: ${page.title}`);
      const m = ii.extmetadata ?? {};
      const licence = strip(m.LicenseShortName?.value);
      if (!ACCEPTED.test(licence)) throw new Error(`REFUSED ${page.title}: licence is "${licence}", not public domain or CC0`);
      info.set(from, {
        title: page.title.replace(/^File:/, ""),
        page: ii.descriptionurl,
        url: ii.url,
        licence,
        author: strip(m.Artist?.value) || strip(m.Credit?.value) || "unknown",
        width: ii.width,
        height: ii.height,
      });
    }
    await sleep(2000);
  }
  return info;
}

// ------------------------------------------------------------------- tools

function run(cmd, argv) {
  const result = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

async function download(url, file) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    if (response.status === 429 || response.status === 503) { await sleep(30_000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return;
  }
  throw new Error(`${url}: rate limited`);
}

const sources = new Map();
/**
 * A local copy of a clip's source. Commons keeps a 480p transcode of most
 * videos next to the original; those are a few megabytes where a 4K original is
 * hundreds, so they are tried first and the original is the fallback.
 */
async function clipSource(meta, id) {
  if (sources.has(meta.title)) return sources.get(meta.title);
  mkdirSync(join(OUT, "src"), { recursive: true });
  const file = join(OUT, "src", `${id}.src`);
  if (!existsSync(file) || statSync(file).size === 0) {
    const path = new URL(meta.url).pathname; // /wikipedia/commons/c/cd/Name.webm
    const m = path.match(/^\/wikipedia\/commons\/(.\/..)\/(.+)$/);
    const candidates = m
      ? [`https://upload.wikimedia.org/wikipedia/commons/transcoded/${m[1]}/${m[2]}/${m[2]}.480p.vp9.webm`, `https://upload.wikimedia.org/wikipedia/commons/transcoded/${m[1]}/${m[2]}/${m[2]}.360p.vp9.webm`]
      : [];
    let done = false;
    for (const url of candidates) {
      try { await download(url, file); done = true; break; } catch (error) { if (!String(error).includes(": 404")) throw error; }
    }
    if (!done) await download(meta.url.split("?")[0], file);
    await sleep(4000);
  }
  sources.set(meta.title, file);
  return file;
}

/** Commons serves a resized copy on request; originals of posters are tens of megabytes. */
const thumb = (name, width) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name.replace(/ /g, "_"))}?width=${width}`;

// -------------------------------------------------------------------- main

mkdirSync(join(OUT, "covers"), { recursive: true });
mkdirSync(join(OUT, "portraits"), { recursive: true });
mkdirSync(join(OUT, "clips"), { recursive: true });

const everything = [...COVERS, ...PORTRAITS, ...new Set(CLIPS.map((c) => c.title))];
console.log(`checking the licence of ${everything.length} files on Commons`);
const info = await commonsInfo(everything);

const index = { covers: [], portraits: [], clips: [], format: FORMAT, seconds: SECONDS };
const attribution = [];

for (const [i, name] of COVERS.entries()) {
  const file = join(OUT, "covers", `c${String(i + 1).padStart(2, "0")}.jpg`);
  if (!existsSync(file) || statSync(file).size === 0) {
    const raw = `${file}.src`;
    await download(thumb(name, 1200), raw);
    // Squared here so the upload is what a person would pick; the site frames it again.
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=720:720", "-frames:v", "1", "-q:v", "3", file]);
    await sleep(4000);
  }
  index.covers.push(file);
  attribution.push({ kind: "cover", local: `covers/c${String(i + 1).padStart(2, "0")}.jpg`, ...info.get(name) });
  console.log("cover", i + 1);
}

for (const [i, name] of PORTRAITS.entries()) {
  const file = join(OUT, "portraits", `p${i + 1}.jpg`);
  if (!existsSync(file) || statSync(file).size === 0) {
    const raw = `${file}.src`;
    await download(thumb(name, 1024), raw);
    // These are three-quarter and half-length photographs: a centred upper square keeps the face.
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-vf", "crop=w='min(iw,ih*0.78)':h='min(iw,ih*0.78)':x='(iw-out_w)/2':y='ih*0.04',scale=384:384", "-frames:v", "1", "-q:v", "3", file]);
    await sleep(4000);
  }
  index.portraits.push(file);
  attribution.push({ kind: "avatar", local: `portraits/p${i + 1}.jpg`, ...info.get(name) });
  console.log("portrait", i + 1);
}

for (const clip of CLIPS) {
  const meta = info.get(clip.title);
  const file = join(OUT, "clips", `${clip.id}.${FORMAT}`);
  if (!existsSync(file) || statSync(file).size === 0) {
    const landscape = meta.width >= meta.height;
    // Native aspect, 360 on the short side: a phone clip stays upright, a film stays wide.
    const scale = landscape ? "scale=-2:360" : "scale=360:-2";
    const codec = FORMAT === "mp4"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"]
      : ["-c:v", "libvpx", "-b:v", "700k", "-crf", "30", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "80k"];
    const source = await clipSource(meta, clip.id);
    // A short source is looped to the 20 s a song part is.
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1",
      "-ss", String(clip.start), "-i", source, "-t", String(SECONDS),
      "-vf", `${scale},fps=24,format=yuv420p`, "-af", "aresample=44100,volume=0.9", ...codec, file,
    ]);
    await sleep(4000);
  }
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", file]));
  const v = probe.streams.find((s) => s.codec_type === "video");
  index.clips.push({ id: clip.id, role: clip.role, label: clip.label ?? null, file, width: v.width, height: v.height, hasAudio: probe.streams.some((s) => s.codec_type === "audio") });
  if (!attribution.some((a) => a.kind === "video" && a.title === meta.title)) attribution.push({ kind: "video", local: `clips/${clip.id}.${FORMAT}`, ...meta });
  else attribution.push({ kind: "video", local: `clips/${clip.id}.${FORMAT}`, ...meta, again: true });
  console.log("clip", clip.id);
}

writeFileSync(join(OUT, "media.json"), JSON.stringify(index, null, 2));

if (args["write-attribution"]) {
  const rows = attribution.map((a) => `| ${a.kind} | \`${a.local}\` | [${a.title.replace(/\|/g, "/")}](${a.page}) | ${a.author.replace(/\|/g, "/").slice(0, 120)} | ${a.licence} |${a.kind === "video" ? ` ${CLIPS.find((c) => `clips/${c.id}.${FORMAT}` === a.local)?.start}s |` : " |"}`);
  writeFileSync(join(here, "ATTRIBUTION.generated.md"), rows.join("\n") + "\n");
  console.log("wrote ATTRIBUTION.generated.md (rows only)");
}
console.log(`done: ${index.covers.length} covers, ${index.portraits.length} portraits, ${index.clips.length} clips in ${OUT}`);
