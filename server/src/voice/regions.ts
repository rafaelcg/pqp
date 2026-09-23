import type { IncomingHttpHeaders } from "node:http";
import { isWatchPartyChannelType, type ChannelKind } from "@pqp/shared";

/**
 * SFU REGIONS: which LiveKit box a voice room's media lives on.
 *
 * WHY. One self-hosted LiveKit in São Paulo carries every SFU room. Two
 * people in Europe in the same large-server room hear each other through
 * São Paulo, about 240 ms one way (`~/.config/pqp/international/EDGE.md`),
 * and it is exactly growth (a server crossing ten members, a community going
 * public) that moves a room onto the SFU and makes that happen. A second box
 * nearer to them fixes it, but only if something decides which box a room
 * uses. This module is that decision.
 *
 * THE RULE is the transport pin's rule, one level down. A room's region is
 * decided when its FIRST peer joins, from that peer's Cloudflare country
 * (`CF-IPCountry`), stored beside the transport pin (`voice_rooms.sfu_region`
 * with the registry on, `roomRegions` below always), and never changes while
 * anybody is in the room. Everybody in a room goes to that room's region:
 * LiveKit single nodes do not relay to each other, so a room split across two
 * boxes would be two rooms that cannot hear each other.
 *
 * SHIPS DARK. With `LIVEKIT_REGIONS` unset (every self-host, and production
 * until an operator sets it) `sfuRegions()` is null and every caller takes
 * exactly the path it took before this file existed: no column written, no
 * query issued, no field added to any response. Tests pin that.
 *
 * CONFIG, all read per call so a restart is the only thing that changes it:
 *
 * - `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`: the HOME region,
 *   unchanged. Named by `LIVEKIT_HOME_REGION` (default `sao`). Watch parties,
 *   egress and remux only ever talk to this one.
 * - `LIVEKIT_REGIONS=mia:wss://sfu-mia.pqp.gg,lon:wss://sfu-lon.pqp.gg`: the
 *   other regions. An entry for the home id is accepted and ignored (the home
 *   region is always `LIVEKIT_URL`), so the list may name every region.
 * - `LIVEKIT_API_KEY_<ID>` / `LIVEKIT_API_SECRET_<ID>` (`_MIA`, `_LON`): each
 *   box's own key pair, which is what `tools/sfu/install.sh` generates. Falls
 *   back to the home pair when unset, for boxes installed with the same pair.
 *   Per-box pairs are the recommendation: a leaked Miami key then cannot mint
 *   a token for a São Paulo room.
 * - `LIVEKIT_REGION_COUNTRIES=US:mia,CA:mia,GB:lon`: ISO country to region.
 *   Unlisted countries go to `LIVEKIT_REGION_DEFAULT` (default: home). This is
 *   the switch that turns routing on: regions configured with no country map
 *   route nobody anywhere new, which is the safe way to stage a box.
 */

export const DEFAULT_HOME_REGION = "sao";

/** The capability a client declares on `auth` when it dials whatever URL `POST /api/voice/token` names. */
export const SFU_REGION_CAP = "sfu-region";

export interface SfuRegion {
  id: string;
  url: string;
  apiKey: string;
  apiSecret: string;
  home: boolean;
}

const REGION_ID = /^[a-z][a-z0-9-]{0,15}$/;
const COUNTRY = /^[A-Z]{2}$/;

function normaliseRegionId(raw: string | undefined | null): string | null {
  const id = (raw ?? "").trim().toLowerCase();
  return REGION_ID.test(id) ? id : null;
}

export function homeRegionId(): string {
  return normaliseRegionId(process.env.LIVEKIT_HOME_REGION) ?? DEFAULT_HOME_REGION;
}

function envSuffix(id: string): string {
  return id.toUpperCase().replace(/-/g, "_");
}

function homeRegion(): SfuRegion | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    return null;
  }
  return { id: homeRegionId(), url, apiKey, apiSecret, home: true };
}

/** Config problems already reported, so a bad entry logs once per process, not per join. */
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) {
    return;
  }
  warned.add(message);
  console.warn(`[voice] ${message}`);
}

/**
 * Every configured region, home first, or null for single-region mode.
 *
 * Null when `LIVEKIT_REGIONS` is unset or names nothing usable beyond home,
 * and when the home triple itself is missing (no LiveKit at all). A bad entry
 * (unparseable id, a URL that is not ws:// or wss://, no key pair anywhere) is
 * dropped with a warning rather than failing the process: one typo in a new
 * region must not take the working one down with it.
 */
