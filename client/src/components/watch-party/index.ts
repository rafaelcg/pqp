/**
 * `watchParty/ui`. See `docs/WATCH_PARTY.md` for the module split.
 *
 * The container mounts `WatchPartyStage`. Everything else is exported because
 * the tests reach for it, not because there is a second caller.
 */
export { WatchPartyStage, type WatchPartyStageProps } from "./watch-party-stage";
export { WatchPartyComposer } from "./watch-party-composer";
export { WatchPartyControls } from "./watch-party-controls";
export { WatchPartyFailure } from "./watch-party-failure";
export { WatchPartyJoin } from "./watch-party-join";
export {
  SKIP_MS,
  failurePresentation,
  keepsJoined,
  showsComposer,
  showsPartyEditing,
  showsPlayer,
  statusKey,
  transportAvailability,
  watchPartyView,
  type FailurePresentation,
  type PlaybackFailureReason,
  type TransportAvailability,
  type WatchPartyView,
  type WatchPartyViewKind,
} from "./watch-party-view";
