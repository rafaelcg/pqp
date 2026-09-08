/**
 * Voice / camera / screen-share specs take most of the Playwright wall clock.
 * Playwright shards by file when fullyParallel is off (one worker, one
 * database), so these used to land on one shard and dominate CI. The
 * chromium-media project matches this regex; chromium ignores it.
 *
 * Filename prefixes, not test titles: --project filters files, and a title
 * grep would still boot every spec. mobile-immersive-stage stays out — it
 * has its own project.
 *
 * Playwright matches testMatch / testIgnore against the absolute path, so
 * the prefix is `[/\\]e2e[/\\]` rather than `(?:^|/)`. A worktree under
 * `/tmp/screen-share-fix/` must not flip every spec into the media project.
 */
export const MEDIA_SPEC =
  /[/\\]e2e[/\\](?:voice-|video-quality|viewer-video-quality|share-cursor|screen-|push-to-talk|outbound-readout|camera-stage|call-stage-strip|call-split-layout|dm-call|profile-popover-call)/;
