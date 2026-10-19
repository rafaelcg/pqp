import type { AppConfigEntry, AppSessionSummary, AppUnavailableReason } from "@pqp/shared";
import { APP_UNBOUNDED_PLAYERS, appText } from "@/lib/apps/card-model";

/**
 * What the launcher lists and what each tile says, decided from data alone
 * (mock 01). A tile that cannot be used here is dimmed with its reason written,
 * never hidden: the person learns that it exists and where it works.
 */

export type LauncherChannelType = "text" | "voice";

/** A reason in the launcher's own words (a catalogue key, filled by the component). */
export type TileReason =
  | "voice-only"
  | "text-only"
  | "off-here"
  | "community"
  | "unavailable"
  | "join-call";

export interface AppTile {
  kind: "app";
  id: string;
  app: AppConfigEntry;
  name: string;
  icon: AppConfigEntry["icon"];
  /** The people line under the name, as parts a component writes. */
  size: TileSize;
  /** Why this app cannot start here, or null. */
  reason: TileReason | null;
  /** This is the app running in the channel right now. */
  running: boolean;
}

export type TileSize =
  | { kind: "any" }
  | { kind: "exact"; count: number; people: boolean }
  | { kind: "range"; min: number; max: number; people: boolean };

export type BuiltInId = "music" | "watch-party";

/** Música and watch party: shortcuts into what already exists (decision 7). */
export interface BuiltInTile {
  kind: "builtin";
  id: BuiltInId;
  reason: TileReason | null;
}

export type LauncherTile = AppTile | BuiltInTile;

export interface LauncherInput {
  apps: readonly AppConfigEntry[];
  channelType: LauncherChannelType;
  locale: string;
  /** The live session of this channel, if any. */
  live?: AppSessionSummary;
  /** Música: is this person in this voice channel's call, where the queue lives. */
  inCallHere: boolean;
  /** Watch party: the server has the channels on, and there is somewhere to go. */
  watchPartyAvailable: boolean;
}

export function sizeOf(app: AppConfigEntry): TileSize {
  const { min, max } = app.players;
  const people = app.category === "tool";
  if (max >= APP_UNBOUNDED_PLAYERS) {
    return { kind: "any" };
  }
  if (min === max) {
    return { kind: "exact", count: max, people };
  }
  return { kind: "range", min, max, people };
}

/** The first reason an app cannot start in this channel, in the order a person would meet them. */
export function appTileReason(
  app: AppConfigEntry,
  channelType: LauncherChannelType,
): TileReason | null {
  if (!app.channelTypes.includes(channelType)) {
    return channelType === "text" ? "voice-only" : "text-only";
  }
  if (app.available) {
    return null;
  }
  return reasonOf(app.reason);
}

function reasonOf(reason: AppUnavailableReason | null): TileReason {
  switch (reason) {
    case "community-locked":
      return "community";
    case "no-origin":
    case "not-live":
      return "unavailable";
    default:
      return "off-here";
  }
}

export function buildLauncherTiles(input: LauncherInput): LauncherTile[] {
  const tiles: LauncherTile[] = input.apps.map((app) => ({
    kind: "app",
    id: app.id,
    app,
    name: appText(app, input.locale, app.name),
    icon: app.icon,
    size: sizeOf(app),
    reason: appTileReason(app, input.channelType),
    running: input.live?.appId === app.id,
  }));
  tiles.push({
    kind: "builtin",
    id: "music",
    reason:
      input.channelType !== "voice" ? "voice-only" : input.inCallHere ? null : "join-call",
  });
  if (input.watchPartyAvailable) {
    tiles.push({ kind: "builtin", id: "watch-party", reason: null });
  }
  return tiles;
}

/**
 * The tile that starts selected: the app already running here, else the first
 * that can start, else the first of the list. The mock selects "Sala de jogos
 * because it is first".
 */
export function initialSelection(tiles: readonly LauncherTile[]): string | null {
  const running = tiles.find((tile) => tile.kind === "app" && tile.running);
  if (running) {
    return running.id;
  }
  const usable = tiles.find((tile) => tile.reason === null);
  return (usable ?? tiles[0])?.id ?? null;
}

/**
 * Which tile an arrow key lands on in the grid of `columns`: left and right
 * move by one, up and down by a row, Home and End to the ends. It stops at the
 * edges rather than wrapping, so the person always knows where they are.
 */
export function moveSelection(
  index: number,
  count: number,
  key: string,
  columns: number,
): number {
  if (count === 0) {
    return -1;
  }
  const clamp = (value: number) => Math.min(count - 1, Math.max(0, value));
  switch (key) {
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowDown":
      return clamp(index + columns);
    case "ArrowUp":
      return clamp(index - columns);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return index;
  }
}