export function sfuRegions(): SfuRegion[] | null {
  const raw = (process.env.LIVEKIT_REGIONS ?? "").trim();
  if (!raw) {
    return null;
  }
  const home = homeRegion();
  if (!home) {
    return null;
  }
  const regions: SfuRegion[] = [home];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    const id = normaliseRegionId(colon > 0 ? trimmed.slice(0, colon) : null);
    const url = colon > 0 ? trimmed.slice(colon + 1).trim() : "";
    if (!id || !/^wss?:\/\//.test(url)) {
      warnOnce(`LIVEKIT_REGIONS entry ignored (want id:wss://host): ${trimmed}`);
      continue;
    }
    if (id === home.id) {
      if (url !== home.url) {
        warnOnce(
          `LIVEKIT_REGIONS names the home region ${id} with a URL other than LIVEKIT_URL; LIVEKIT_URL wins`,
        );
      }
      continue;
    }
    if (regions.some((region) => region.id === id)) {
      warnOnce(`LIVEKIT_REGIONS names ${id} twice; the first entry wins`);
      continue;
    }
    const suffix = envSuffix(id);
    const apiKey = process.env[`LIVEKIT_API_KEY_${suffix}`] || home.apiKey;
    const apiSecret = process.env[`LIVEKIT_API_SECRET_${suffix}`] || home.apiSecret;
    regions.push({ id, url, apiKey, apiSecret, home: false });
  }
  return regions.length > 1 ? regions : null;
}

export function multiRegionEnabled(): boolean {
  return sfuRegions() !== null;
}

/**
 * The region a stored or remembered id names. Null, unknown and removed ids
 * all answer HOME: a room pinned to a region an operator has since taken out
 * of the config has nowhere else to go, and home is where every room lived
 * before regions existed. Null only when LiveKit is not configured at all.
 */
export function resolveSfuRegion(id: string | null | undefined): SfuRegion | null {
  const regions = sfuRegions();
  if (!regions) {
    return homeRegion();
  }
  return regions.find((region) => region.id === id) ?? regions[0]!;
}

/**
 * `LIVEKIT_REGION_COUNTRIES`, parsed. Entries naming a region that is not
 * configured are dropped with a warning, so a country map written ahead of a
 * box (or left behind after one is removed) routes those countries to the
 * default instead of to nowhere.
 */
