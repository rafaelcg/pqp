/**
 * Voice / camera / screen-share specs take most of the Playwright wall clock.
 * Playwright shards by file when fullyParallel is off (one worker, one
 * database), so these used to land on one shard and dominate CI. The
 * chromium-media project matches this regex; chromium ignores it.
 *
 * Filename prefixes, not test titles: --project filters files, and a title
 * grep would still boot every spec. mobile-immersive-stage stays out — it
 * has its own project.
 */
export const MEDIA_SPEC =
  /(?:^|\/)(?:voice-|video-quality|viewer-video-quality|share-cursor|screen-|push-to-talk|outbound-readout|camera-stage|call-stage-strip|call-split-layout|dm-call|profile-popover-call)/;