export function regionCountryMap(
  regions: readonly SfuRegion[] | null = sfuRegions(),
): Map<string, string> {
  const map = new Map<string, string>();
  if (!regions) {
    return map;
  }
  const ids = new Set(regions.map((region) => region.id));
  for (const entry of (process.env.LIVEKIT_REGION_COUNTRIES ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const [rawCountry, rawRegion] = trimmed.split(":");
    const country = (rawCountry ?? "").trim().toUpperCase();
    const region = normaliseRegionId(rawRegion);
    if (!COUNTRY.test(country) || !region) {
      warnOnce(`LIVEKIT_REGION_COUNTRIES entry ignored (want CC:region): ${trimmed}`);
      continue;
    }
    if (!ids.has(region)) {
      warnOnce(`LIVEKIT_REGION_COUNTRIES routes ${country} to unconfigured region ${region}; ignored`);
      continue;
    }
    map.set(country, region);
  }
  return map;
}

export function defaultRegionId(
  regions: readonly SfuRegion[] | null = sfuRegions(),
): string {
  const home = regions?.[0]?.id ?? homeRegionId();
  const wanted = normaliseRegionId(process.env.LIVEKIT_REGION_DEFAULT);
  if (wanted && regions?.some((region) => region.id === wanted)) {
    return wanted;
  }
  return home;
}

// --- the decision -------------------------------------------------------------

export type SfuRegionReason =
  /** `LIVEKIT_REGIONS` unset: the only region there is. */
  | "single"
  /** A DM or group call. Mesh by policy, never promoted; home for completeness. */
  | "dm"
  /**
   * A `watch_party` channel. Egress and remux talk to the home box only, so
   * the room that feeds them has to be there. Beats the operator override.
   */
  | "watch-party"
  /** The first joiner did not declare `sfu-region`: kept home, where every client has always gone. */
  | "old-client"
  /** `channels.sfu_region`, set by an operator. */
  | "override"
  /** The first joiner's `CF-IPCountry`, through `LIVEKIT_REGION_COUNTRIES`. */
  | "country"
  /** No country, or a country the map does not name: `LIVEKIT_REGION_DEFAULT`. */
  | "default";

export interface SfuRegionDecision {
  region: string;
  reason: SfuRegionReason;
}

export interface SfuRegionPolicyInput {
  /** Configured region ids, home first; null in single-region mode. */
  regionIds: readonly string[] | null;
  defaultRegion: string;
  countryMap: ReadonlyMap<string, string>;
  channel: {
    kind: ChannelKind;
    /** `channels.type`; only `watch_party` is read. */
    type: string;
    /** `channels.sfu_region`, the operator override; null is automatic. */
    sfuRegion: string | null;
  };
  /** The first joiner's country (`CF-IPCountry`, normalised), or null. */
  country: string | null;
  /** The first joiner's socket declared `sfu-region`. */
  clientDeclaresRegions: boolean;
}

/**
 * Pure: no env, no database. Runs once per room pin, like
 * `resolveVoiceTransport`, and its answer is pinned the same way.
 *
 * Order matters and is the whole policy:
 * 1. single-region mode answers home and nothing else is read;
 * 2. conversations are home (they are mesh and never promoted);
 * 3. a watch party channel is home, whatever anybody set, because the
 *    transcode can only reach the home box;
 * 4. a first joiner that never said it dials the URL it is handed keeps the
 *    room home. Every shipped client does in fact dial that URL (web,
 *    Electron, iOS and Android all pass `session.url` straight to
 *    `Room.connect`), so this is caution, not a known break: the region is
 *    only moved by a client that has promised it can follow;
 * 5. the operator override;
 * 6. the country map, then the default.
 */
export function decideSfuRegion(input: SfuRegionPolicyInput): SfuRegionDecision {
  const home = input.regionIds?.[0];
  if (!input.regionIds || !home) {
    return { region: home ?? DEFAULT_HOME_REGION, reason: "single" };
  }
  if (input.channel.kind !== "server") {
    return { region: home, reason: "dm" };
  }
  if (isWatchPartyChannelType(input.channel.type)) {
    return { region: home, reason: "watch-party" };
  }
  if (!input.clientDeclaresRegions) {
    return { region: home, reason: "old-client" };
  }
  const override = input.channel.sfuRegion;
  if (override && input.regionIds.includes(override)) {
    return { region: override, reason: "override" };
  }
  const byCountry = input.country ? input.countryMap.get(input.country) : undefined;
  if (byCountry && input.regionIds.includes(byCountry)) {
    return { region: byCountry, reason: "country" };
  }
  const fallback = input.regionIds.includes(input.defaultRegion)
    ? input.defaultRegion
    : home;
  return { region: fallback, reason: "default" };
}

// --- the country signal -------------------------------------------------------

/**
 * `CF-IPCountry`, normalised: two upper-case letters, or null. Cloudflare's
 * own non-answers are null too: `XX` (no data) and `T1` (Tor).
 *
 * Trusted as-is. The API is only reachable through Cloudflare (the box's
 * firewall admits Cloudflare's ranges and nothing else), and the worst a
 * forged header can do is put a room on another of our own boxes, which is a
 * latency cost for the forger's own call and nothing more.
 */
export function countryFromHeaders(headers: IncomingHttpHeaders): string | null {
  const raw = headers["cf-ipcountry"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  if (!value || !COUNTRY.test(value) || value === "XX" || value === "T1") {
    return null;
  }
  return value;
}

/**
 * The country each live socket's upgrade request carried. A WeakMap so a
 * socket that closes takes its entry with it and nothing has to remember to.
 */
const socketCountries = new WeakMap<object, string>();

/**
 * How many upgrades arrived with and without a usable country. The operator
 * dashboard shows it, and it is the proof that Cloudflare's IP Geolocation is
 * on and Caddy is passing the header through: a region rollout with this at
 * zero "with" routes everybody to the default.
 */
const countryHeaderCounts = { with: 0, without: 0 };

export function noteSocketCountry(socket: object, headers: IncomingHttpHeaders): void {
  const country = countryFromHeaders(headers);
  if (country) {
    socketCountries.set(socket, country);
    countryHeaderCounts.with += 1;
  } else {
    countryHeaderCounts.without += 1;
  }
}

export function socketCountry(socket: object): string | null {
  return socketCountries.get(socket) ?? null;
}

export function countryHeaderStats(): { with: number; without: number } {
  return { ...countryHeaderCounts };
}

// --- the pin ------------------------------------------------------------------

/**
 * Rooms this process holds a peer in, and the region each is pinned to. Only
 * ever written in multi-region mode. Same lifetime as `roomTransports` in
 * `ws/voice.ts`: set when the transport is pinned, dropped when it is.
 */
const roomRegions = new Map<string, string>();

export function pinRoomRegion(voiceChannelId: string, region: string): void {
  roomRegions.set(voiceChannelId, region);
}

export function pinnedRoomRegion(voiceChannelId: string): string | null {
  return roomRegions.get(voiceChannelId) ?? null;
}

export function forgetRoomRegion(voiceChannelId: string): void {
  roomRegions.delete(voiceChannelId);
}

/** Rooms pinned per region in this process, for the dashboard. */
export function pinnedRoomRegionCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const region of roomRegions.values()) {
    counts[region] = (counts[region] ?? 0) + 1;
  }
  return counts;
}

/** Test hook. */
export function resetRoomRegions(): void {
  roomRegions.clear();
  countryHeaderCounts.with = 0;
  countryHeaderCounts.without = 0;
  warned.clear();
}
