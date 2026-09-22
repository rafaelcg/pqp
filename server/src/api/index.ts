import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AUTOMOD_MENTION_LIMIT_DEFAULT,
  createAutomodRuleSchema,
  updateAutomodRuleSchema,
  addChannelMemberSchema,
  ageDeclarationSchema,
  createChannelSessionSchema,
  createWatchPartySchema,
  updateWatchPartySchema,
  watchPartyCohostRequestSchema,
  watchPartyHostRequestSchema,
  watchPartyGuestsRequestSchema,
  watchPartyStateRequestSchema,
  hasWatchPartyStaffPermission,
  isWatchPartyTerminal,
  watchPartyRefusalMessage,
  watchPartyRole,
  type WatchPartyAction,
  updateChannelSessionSchema,
  AUDIT_LOG_PAGE_MAX,
  AUDIT_LOG_PAGE_SIZE,
  auditActionSchema,
  AVATAR_IMAGE_SIZE,
  banMemberSchema,
  bulkDeleteMessagesSchema,
  claimAvatarSchema,
  claimServerImageSchema,
  createAttachmentSchema,
  createAvatarUploadSchema,
  createServerImageUploadSchema,
  createBlockSchema,
  createChannelMessageSchema,
  createChannelSchema,
  moveChannelSchema,
  createDmSchema,
  createGifAttachmentSchema,
  createInviteSchema,
  createServerSchema,
  createWebhookSchema,
  deleteAccountSchema,
  deleteConfirmationMatches,
  executeWebhookSchema,
  expectedDeleteConfirmation,
  formatUserTag,
  createOutgoingWebhookSchema,
  updateOutgoingWebhookSchema,
  issueTimeoutSchema,
  MAX_AVATAR_BYTES,
  MAX_SERVER_BANNER_BYTES,
  MAX_SERVER_ICON_BYTES,
  maxServerImageBytes,
  COMMUNITY_FEATURED_IMAGE_HEIGHT,
  COMMUNITY_FEATURED_IMAGE_WIDTH,
  SERVER_BANNER_HEIGHT,
  SERVER_BANNER_WIDTH,
  SERVER_ICON_SIZE,
  type ServerImageKind,
  GIF_PAGE_MAX,
  GIF_PAGE_SIZE,
  GIF_QUERY_MAX_LENGTH,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  messageBodyTextSchema,
  messageSearchQuerySchema,
  removeMemberSchema,
  REPORT_PAGE_MAX,
  REPORT_PAGE_SIZE,
  createFeedbackSchema,
  createReportSchema,
  FEEDBACK_PAGE_MAX,
  FEEDBACK_PAGE_SIZE,
  createCallRatingSchema,
  feedbackStatusSchema,
  resolveFeedbackSchema,
  createThreadSchema,
  claimUserBannerSchema,
  COMMUNITY_PAGE_MAX,
  COMMUNITY_PAGE_SIZE,
  COMMUNITY_SLUG_PATTERN,
  communityCategorySchema,
  communityLanguageSchema,
  communitySearchQuerySchema,
  communitySlugSchema,
  createUserBannerUploadSchema,
  MAX_USER_BANNER_BYTES,
  USER_BANNER_HEIGHT,
  USER_BANNER_WIDTH,
  communityTaglineSchema,
  communityAboutSchema,
  normalizeCommunityLinks,
  parseCommunityFeaturedEmbed,
  updateCommunitySchema,
  reportStatusSchema,
  resolveReportSchema,
  ssoEmailDomainSchema,
  SEARCH_PAGE_MAX,
  SEARCH_PAGE_SIZE,
  updateChannelSchema,
  updateMemberRoleSchema,
  updateMessageSchema,
  createRoleSchema,
  updateRoleSchema,
  reorderRolesSchema,
  markChannelReadSchema,
  channelOverwriteSchema,
  completeConnectionSchema,
  updateConnectionSchema,
  updateProfileSchema,
  updateServerSchema,
  USER_SEARCH_PAGE_SIZE,
  userPreferencesSchema,
  userSearchQuerySchema,
  parseUserTag,
  voiceSessionRequestSchema,
  type Gif,
  discordImportSourceSchema,
  DiscordImportCapError,
  DiscordImportParseError,
  parseDiscordTemplateCode,
  claimCommunityHomeMediaSchema,
  COMMUNITY_HOME_MAX_BYTES,
  pinCommunityHomePostSchema,
  createCommunityHomeCommentSchema,
  createCommunityHomeMediaUploadSchema,
  createCommunityHomePostSchema,
  communityHomeCommentBodySchema,
  parseCommunityHomeBody,
  parseCommunityHomeTeaser,
  parseCommunityHomeTitle,
  scheduleCommunityHomePostSchema,
  updateCommunityHomePostSchema,
  updateServerCommunityHomeConfigSchema,
  isVoiceRoomChannelType,
  liveHlsTelemetryBatchSchema,
  streamQualityTelemetryBatchSchema,
} from "@pqp/shared";
import { z } from "zod";
import {
  createLiveKitSession,
  getServerVoiceBackend,
  isLiveKitConfigured,
} from "../voice/backends.js";
import { liveHlsConfigForServer } from "../voice/hls-egress.js";
import { setRequestedHlsMode } from "../voice/hls-remux.js";
import {
  buildReplayMasterPlaylist,
  buildReplaySignedPlaylist,
  buildWatchPartyDownloadPlan,
  checkWatchPartyReplayAccess,
  isWatchPartyDownloadKind,
  listWatchPartyHistory,
  setWatchPartyKeepReplay,
  streamWatchPartyDownload,
  watchPartyDownloadSizes,
  WATCH_PARTY_DOWNLOAD_KINDS,
  type WatchPartyDownloadKind,
  type WatchPartyDownloadPlan,
} from "../voice/hls-history.js";
import {
  buildMasterPlaylistFor,
  buildSignedPlaylist,
  hlsPlaylistAgeMs,
  HlsPlaylistNotFound,
  HlsPlaylistUnavailable,
  noteHlsPlaylistRejected,
  resolveHlsPlaylistViewer,
  resolveHlsSessionId,
} from "../voice/hls-playlist-proxy.js";
import { isHlsAccessRevoked } from "../voice/hls-revocation.js";
import {
  recordHlsLatencySample,
  recordHlsTelemetryBatchAccepted,
  recordHlsTelemetryBatchRejectedRateLimit,
  recordHlsTelemetryBatchRejectedSchema,
  recordHlsTelemetryBatchRejectedSession,
  recordHlsTelemetryBatchRejectedSessionLookupTimeout,
} from "../voice/hls-latency-metrics.js";
import {
  recordStreamQualityBatchAccepted,
  recordStreamQualityBatchRejectedRateLimit,
  recordStreamQualityBatchRejectedSchema,
  recordStreamQualitySample,
} from "../voice/stream-quality-metrics.js";
import { isKnownHlsRung } from "../voice/hls-ladder.js";
import { createHlsSessionLookupGuard } from "../voice/hls-telemetry-session-guard.js";
import {
  decodeHlsViewerToken,
  describeHlsViewerToken,
  HLS_VIEWER_TOKEN_PARAM,
  mintHlsViewerToken,
  stampViewerStream,
} from "../voice/hls-viewer-token.js";
import {
  acknowledgeHlsHost,
  hasAcknowledgedHlsHost,
} from "../services/hls-host-ack.js";
import {
  applyManualStatus,
  broadcastProfileUpdate,
  broadcastToChannel,
  cancelPrivateVoiceResweep,
  evictChannelViewers,
  evictUserFromChannels,
  evictVoiceChannel,
  evictVoiceUser,
  evictVoiceUsersExcept,
  notifyPermissionsUpdate,
  notifyCommunityHomeUpdate,
  applyAutomodEffects,
  postChannelMessage,
  resolveEmbedInBackground,
  resolveStatuses,
  takeMessageBudget,
} from "../ws/index.js";
import {
  // --- voice moderation ---
  disconnectVoiceUser,
  findVoiceChannelForUser,
  findVoicePeerIdentities,
  getChannelLiveState,
  getRoomTransport,
  getVoicePeer,
  isRoomPinnedLocally,
  leaveVoiceByResumeToken,
  notifyVoiceModeration,
  setVoiceUserHandRaised,
  setVoiceUserServerMuted,
  refreshVoiceIdentity,
  describeChannelVoiceTransport,
} from "../ws/voice.js";
import { verifyVoiceResumeToken } from "../ws/voice-resume-token.js";
// --- voice moderation ---
import { evictSfuUser, setSfuUserCanPublish, setSfuUserMuted } from "../voice/admin.js";
import {
  getVoicePeerRow,
  isVoiceRegistryEnabled,
  readVoiceRoomTransport,
} from "../voice/registry.js";
import { resolveVoicePublish } from "../voice/speak.js";
import {
  createDesktopSignInToken,
  invalidateUserCache,
  isClerkUserId,
  resolveAuthSession,
} from "../auth/clerk.js";
import {
  AGE_GATE_BLOCKED_MESSAGE,
  AGE_GATE_PENDING_MESSAGE,
  isAgeGateExempt,
  isPlausibleBirthDate,
  parseCalendarDate,
  recordAgeDeclaration,
} from "../services/age-gate.js";
import { recordActivationStep } from "../services/activation.js";
import type { DbUser, MemberRole } from "../db.js";
import { DatabaseUnavailableError } from "../db.js";
import {
  clampLimit,
  corsHeaders,
  handleCors,
  HttpError,
  isUuid,
  readJsonBody,
  SECURITY_HEADERS,
  sendConditionalJson,
  sendDatabaseUnavailable,
  sendError,
  sendJson,
} from "../lib/http.js";
import { Etagged, etagged } from "../lib/etag.js";
import { logEvent } from "../lib/log.js";
import {
  clientAddress,
  createRateLimiter,
  limitFromEnv,
} from "../lib/rate-limit.js";
import {
  createRouter,
  type RequestContext,
  type RouteHandler,
} from "../lib/router.js";
import { AUTH_ROUTE_LABEL, runWithRoute } from "../lib/route-context.js";
import {
  buildPersonalExport,
  deleteAccount,
  IdentityDeletionFailedError,
  OwnedServersBlockDeletionError,
} from "../services/account.js";
import { listAuditLog, logAudit } from "../services/audit.js";
import {
  checkAutomod,
  createAutomodRule,
  deleteAutomodRule,
  getAutomodRule,
  listAutomodRules,
  recordAutomodHit,
  updateAutomodRule,
} from "../services/automod.js";
import {
  avatarUrlForKey,
  createAvatarUpload,
  createUserBannerUpload,
  discardBannerObject,
  isAvatarUploadConfigured,
  isUserBannerUploadConfigured,
  presignAvatarRead,
  presignUserBannerRead,
  setUserBanner,
  userBannerUrlForKey,
  verifyAvatarObject,
  verifyUserBannerObject,
} from "../services/avatars.js";
import {
  createServerImageUpload,
  isServerImageUploadConfigured,
  presignServerImageRead,
  scheduleDiscardServerImageObject,
  serverImageUrlForKey,
  setServerImage,
  verifyServerImageObject,
} from "../services/server-images.js";
import {
  addCommunityHomeComment,
  claimCommunityHomeMediaUpload,
  CommunityHomeError,
  countUnreadCommunityHomePosts,
  markCommunityHomeRead,
  setCommunityHomePostPinned,
  createCommunityHomePost,
  deleteCommunityHomeComment,
  deleteCommunityHomePost,
  getCommunityHomePost,
  isCommunityHomeEnabled,
  isCommunityHomeMediaConfigured,
  isCommunityHomeVipEnabled,
  listCommunityHomeComments,
  listCommunityHomeDrafts,
  listCommunityHomePosts,
  mintCommunityHomeMediaUpload,
  publishCommunityHomePost,
  scheduleCommunityHomePost,
  toggleCommunityHomeLike,
  unpublishCommunityHomePost,
  updateCommunityHomePost,
} from "../services/community-home.js";
import {
  cancelChannelSession,
  ChannelSessionError,
  createChannelSession,
  getChannelSession,
  listUpcomingChannelSessions,
  listUpcomingChannelSessionsForServer,
  setChannelSessionReminder,
  updateChannelSession,
} from "../services/channel-sessions.js";
import {
  addWatchPartyCohost,
  applyWatchPartyOptions,
  authoriseWatchParty,
  createWatchParty,
  findOrCreateWatchPartyRoom,
  getActiveWatchPartyRow,
  getBlockingWatchParty,
  getWatchPartyRow,
  supersedeStaleWatchPartyDraft,
  listCohostIds,
  listActiveWatchPartiesForServer,
  presentWatchParty,
  acceptWatchPartyGuestRequest,
  declineWatchPartyGuestRequest,
  guestRequestCooldownActive,
  inviteWatchPartyGuest,
  isWatchPartyGuest,
  joinWatchPartyGuestSlot,
  leaveWatchPartyGuestSlot,
  reconcileLiveWatchPartyOptions,
  removeWatchPartyGuest,
  removeWatchPartyCohost,
  requestWatchPartyGuestSlot,
  transferWatchPartyHost,
  transitionWatchParty,
  updateWatchParty,
  watchPartyGuestDeclinedAt,
  watchPartyOptionsOf,
  withdrawWatchPartyGuestRequest,
  WatchPartyError,
  WatchPartyGuestsError,
} from "../services/watch-parties.js";
import { broadcastWatchParty } from "../ws/watch-party-events.js";
import { userHasAuthenticatedSocket } from "../ws/sockets.js";
import { hasClusterSocket } from "../ws/status.js";
import { buildServerExport } from "../services/export.js";
import {
  CommunityListingForbiddenError,
  CommunityListingNeedsAddressError,
  CommunitySlugError,
  findCommunityIdBySlug,
  getCommunity,
  getCommunitySettings,
  getPublicCommunity,
  isCommunitiesEnabled,
  joinCommunity,
  listCommunities,
  updateCommunitySettings,
} from "../services/communities.js";
import {
  createWebhook,
  deleteWebhook,
  executeWebhook,
  getWebhook,
  getWebhookForExecution,
  listWebhooksForChannel,
  type DbWebhook,
} from "../services/webhooks.js";
import {
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  getOutgoingWebhookRow,
  listOutgoingWebhooks,
  OutgoingWebhookChannelsError,
  OutgoingWebhookSkipUsersError,
  rotateOutgoingWebhookSecret,
  serverHasActiveOutgoingWebhook,
  statusWithCharacterHook,
  updateOutgoingWebhook,
} from "../services/outgoing-webhooks.js";
import {
  extractFirstUrl,
  getEmbedCacheState,
  getEmbedImageUrl,
} from "../services/embeds.js";
import { safeFetch } from "../lib/safe-fetch.js";
import {
  createInvite,
  deleteInvite,
  getInviteByCode,
  listInvites,
  mapInvite,
  redeemInvite,
} from "../services/invites.js";
import {
  createServerFromImport,
  DiscordTemplateNotFoundError,
  DiscordTemplateRateLimitedError,
  DiscordTemplateTooLargeError,
  DiscordTemplateUnavailableError,
  fetchMappedDiscordTemplate,
} from "../services/discord-import.js";
import {
  ChannelPinLimitError,
  deleteMessage,
  deleteMessagesBulk,
  getMessage,
  listMessages,
  listRecentMessageIds,
  listPinnedMessages,
  mapMessage,
  pinMessage,
  UnknownCursorError,
  unpinMessage,
  updateMessageBody,
} from "../services/messages.js";
import {
  banMember,
  kickMember,
  listBans,
  listRevokedPrivateChannelIds,
  unbanMember,
} from "../services/moderation.js";
import {
  findTimeoutForRequest,
  issueTimeout,
  liftTimeout,
  listActiveTimeouts,
  timeoutMessage,
} from "../services/sanctions.js";
import {
  addChannelMember,
  createChannel,
  createServer,
  deleteChannel,
  deleteObjectsInBackground,
  deleteServer,
  getChannel,
  getChannelAudience,
  InvalidChannelMoveError,
  listChannelMembers,
  listChannels,
  listServerChannelIds,
  listServersForUser,
  mapChannel,
  mapServer,
  moveChannel,
  removeChannelMember,
  renameServer,
  SERVER_COLUMNS,
  getServer,
  setCommunityHomeEnabled,
  transferOwnership,
  updateChannel,
  updateMessageRetention,
  updateSsoEmailDomain,
  listSsoJoinableServers,
  joinServerBySso,
} from "../services/servers.js";
import {
  attachmentUrlTtlSeconds,
  AttachmentTooLargeError,
  createPendingAttachment,
  createRemoteAttachment,
  getAttachmentForViewer,
  isAttachmentsConfigured,
  toPublicAttachment,
  UnsupportedRemoteHostError,
  maxAttachmentBytes,
} from "../services/attachments.js";
import {
  GifBackendError,
  isGifSearchConfigured,
  searchGifs,
  trendingGifs,
} from "../services/gifs.js";
import {
  MusicResolveError,
  relatedMusicTracks,
  resolveMusic,
  searchMusicCandidates,
} from "../services/music.js";
import {
  completeConnection,
  connectionsConfig,
  disconnectConnection,
  isProviderEnabled,
  listCardConnections,
  listOwnConnections,
  parseConnectionProvider,
  startConnection,
  updateConnectionVisibility,
} from "../services/connections.js";
import { getIceServers } from "../services/ice.js";
import {
  createReport,
  getReport,
  getReportScope,
  isInstanceModerator,
  listAllReports,
  listInstanceReports,
  listReportsByReporter,
  listServerReports,
  ReportFloodError,
  ReportTargetNotVisibleError,
  resolveReport,
} from "../services/reports.js";
import {
  createFeedback,
  listFeedback,
  listUserAchievements,
  resolveFeedback,
} from "../services/feedback.js";
import { recordCallRating } from "../services/call-ratings.js";
import { placeInDefaultCommunity } from "../services/default-community.js";
import {
  acquisitionReport,
  recordAcquisition,
} from "../services/acquisition.js";
import {
  ADMIN_VOICE_OCCUPANCY_PATH,
  clampOccupancyDays,
  parseOccupancyDay,
  voiceOccupancyReport,
} from "../services/voice-occupancy.js";
import {
  ADMIN_METRICS_PATH,
  getAdminMetrics,
  isAdminMetricsTokenValid,
} from "../services/metrics.js";
import {
  OPERATOR_CHANNELS_PATH,
  OPERATOR_CHANNEL_TRANSPORT_PATH,
  OPERATOR_SERVERS_PATH,
  OPERATOR_SERVER_LIVE_HLS_PATH,
  OperatorTargetMissing,
  listOperatorChannels,
  listOperatorServers,
  setChannelVoiceTransport,
  setChannelVoiceTransportSchema,
  setServerLiveHls,
  setServerLiveHlsSchema,
} from "../services/operator.js";
import {
  claimHandle,
  findUserIdByHandle,
  getPublicProfileByHandle,
} from "../services/profiles.js";
import { decodeSearchCursor, searchMessages } from "../services/search.js";
// --- threads ---
import { SIDEBAR_THREADS_PER_CHANNEL } from "@pqp/shared";
import {
  createThreadForMessage,
  listActiveThreadsByParent,
  listThreadChannelIds,
  setThreadMembership,
  ThreadTargetError,
} from "../services/threads.js";
import { mergePreferences } from "../services/preferences.js";
import {
  blockUser,
  listBlocks,
  SelfBlockError,
  unblockUser,
} from "../services/blocks.js";
import {
  DmRefusedError,
  getConversation,
  hideConversation,
  isDmSendBlocked,
  listConversations,
  openConversation,
} from "../services/dms.js";
import {
  canAccessChannel,
  findUserById,
  findUserByTag,
  getMemberRole,
  getUserById,
  invalidateMemberListsForUser,
  isServerMember,
  leaveServer,
  listServerMembers,
  listUnread,
  markChannelRead,
  resolveMemberName,
  searchUsersByPrefix,
  setMemberNickname,
  toPublicUser,
  updateMemberRole,
  updateProfile,
} from "../services/users.js";
import {
  canActOnMember,
  coerceEveryoneViewOverwrite,
  computeMemberPermissions,
  bumpPermissionsVersion,
  getEveryoneRoleId,
  getMemberHierarchy,
  getPermissionsSnapshot,
  memberHasPermission,
  Permission,
  restorePrivateEveryoneViewOverwrite,
} from "../services/permissions.js";
import {
  assertCanEditRole,
  assignRole,
  clampRolePermissions,
  createRole,
  deleteChannelOverwrite,
  deleteRole,
  getRole,
  listChannelOverwrites,
  listRoles,
  mapRole,
  parsePermissions,
  reorderRoles,
  unassignRole,
  updateRole,
  upsertChannelOverwrite,
} from "../services/roles.js";

/** Per-identity request budget. Generous for a UI, hostile to a script. */
/**
 * Tunable because the right ceiling depends on the deployment: a family
 * self-host and a public instance want very different numbers, and an automated
 * suite driving one account needs headroom a human never would.
 */
const apiLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_API_CAPACITY", 120),
  refillPerSecond: limitFromEnv("RATE_LIMIT_API_REFILL", 10),
});
/** Writes are cheaper to abuse and more expensive to serve. */
const writeLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_WRITE_CAPACITY", 30),
  refillPerSecond: limitFromEnv("RATE_LIMIT_WRITE_REFILL", 2),
});
/**
 * Pre-auth backstop keyed by address. Behind a proxy without `TRUST_PROXY`,
 * every caller looks like the same address — so this bucket is deliberately
 * coarse. The per-user buckets above do the real work; this one only exists to
 * stop an unauthenticated flood from reaching Clerk token verification.
 *
 * Tunable for the same reason the per-identity budgets above are, plus one
 * specific to measurement: a load harness runs from a single address, so every
 * simulated client shares this one bucket and it becomes the ceiling long
 * before the server does. A run that leaves it at 60/s measures this line, not
 * the API. Defaults unchanged; see docs/STAGING.md.
 */
const anonLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_ANON_CAPACITY", 240),
  refillPerSecond: limitFromEnv("RATE_LIMIT_ANON_REFILL", 60),
});
/**
 * GIF search is a per-keystroke read against someone else's quota, so it gets a
 * tighter budget than the general one: enough for a debounced session of
 * typing, not enough to burn the deployment's key.
 */
const gifLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });
/**
 * Connecting a Steam / Battle.net / Twitch account hits those providers on
 * the request path. A handful of attempts is a person clicking twice; a
 * scripted flood would burn their keys and ours.
 */
const connectionLimiter = createRateLimiter({
  capacity: 8,
  refillPerSecond: 0.2,
});
/**
 * Minting a desktop handoff ticket hits Clerk on the request path. A handful
 * of retries is a person clicking twice; a scripted flood would burn the
 * Backend API quota and produce live sign-in tokens.
 */
const desktopHandoffLimiter = createRateLimiter({
  capacity: 8,
  refillPerSecond: 0.2,
});
/**
 * Search is also per-keystroke, but the expensive party is our own database
 * rather than a third party's quota: one query ranks every visible message in a
 * server. The burst covers a debounced session of typing plus paging through
 * the results; sustained it is roughly one search per second.
 */
const searchLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
/**
 * Minting an upload URL is the most expensive write the API grants: each one is
 * a standing permit to put 10 MiB into the bucket, and the bytes never come past
 * here to be counted. The burst covers dragging a full ten-file message in at
 * once; sustained it is one file every ten seconds, which no human beats and a
 * script would need hours to run up a bill with.
 */
const uploadLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.1 });
/**
 * Baú write budgets, tighter than the global one because each of these is
 * cheap to send and expensive to serve: a comment is read by every member of
 * the server, and a post is fanned out to all of them.
 *
 * A burst is allowed (people do reply twice in a row); a sustained flood is
 * not. The global `writeLimiter` still applies underneath.
 */
const homeCommentLimiter = createRateLimiter({
  capacity: 6,
  refillPerSecond: 0.2,
});
const homeLikeLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });
const homePostLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.05 });
/**
 * User discovery is an enumeration surface over every account on the instance,
 * and unlike message search it is not scoped to anything the caller already
 * belongs to — it is the one endpoint that answers questions about people the
 * caller has no relationship with at all. So it gets the tightest budget in the
 * file: a burst that covers typing a handle into a picker, and sustained about
 * one query every two seconds, which is a working search box and a directory
 * scrape that would take weeks.
 */
const userSearchLimiter = createRateLimiter({
  capacity: 15,
  refillPerSecond: 0.5,
});
/**
 * A full server export walks every message the server has, up to the cap in
 * `export.ts` — the single most expensive read this API serves on demand.
 * A small burst covers a retry after a dropped connection; the slow refill
 * is what stops it from being repeatable enough to matter as a scrape.
 */
const exportLimiter = createRateLimiter({ capacity: 3, refillPerSecond: 0.02 });
/**
 * Copying a Discord layout hits Discord's template API on the request path.
 * A small burst covers preview then apply (and one retry); the slow refill
 * is what stops a script from using this process as a Discord scraper.
 */
const discordImportLimiter = createRateLimiter({
  capacity: 3,
  refillPerSecond: 0.02,
});
/**
 * Shared egress to discord.com. Preview and apply both fetch; a handful of
 * people clicking at once is fine, a coordinated flood is how we get 429'd.
 */
const discordFetchLimiter = createRateLimiter({
  capacity: 20,
  refillPerSecond: 1,
});
/**
 * `GET /api/me/export` walks every message one account ever wrote, across every
 * server and conversation, and serialises it into one response — the same shape
 * of expense as the server export and the same reason to bound it. It is also a
 * good DoS lever precisely because it is a *right*: the endpoint cannot be
 * gated behind ownership of anything, so every account on the instance can
 * reach it.
 *
 * Two in a burst covers a retry after a dropped download; sustained it is one
 * every ten minutes, which is far more often than anybody genuinely needs their
 * own data and far too slow to be worth pointing at the server.
 */
const personalExportLimiter = createRateLimiter({
  capacity: 2,
  refillPerSecond: 1 / 600,
});
/**
 * Account deletion succeeds at most once, so this bucket exists only to bound
 * the *failures* — a script guessing at the confirmation string, or hammering
 * the owned-server pre-flight. Three attempts covers mistyping your own handle;
 * the refill is slow because a fourth attempt in a minute is not a person.
 */
const accountDeleteLimiter = createRateLimiter({
  capacity: 3,
  refillPerSecond: 1 / 120,
});
/**
 * Keyed by webhook id rather than by caller identity — there is no Clerk
 * session on this path, only the token in the URL, so the webhook itself is
 * the only stable key available. Generous enough for real CI/monitoring
 * traffic (a burst of a build's worth of steps) while still bounding what a
 * leaked token could do.
 */
const webhookExecuteLimiter = createRateLimiter({
  capacity: 20,
  refillPerSecond: 1,
});
/**
 * Filing a report costs a human several seconds of reading a form, so the burst
 * only has to cover somebody reporting a few messages from one spree. This is
 * the per-process half of the limit and is not the ceiling that matters —
 * `REPORTS_PER_HOUR` in services/reports.ts is counted in the database and
 * survives both a restart and a second replica. See the comment there.
 */
const reportLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 0.05 });
/** The settings feedback box — same shape of write as a report, same budget. */
const feedbackLimiter = createRateLimiter({
  capacity: 5,
  refillPerSecond: 0.05,
});
/**
 * BROADCAST_PIPELINE B0.5. Only ~10% of viewers are sampled at all
 * (`isSampledForHlsTelemetry`, client-side), and a sampled viewer flushes at
 * most once per `LIVE_HLS_TELEMETRY_FLUSH_MS` (30s), so even a large party
 * should never come close to this. Roomy enough that a client racing to
 * catch up after a dropped connection (a few queued flushes) is not the thing
 * that trips it; a script pretending to be many viewers from one account is.
 */
const liveHlsTelemetryLimiter = createRateLimiter({
  capacity: 10,
  refillPerSecond: 0.2,
});
/**
 * The same budget as `liveHlsTelemetryLimiter` above, keyed by SESSION
 * instead of by user (a Farol finding, 2026-09-13: the route only capped one
 * caller's own rate, not how much one session's worth of traffic could add
 * up to across many accounts watching the same party). One party with a very
 * large audience still fits comfortably under this: at the 10% sample rate
 * and one flush per `LIVE_HLS_TELEMETRY_FLUSH_MS` (30s), even a thousand
 * sampled viewers average under four batches a second, well inside a refill
 * this roomy. What it bounds is a script hammering ONE session id (real or
 * made up) from many accounts at once, which no ordinary audience does.
 */
const liveHlsTelemetrySessionLimiter = createRateLimiter({
  capacity: 120,
  refillPerSecond: 10,
});
/**
 * Screen-share / watch-party video quality telemetry
 * (`stream-quality-telemetry.ts` in `@pqp/shared`). The client sampler ticks
 * once per `STREAM_QUALITY_TELEMETRY_SAMPLE_INTERVAL_MS` (20s) and only
 * while a screen-share row actually exists, so one caller sending a batch
 * every few seconds is already a script, not a browser doing what this
 * feature asks of it. Capacity gives room for a reconnect to catch up a
 * couple of missed ticks without tripping the limiter on the very next one.
 */
const streamQualityTelemetryLimiter = createRateLimiter({
  capacity: 6,
  refillPerSecond: 0.1,
});
/**
 * How long a signed telemetry batch's `resolveHlsSessionId` lookup may run
 * before the route gives up on it, and how long that session's key is then
 * assumed still struggling before the next batch tries again -- see
 * `hls-telemetry-session-guard.ts`'s own doc comment for the two Farol
 * findings (2026-09-14) this closes. 500ms is generous for a warm cache hit
 * (the common case: the session's own viewers are already polling the
 * master playlist) and still short enough that a stuck pool costs one
 * request, not an open connection held indefinitely. 30s is roughly the
 * time a real outage takes a human to notice on the dashboard, not a number
 * tuned to any specific incident.
 */
const HLS_SESSION_LOOKUP_TIMEOUT_MS = 500;
const HLS_SESSION_LOOKUP_NEGATIVE_CACHE_MS = 30_000;
const hlsSessionLookupGuard = createHlsSessionLookupGuard({
  timeoutMs: HLS_SESSION_LOOKUP_TIMEOUT_MS,
  negativeCacheMs: HLS_SESSION_LOOKUP_NEGATIVE_CACHE_MS,
});
/**
 * Post-call ratings. Roomier than feedback because this one is *asked for*:
 * somebody who genuinely has ten short calls in an evening should be able to
 * answer every prompt, and the client already refuses to ask more than once
 * per call. Tight enough that a script cannot flood the average.
 */
const callRatingLimiter = createRateLimiter({
  capacity: 10,
  refillPerSecond: 0.1,
});
/**
 * The one public, unauthenticated read that answers with a person — see
 * `servePublicProfile`. Its own bucket rather than a share of `anonLimiter`
 * because the claim landing calls it on a debounce while somebody types a
 * handle, so legitimate traffic here is bursty in a way no other public route
 * is. Keyed by address, which is the only key available before auth.
 */
const publicProfileLimiter = createRateLimiter({
  capacity: 60,
  refillPerSecond: 2,
});
/**
 * The public community page's read. Same posture as `publicProfileLimiter` and
 * deliberately its OWN bucket rather than a share of it: the two are reached
 * from different pages by different traffic, and a crawler walking profiles
 * must not be able to spend the budget a community link going around WhatsApp
 * needs. No debounce feeds this one — nothing types a slug the way the claim
 * landing types a handle — so the capacity is the same and the refill is not
 * asked to cover a burst it will never see.
 */
const publicCommunityLimiter = createRateLimiter({
  capacity: 60,
  refillPerSecond: 2,
});
/**
 * Tab-close leave beacon. Unauthenticated on purpose: `pagehide` cannot wait
 * for Clerk, and the resume HMAC is the credential. Own bucket so a flood
 * here cannot spend the public-profile or webhook budgets.
 */
const voiceLeaveLimiter = createRateLimiter({
  capacity: 30,
  refillPerSecond: 2,
});
/**
 * `request` / `withdraw` on a party's guest queue. Same shape as the mute
 * toggle's own limiter (`stateLimiter` in `ws/voice.ts`, capacity 15,
 * refill 3/s) per `docs/RAISED_HANDS.md`'s rule for a self-report of this
 * kind, kept as its own bucket rather than sharing `writeLimiter` because a
 * viewer mashing the button is a UI bug, not an attack, and should not spend
 * the same budget a moderator's bulk delete does.
 */
const guestRequestLimiter = createRateLimiter({
  capacity: 15,
  refillPerSecond: 3,
});
/**
 * Bulk message delete. One call can remove a hundred rows and fan a frame out
 * to everyone in the channel, so it is the most destructive write a moderator
 * has, and the only one whose cost per request is bounded by a *cap* rather
 * than by the caller's patience.
 *
 * A burst of five covers the real shape of a cleanup (sweep, look, sweep the
 * rest, undo nothing because there is no undo) and sustained it is one purge
 * every twenty seconds, which is faster than a person reads a channel and far
 * too slow to empty a busy server with. The global `writeLimiter` still
 * applies underneath. Keyed by user rather than by channel: the thing worth
 * bounding is one account clearing everything it can reach, not one channel
 * being cleaned twice.
 */
const bulkDeleteLimiter = createRateLimiter({
  capacity: 5,
  refillPerSecond: 0.05,
});

export function resetApiRateLimits(): void {
  apiLimiter.reset();
  writeLimiter.reset();
  anonLimiter.reset();
  gifLimiter.reset();
  connectionLimiter.reset();
  desktopHandoffLimiter.reset();
  searchLimiter.reset();
  uploadLimiter.reset();
  homeCommentLimiter.reset();
  homeLikeLimiter.reset();
  homePostLimiter.reset();
  userSearchLimiter.reset();
  exportLimiter.reset();
  discordImportLimiter.reset();
  discordFetchLimiter.reset();
  personalExportLimiter.reset();
  accountDeleteLimiter.reset();
  webhookExecuteLimiter.reset();
  reportLimiter.reset();
  // Declared in the depoimentos section at the foot of this file. Safe to name
  // here: this function only ever runs after module evaluation, so the `const`
  // is out of its temporal dead zone by the time a test calls it.
  depoimentoLimiter.reset();
  publicProfileLimiter.reset();
  publicCommunityLimiter.reset();
  voiceLeaveLimiter.reset();
  guestRequestLimiter.reset();
  bulkDeleteLimiter.reset();
  liveHlsTelemetryLimiter.reset();
  liveHlsTelemetrySessionLimiter.reset();
  hlsSessionLookupGuard.reset();
  streamQualityTelemetryLimiter.reset();
  // Keyed on the string "machine" rather than a user id, so unlike every
  // bucket above it is shared by every test in a file and would otherwise
  // drain across them.
  operatorLimiter.reset();
  musicResolveLimiter.reset();
}

class Forbidden extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

/** Wrap a handler result to answer 201 instead of 200. */
class Created {
  constructor(readonly body: unknown) {}
}

function created(body: unknown): Created {
  return new Created(body);
}

/**
 * Wrap a handler result to send raw bytes with the given content type
 * instead of the usual JSON envelope every other route answers with — a
 * file download rather than API data. Goes through the same router, the
 * same auth, and the same rate limiting as any other route; the client
 * fetches it with `fetch()` (to attach the Bearer token) and turns the
 * response into a Blob, so it is a cross-origin request in prod just like
 * any other `/api/` call and needs the same CORS + security headers —
 * only the final `sendJson` call is skipped, in favor of a raw
 * `res.writeHead`/`res.end` that sets those headers itself.
 */
class RawResponse {
  constructor(
    readonly body: Buffer | string,
    readonly contentType: string,
    readonly filename?: string,
  ) {}
}

class NotFound extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/**
 * An error whose body carries structured fields alongside `error`, for the one
 * refusal a client has to *act* on rather than merely display: account deletion
 * blocked by owned servers needs the list of servers, or the user is told to go
 * fix something without being told which thing.
 *
 * `detail` is merged into the error envelope, so `error` stays exactly where
 * every existing client already looks for it.
 */
class HttpErrorWithDetail extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(status, message);
  }
}

async function requireServerMember(serverId: string, userId: string) {
  const role = await getMemberRole(serverId, userId);
  if (!role) {
    // 404 rather than 403: a non-member should not be able to probe which
    // server ids exist.
    throw new NotFound("Server not found");
  }
  return role;
}

async function requirePermission(
  serverId: string,
  userId: string,
  bit: bigint,
  channelId?: string | null,
): Promise<void> {
  await requireServerMember(serverId, userId);
  if (!(await memberHasPermission(serverId, userId, bit, channelId))) {
    throw new Forbidden("You do not have permission to do that");
  }
}

async function requireAnyPermission(
  serverId: string,
  userId: string,
  bits: bigint[],
): Promise<void> {
  await requireServerMember(serverId, userId);
  for (const bit of bits) {
    if (await memberHasPermission(serverId, userId, bit)) {
      return;
    }
  }
  throw new Forbidden("You do not have permission to do that");
}

async function requireOwner(serverId: string, userId: string) {
  const role = await requireServerMember(serverId, userId);
  if (role !== "owner") {
    throw new Forbidden("Only the owner can do that");
  }
  return role;
}

/**
 * Owners may act on anyone beneath them; admins only on plain members, so an
 * admin can neither depose a peer nor the owner. Returns the target's role, or
 * null when they are not a member at all.
 *
 * `timeout` joins `kick` and `ban` on exactly the same rule, and that is the
 * point of routing it through here rather than writing a second rank check: a
 * temporary sanction is still a sanction, and an admin who could silence a peer
 * for 28 days would have found a way around "an admin cannot kick an admin"
 * that costs the target nearly as much. Self-targeting is refused by the
 * callers, which is where the "use leave instead" style of message belongs.
 */
async function requireOutranked(
  serverId: string,
  actorId: string,
  targetUserId: string,
  action:
    | "kick"
    | "ban"
    | "timeout"
    | "disconnect"
    | "move"
    | "mute"
    | "lower hand",
): Promise<MemberRole | null> {
  const targetRole = await getMemberRole(serverId, targetUserId);
  if (targetRole === "owner") {
    throw new Forbidden(`Cannot ${action} the owner`);
  }
  const actor = await getMemberHierarchy(serverId, actorId);
  const target = targetRole
    ? await getMemberHierarchy(serverId, targetUserId)
    : null;
  if (target && actor && !canActOnMember(actor, target)) {
    throw new Forbidden(`You cannot ${action} that member`);
  }
  return targetRole;
}

async function requireChannel(channelId: string) {
  const channel = await getChannel(channelId);
  if (!channel) {
    throw new NotFound("Channel not found");
  }
  return channel;
}

async function requireChannelAccess(channelId: string, userId: string) {
  const channel = await requireChannel(channelId);
  if (!(await canAccessChannel(channelId, userId))) {
    throw new NotFound("Channel not found");
  }
  return channel;
}

/**
 * A channel that belongs to a server, for the routes that administer one.
 *
 * Every one of them goes on to ask a question about `channel.server_id` — who
 * manages it, who may be added to it — and a conversation has no server to ask
 * about and no managers at all. 404 rather than 400, so a channel id somebody
 * guessed does not get told what kind of thing it is.
 */
async function requireServerChannel(channelId: string) {
  const channel = await requireChannel(channelId);
  if (channel.kind !== "server" || !channel.server_id) {
    throw new NotFound("Channel not found");
  }
  return { ...channel, server_id: channel.server_id };
}

const router = createRouter();

/**
 * The two account-lifecycle routes a character must not reach.
 *
 * `DELETE /api/me` and `GET /api/me/export` exist because a *person* has rights
 * over their own account under LGPD art. 18 — erasure and portability. A
 * character has no person behind it and therefore no such rights, and what the
 * routes would be instead is the worst thing a leaked bearer token could do
 * with one call: erase an account and everything the operator built on it, or
 * walk off with a full dump of every server it is in.
 *
 * Refused rather than made a no-op, because the caller here is an operator's
 * script, not a member of the public — a clear 403 is the answer that gets the
 * mistake fixed. Deleting a character is a database operation
 * (`revokeCharacterAccount`), which is the correct amount of friction for an
 * action with no undo.
 */
function refuseCharacterSelfService(user: DbUser): void {
  if (user.is_character) {
    throw new Forbidden(
      "Character accounts cannot be deleted or exported through the API",
    );
  }
}

// ---------------------------------------------------------------- desktop

/**
 * One-shot Clerk ticket so the Electron shell can adopt a session the user
 * finished in their system browser. Age-gate exempt on purpose: a new sign-up
 * has never seen the dialog, and the ticket only transfers identity.
 */
router.post("/api/desktop/handoff", async ({ req, res, user }) => {
  if (!isClerkUserId(user.clerk_id)) {
    throw new HttpError(403, "Desktop handoff is only for Clerk accounts");
  }
  const key = `user:${user.id}`;
  if (!desktopHandoffLimiter.take(key)) {
    res.setHeader("Retry-After", String(desktopHandoffLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  try {
    const ticket = await createDesktopSignInToken(user.clerk_id);
    const uaRaw = req.headers["user-agent"];
    const ua = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;
    logEvent("desktop.handoff", {
      userId: user.id,
      ip: clientAddress(req as never),
      ua: ua ? ua.slice(0, 200) : undefined,
    });
    return { ticket };
  } catch (error) {
    console.error("[pqp] desktop handoff mint failed", error);
    throw new HttpError(503, "Could not start desktop sign-in");
  }
});

// ---------------------------------------------------------------- profile

/**
 * `toPublicUser` plus the one field only the account's own owner may see that
 * `services/users.ts` cannot compute itself: whether this Clerk id is an
 * instance moderator. Kept here rather than inside `toPublicUser` to avoid a
 * cycle — `reports.ts` (home of `isInstanceModerator`) already imports from
 * `users.ts` for `canAccessChannel`.
 *
 * Every route that hands an account its own `User` shape back — not
 * `toPublicUserSummary`, which strangers see — goes through this, or a
 * moderator's Settings nav loses its "Moderação da instância" door the moment
 * they save any profile field, since `userSchema.isInstanceModerator`
 * defaults `false` when the key is simply missing from the response.
 */
async function toOwnUser(user: DbUser) {
  return {
    ...(await toPublicUser(user)),
    isInstanceModerator: isInstanceModerator(user),
  };
}

router.get("/api/me", async ({ user, ageGate }) => ({
  ...(await toOwnUser(user)),
  // Reachable while the gate is still pending or blocked — it is how the client
  // finds out which of the two it is looking at.
  ageGate,
}));

/**
 * The 18+ declaration. One per account, ever.
 *
 * Answers 200 for *both* outcomes and puts the result in the body, because
 * recording a failing declaration is a successful request: the account has
 * answered, the answer is on file, and the client needs to render the outcome
 * rather than an error. A second attempt is what gets refused, with 409 — and
 * refusing it here is the whole feature. See `recordAgeDeclaration`.
 *
 * A date that is not a real date, or is in the future, is a 400 and does NOT
 * consume the attempt. That is not a loophole: every *plausible* date is final,
 * so there is nothing to probe for.
 */
router.post("/api/me/age-check", async ({ req, user }) => {
  const body = ageDeclarationSchema.parse(await readJsonBody(req));
  const dob = parseCalendarDate(body.dateOfBirth);
  if (!dob || !isPlausibleBirthDate(dob)) {
    throw new HttpError(400, "Enter a valid date of birth.");
  }

  const result = await recordAgeDeclaration(user.id, dob);
  if (!result.recorded) {
    throw new HttpError(
      409,
      "This account has already answered the age question. It cannot be answered again.",
    );
  }
  // Funnel step `age_gate`, stamped only on a PASS. An underage declaration is
  // recorded and final, but it is blocked from the product, so it drops out of
  // the funnel here rather than counting as a passed gate.
  if (result.status === "passed") {
    await recordActivationStep(user.id, "age_gate");
  }
  return { ageGate: result.status };
});

router.patch("/api/me", async ({ req, user, ageGate }) => {
  const body = updateProfileSchema.parse(await readJsonBody(req));
  // BEFORE the profile write, and in its own statement.
  //
  // A handle is the one field on this form that can fail for a reason nothing
  // about this request got wrong — somebody else claimed the word half a second
  // ago. Doing it first means that refusal arrives before the display name and
  // avatar have been written, so the 409 the user sees is a form that did not
  // save rather than a form that half saved. It cannot be folded into
  // `updateProfile` either: that function owns the (username, discriminator)
  // retry loop, and a handle collision must NOT be retried — the whole point of
  // first-come-first-served is that the loser is told, not quietly given
  // `neymar2`.
  //
  // The other order is asymmetric and accepted: a handle that succeeds followed
  // by a `updateProfile` that fails leaves the handle written. That is the
  // cheaper failure by a distance — a claimed handle with an unchanged display
  // name is a working profile, whereas the reverse is a name change that
  // silently discarded the thing the user actually came to do. Making both
  // atomic means one transaction across two services for a form that is saved a
  // handful of times per account, ever.
  if (body.handle !== undefined) {
    await claimHandle(user.id, body.handle);
    // Funnel step `handle`. `claimHandle` threw on a collision or a cooldown,
    // so reaching here means the word is this account's now.
    await recordActivationStep(user.id, "handle");
  }
  // Write-only and first-touch: the service refuses it for an account that
  // already has one, or that is older than a day. Nothing below reads it back,
  // so a refusal is not a failure of this request and is not reported as one.
  if (body.acquisition !== undefined) {
    await recordAcquisition(user.id, body.acquisition);
  }
  const updated = await updateProfile(user.id, {
    displayName: body.displayName,
    username: body.username,
    avatarUrl: body.avatarUrl,
    // Tightening this closes the door on people who have not knocked yet; it
    // deliberately does not touch conversations that are already open.
    dmPrivacy: body.dmPrivacy,
    // Passed straight through, undefined and all. `updateProfile` needs the
    // three-state value intact: absent leaves the recado alone, null clears it.
    customStatus: body.customStatus,
  });
  invalidateUserCache(updated.clerk_id);
  await announceProfile(updated);
  return { ...(await toOwnUser(updated)), ageGate };
});

// ------------------------------------------------------------- avatars
//
// The upload half of a profile picture. The *display* half needs nothing here:
// `users.avatar_url` has always been on the wire and every payload that carries
// a person already carries it, so a claimed avatar reaches message authors,
// member lists, presence, friends, DM summaries and voice rosters through joins
// that were written long before this existed.

/**
 * Mirrors `GET /api/attachments/config`, including that the limits ride along
 * in both states so a picker can reject an over-size file against this
 * deployment's cap rather than discovering it on a 413.
 *
 * `enabled: false` is a whole deployment shape, not an error: with no `S3_*`
 * the upload button is absent and typed URLs and presets still work, which is
 * what avatars were before uploads existed.
 */
router.get("/api/avatars/config", async () => ({
  enabled: isAvatarUploadConfigured(),
  maxBytes: MAX_AVATAR_BYTES,
  size: AVATAR_IMAGE_SIZE,
}));

router.post("/api/me/avatar", async ({ req, res, user }) => {
  if (!isAvatarUploadConfigured()) {
    throw new HttpError(503, "Avatar uploads are not configured on this server");
  }
  const key = `user:${user.id}`;
  if (!uploadLimiter.take(key)) {
    res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const body = createAvatarUploadSchema.parse(await readJsonBody(req));
  // The storage key is generated from the *session's* user id, never from
  // anything on the request — which is also what makes the claim below able to
  // trust a key the client hands back.
  return created(
    createAvatarUpload({
      userId: user.id,
      contentType: body.contentType,
      byteSize: body.byteSize,
    }),
  );
});

/**
 * The bytes are up: make them the avatar.
 *
 * The HEAD happens here and not at mint time for the reason spelled out in
 * `docs/ATTACHMENTS.md` — it is the only thing that tells "never uploaded"
 * apart from "uploaded", and it catches an object stored as something other
 * than the type that was signed. A failure is a 400 rather than a 500: the
 * request named an object that is not there or is not what it claimed, which is
 * something the caller got wrong.
 */
router.post("/api/me/avatar/claim", async ({ req, user }) => {
  if (!isAvatarUploadConfigured()) {
    throw new HttpError(503, "Avatar uploads are not configured on this server");
  }
  const body = claimAvatarSchema.parse(await readJsonBody(req));
  const byteSize = await verifyAvatarObject(user.id, body.key);
  if (byteSize === null) {
    throw new HttpError(400, "That upload could not be verified. Try again.");
  }

  const updated = await updateProfile(user.id, {
    avatarUrl: avatarUrlForKey(user.id, body.key),
    avatarKey: body.key,
  });
  invalidateUserCache(updated.clerk_id);
  await announceProfile(updated);
  return { user: await toOwnUser(updated) };
});

/**
 * Back to the monogram.
 *
 * Not gated on storage being configured, unlike the two above: an account that
 * uploaded an avatar and then lost its bucket must still be able to stop
 * pointing at it. Clearing the columns is a database write and succeeds either
 * way; only the object deletion needs storage, and `updateProfile` treats that
 * as best-effort.
 */
router.delete("/api/me/avatar", async ({ user }) => {
  const updated = await updateProfile(user.id, {
    avatarUrl: null,
    avatarKey: null,
  });
  invalidateUserCache(updated.clerk_id);
  await announceProfile(updated);
  return { user: await toOwnUser(updated) };
});

// ------------------------------------------------------------- user banners
//
// The strip across the top of `pqp.gg/@rafa`. Structurally the avatar routes
// above with three differences and no fourth: a bigger cap, a different pair of
// columns, and NO `announceProfile` — nothing in the app draws somebody else's
// banner, so broadcasting one to every open socket on the instance would be a
// frame no client has a use for.

/**
 * Mirrors `GET /api/avatars/config`, limits in both states so the picker can
 * refuse an over-size file against this deployment's own cap rather than
 * discovering it on a 413. `enabled: false` is a whole deployment shape and not
 * an error: with no `S3_*` there is no banner, and the page draws its generated
 * gradient, which is a design rather than a placeholder.
 */
router.get("/api/me/banner/config", async () => ({
  enabled: isUserBannerUploadConfigured(),
  maxBytes: MAX_USER_BANNER_BYTES,
  width: USER_BANNER_WIDTH,
  height: USER_BANNER_HEIGHT,
}));

router.post("/api/me/banner", async ({ req, res, user }) => {
  if (!isUserBannerUploadConfigured()) {
    throw new HttpError(503, "Banner uploads are not configured on this server");
  }
  const key = `banner:${user.id}`;
  if (!uploadLimiter.take(key)) {
    res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const body = createUserBannerUploadSchema.parse(await readJsonBody(req));
  // The storage key is generated from the SESSION's user id, never from
  // anything on the request — which is also what makes the claim below able to
  // trust a key the client hands back.
  return created(
    createUserBannerUpload({
      userId: user.id,
      contentType: body.contentType,
      byteSize: body.byteSize,
    }),
  );
});

/**
 * The bytes are up: make them the banner.
 *
 * The HEAD happens here and not at mint time for the reason `docs/ATTACHMENTS.md`
 * spells out — it is the only thing that tells "never uploaded" apart from
 * "uploaded", and it catches an object stored as something other than the type
 * that was signed. A failure is a 400: the request named an object that is not
 * there or is not what it claimed, which is something the caller got wrong.
 */
router.post("/api/me/banner/claim", async ({ req, user }) => {
  if (!isUserBannerUploadConfigured()) {
    throw new HttpError(503, "Banner uploads are not configured on this server");
  }
  const body = claimUserBannerSchema.parse(await readJsonBody(req));
  const byteSize = await verifyUserBannerObject(user.id, body.key);
  if (byteSize === null) {
    throw new HttpError(400, "That upload could not be verified. Try again.");
  }

  const updated = await setUserBanner(user.id, {
    url: userBannerUrlForKey(user.id, body.key),
    key: body.key,
  });
  if (!updated) {
    throw new NotFound("User not found");
  }
  // AFTER the write commits, never before: an object deleted first and then
  // rolled back is a picture that renders as a broken frame forever.
  if (updated.previousKey && updated.previousKey !== body.key) {
    void discardBannerObject(updated.previousKey);
  }
  return { user: await toOwnUser(updated.user) };
});

/**
 * Back to the gradient.
 *
 * Not gated on storage being configured, for the reason the avatar delete is
 * not: an account that uploaded a banner and then lost its bucket must still be
 * able to stop pointing at it. Clearing the columns is a database write and
 * succeeds either way; only the object deletion needs storage, and
 * `discardBannerObject` is best-effort.
 */
router.delete("/api/me/banner", async ({ user }) => {
  const updated = await setUserBanner(user.id, null);
  if (!updated) {
    throw new NotFound("User not found");
  }
  if (updated.previousKey) {
    void discardBannerObject(updated.previousKey);
  }
  return { user: await toOwnUser(updated.user) };
});

/**
 * Tell every open client. Kept beside the three writers above rather than
 * inside `updateProfile`, because the service is also what account deletion and
 * the onboarding backfill call, and a broadcast belongs to a request somebody
 * made — not to every write of the row.
 */
async function announceProfile(updated: DbUser): Promise<void> {
  // Awaited, not fire-and-forget: a member-list read that lands right after
  // this request must see the new handle/name/avatar/status, not whatever
  // was cached before it (`services/users.ts`'s `invalidateMemberListsForUser`).
  //
  // The profile row itself is already committed by the time this runs (every
  // caller of `announceProfile` calls it after its own write), so a failure
  // HERE must not turn into a failure response for a mutation that already
  // succeeded — the caller would retry a write that has nothing left to do,
  // and never learn the actual outcome. Logged and swallowed instead: the
  // worst case is a member list serving a stale name/avatar/handle for up to
  // the cache's 30s TTL, the same bound this cache already lives with for
  // every other write it does not explicitly invalidate.
  try {
    await invalidateMemberListsForUser(updated.id);
  } catch (error) {
    console.error(
      "[profile] member-list invalidation failed:",
      updated.id,
      error,
    );
  }
  broadcastProfileUpdate({
    type: "profile-update",
    userId: updated.id,
    displayName: updated.display_name,
    username: updated.username,
    tag: formatUserTag(updated.username, updated.discriminator),
    avatarUrl: updated.avatar_url,
    // Sent on EVERY profile announcement, not only when it changed, and sent as
    // the row's current value rather than as the request's. This frame is an
    // absolute statement about a person, the way a presence delta's `joined`
    // entry is: a receiver applies it whole and never diffs it, so leaving the
    // field off an avatar change would read as "cleared" on the other side.
    customStatus: updated.custom_status ?? null,
  });
  // The frame above repaints chat, the member list and the person's own
  // panel. A call they are already in copied their label when they joined,
  // so without this it keeps showing the old one to everybody in the room.
  void refreshVoiceIdentity(updated.id, {
    display_name: updated.display_name,
    avatar_url: updated.avatar_url,
  });
}

/**
 * Patch semantics: the body carries only what changed, and the response is the
 * whole merged object so the caller never has to guess what the server kept.
 * Keys the schema does not know — audio device ids above all — are dropped
 * before anything is stored.
 */
router.patch("/api/me/preferences", async ({ req, user }) => {
  const patch = userPreferencesSchema.parse(await readJsonBody(req));
  const preferences = await mergePreferences(user.id, patch);
  // `status` is the one preference the realtime layer holds a copy of, because
  // resolving somebody's status must not be a database read — it happens once
  // per member of every member list anyone opens. Adopted only after the write
  // has committed, so the in-memory view can never claim something Postgres
  // refused; and adopted from the *merged* result rather than from the patch, so
  // a request that did not mention `status` cannot silently clear it.
  //
  // This is the only leg that matters for a user who is connected elsewhere
  // right now: their own instance publishes the change onto the cluster bus, and
  // every other instance picks it up from there.
  if (patch.status && preferences.status) {
    applyManualStatus(user.id, preferences.status);
  }
  return { preferences };
});

// ---------------------------------------------------------- connections
//
// Linked Steam / Battle.net / Twitch accounts. Off per provider until that
// provider's env is set, same contract as GIFs and attachments. The OAuth
// callback itself is a SPA route (`/app/connections/callback/:provider`);
// these endpoints are authenticated POSTs that start the hop and finish it.

router.get("/api/connections/config", async () => connectionsConfig());

router.get("/api/me/connections", async ({ user }) => ({
  connections: await listOwnConnections(user.id),
}));

router.post(
  "/api/me/connections/:provider/start",
  async ({ req, res, user }, { provider: raw }) => {
    const provider = parseConnectionProvider(raw);
    if (!isProviderEnabled(provider)) {
      throw new HttpError(503, "That connection is not configured on this server");
    }
    const key = `user:${user.id}`;
    if (!connectionLimiter.take(key)) {
      res.setHeader("Retry-After", String(connectionLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }
    const origin =
      typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    return await startConnection(user, provider, origin);
  },
);

router.post(
  "/api/me/connections/:provider/complete",
  async ({ req, res, user }, { provider: raw }) => {
    const provider = parseConnectionProvider(raw);
    const key = `user:${user.id}`;
    if (!connectionLimiter.take(key, 2)) {
      res.setHeader("Retry-After", String(connectionLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }
    const body = completeConnectionSchema.parse(await readJsonBody(req));
    const connection = await completeConnection(user, provider, body.params);
    return { connection };
  },
);

router.patch(
  "/api/me/connections/:provider",
  async ({ req, user }, { provider: raw }) => {
    const provider = parseConnectionProvider(raw);
    const body = updateConnectionSchema.parse(await readJsonBody(req));
    const connection = await updateConnectionVisibility(
      user,
      provider,
      body.visibility,
    );
    return { connection };
  },
);

router.delete(
  "/api/me/connections/:provider",
  async ({ user }, { provider: raw }) => {
    const provider = parseConnectionProvider(raw);
    await disconnectConnection(user, provider);
    return { ok: true };
  },
);

router.get("/api/users/:userId/connections", async ({ user }, { userId }) => ({
  connections: await listCardConnections(user.id, userId!),
}));

/**
 * Earned marks. These already sit on the unauthenticated public profile, so
 * returning them here is not a relationship leak. Unknown user 404s. Everybody
 * else gets 200, including an empty list. Never 403.
 */
router.get("/api/users/:userId/achievements", async (_ctx, { userId }) => {
  if (!(await getUserById(userId!))) {
    throw new NotFound("User not found");
  }
  return { achievements: await listUserAchievements(userId!) };
});

// --------------------------------------------- LGPD art. 18 (own account)

/**
 * Everything this service holds about the caller, as a JSON file (art. 18, II
 * and V).
 *
 * NOT `/api/servers/:id/export`. That one is a server owner's tool and contains
 * every member's messages; this one is scoped to one person and deliberately
 * excludes other people's content, including the other half of every DM. The
 * reasoning for that exclusion is written out at length on `EXPORT_NOTES` in
 * services/account.ts, and restated inside the file itself so the person
 * reading the export knows what is not in it.
 *
 * Scoped by `user.id` from the resolved session and by nothing the caller sends
 * — there is no `:userId` to get wrong, which is what makes "export somebody
 * else" unrepresentable rather than merely refused.
 *
 * Not audit-logged, unlike the server export. An audit entry is server-scoped
 * (`audit_log.server_id` is NOT NULL) and this read belongs to no server; more
 * to the point, logging that a named person exercised a privacy right, in a log
 * their own server admins can read, would be its own small disclosure.
 */
router.get("/api/me/export", async ({ user, res }) => {
  refuseCharacterSelfService(user);
  const key = `user:${user.id}`;
  if (!personalExportLimiter.take(key)) {
    res.setHeader("Retry-After", String(personalExportLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const data = await buildPersonalExport(user.id);
  if (!data) {
    throw new NotFound("Account not found");
  }

  // A display name is fully user-controlled and may sanitize down to nothing —
  // a filename of `pqp-my-data-server-…` would be nonsense, so the fallback is
  // named for what this file actually is.
  const filename = `pqp-my-data-${sanitizeFilenameSegment(
    data.account.username ?? data.account.displayName,
    "account",
  )}-${data.exportedAt.slice(0, 10)}.json`;
  return new RawResponse(
    JSON.stringify(data, null, 2),
    "application/json",
    filename,
  );
});

/**
 * Delete your own account (art. 18, IV and VI). Irreversible, and real — there
 * is no soft-delete flag anywhere in this path.
 *
 * `confirm` must carry the account's own handle. A destructive, unrecoverable
 * action must not be one stray `fetch` away, and this is the only action in the
 * product with no owner, moderator or backup on the other side to undo it.
 *
 * Three refusals, each of which the client renders as a distinct screen:
 *
 * - **400** — the confirmation does not match. Says what to type.
 * - **409** — the caller owns servers other people are in, listed by name in
 *   `servers`. `code` is machine-readable so the client can offer the two
 *   remedies (transfer, or delete the server) inline rather than printing a
 *   sentence and leaving the user to find Server Settings. See
 *   `listBlockingOwnedServers` for why this refuses instead of choosing.
 * - **502** — Clerk would not delete the identity. Nothing local was touched;
 *   retrying is safe and is what the client tells the user to do.
 */
router.delete("/api/me", async ({ req, res, user }) => {
  refuseCharacterSelfService(user);
  const key = `user:${user.id}`;
  if (!accountDeleteLimiter.take(key)) {
    res.setHeader("Retry-After", String(accountDeleteLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const body = deleteAccountSchema.parse(await readJsonBody(req));
  const tag = formatUserTag(user.username, user.discriminator);
  if (!deleteConfirmationMatches(body.confirm, tag)) {
    throw new HttpError(
      400,
      `Type ${expectedDeleteConfirmation(tag)} to confirm.`,
    );
  }

  let result;
  try {
    result = await deleteAccount(user.id, user.clerk_id);
  } catch (error) {
    if (error instanceof OwnedServersBlockDeletionError) {
      throw new HttpErrorWithDetail(409, error.message, {
        code: "owned_servers",
        servers: error.servers,
      });
    }
    if (error instanceof IdentityDeletionFailedError) {
      console.error("[account] Clerk deletion failed:", error.cause);
      throw new HttpError(
        502,
        "Could not reach the sign-in provider. Nothing was deleted — please try again.",
      );
    }
    throw error;
  }

  // The account is gone from the database, but its live sockets are not: a
  // WebSocket authenticates once at connect and never re-checks, so without
  // this the deleted user keeps receiving message bodies until they happen to
  // disconnect. `deleteAccount` (services/account.ts) already closed every
  // chat socket for this account on this instance AND, with `CLUSTER_BUS` on,
  // published an eviction that every other instance applies too — see
  // `evictUserAcrossCluster` in auth/clerk.ts. Voice seats are a separate
  // registry with its own cross-instance story (`VOICE_REGISTRY`); this call
  // is still process-local for that part.
  evictVoiceUser(user.id);

  // Nothing names these objects any more — the rows that did cascaded away with
  // the account, so the hourly orphan sweeper will never see them.
  deleteObjectsInBackground(result.attachmentKeys);

  return { ok: true };
});

/**
 * Terminate somebody else's account. The Tier 0 tool.
 *
 * `DELETE /api/me` is self-serve: it authenticates *as* the account being
 * deleted and there is no way to aim it at anyone else, so terminating an
 * account for CSAM or a credible threat was manual SQL — the one action the
 * runbook demands be immediate, done by hand, at 3am, against production.
 * `deleteAccount` has been a correctly-ordered, tested implementation of that
 * sequence for a while; this is the route in front of it.
 *
 * GATED ON `isInstanceModerator`, AND ON NOTHING ELSE. Deliberately not a server
 * role: destroying an account reaches every server that account is in and every
 * conversation it is part of, and no server owner has standing over any of that.
 * The reasoning is identical to the instance report queue's, which is why it
 * reuses the same predicate — `INSTANCE_MODERATOR_CLERK_IDS`, operator
 * configuration, not something any in-app action can grant. With the variable
 * unset there are no instance moderators and this route does not exist for
 * anybody, which is the right default for a self-hosted instance.
 *
 * 404 rather than 403 for an unauthorized caller, same as the instance queue:
 * whether this deployment has operators at all is not a fact to confirm.
 *
 * WHAT IT DOES NOT DO, and this is the important part: it applies exactly the
 * same rules as self-serve deletion, including the refusal when the target owns
 * a server other people are in. That refusal is not a formality — `servers.owner_id`
 * cascades, so overriding it would destroy every message every other member of
 * that server ever wrote in order to remove one person. An operator dealing
 * with a Tier 0 account that owns a populated server has to transfer or delete
 * that server first, as a separate deliberate act. The 409 names the servers.
 */
router.delete("/api/admin/users/:userId", async ({ user, res }, { userId }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  if (userId === user.id) {
    // Not a safety rule so much as an honesty one: an operator deleting their
    // own account should go through the confirmation flow that asks them to
    // type their handle, not through the one built for acting on somebody else.
    throw new HttpError(400, "Use DELETE /api/me to delete your own account");
  }

  const key = `user:${user.id}`;
  if (!accountDeleteLimiter.take(key)) {
    res.setHeader("Retry-After", String(accountDeleteLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const target = await getUserById(userId!);
  if (!target) {
    throw new NotFound("User not found");
  }

  let result;
  try {
    result = await deleteAccount(target.id, target.clerk_id);
  } catch (error) {
    if (error instanceof OwnedServersBlockDeletionError) {
      throw new HttpErrorWithDetail(409, error.message, {
        code: "owned_servers",
        servers: error.servers,
      });
    }
    if (error instanceof IdentityDeletionFailedError) {
      console.error("[account] operator deletion, Clerk refused:", error.cause);
      throw new HttpError(
        502,
        "Could not reach the sign-in provider. Nothing was deleted — please try again.",
      );
    }
    throw error;
  }

  // Same eviction as `DELETE /api/me` — `deleteAccount` already closed this
  // account's chat sockets cluster-wide. Voice seats stay process-local here,
  // same caveat as above.
  evictVoiceUser(target.id);
  deleteObjectsInBackground(result.attachmentKeys);

  // No audit entry, and that is not an oversight: `audit_log` is server-scoped
  // (`server_id` is NOT NULL) and an account termination belongs to no server.
  // It is logged to stderr instead, which is where an instance-level action
  // with no instance-level log has to go until one exists — see the note in
  // docs/TRUST_AND_SAFETY.md §3.3.
  console.warn(
    `[moderation] account ${target.id} terminated by operator ${user.clerk_id}`,
  );

  return { ok: true };
});

/**
 * Signups by campaign source, for the operator. Same gate as the route above,
 * same 404 for everybody else. `?days=` bounds the window (default 30, at most
 * 90) and that is the only input. Read-only, aggregate, never a list of
 * people: the rows are (source, medium, campaign, count). See
 * services/acquisition.ts. Deliberately NOT on the status page, which carries
 * no user counts of any kind.
 */
router.get("/api/admin/acquisition", async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return acquisitionReport(clampLimit(url.searchParams.get("days"), 30, 90));
});

/**
 * The two shapes of the occupancy history, from one query string.
 *
 * `?day=YYYY-MM-DD` wins over `?days=`: asking for one day and a range at the
 * same time is a mistake, and the narrower request is the one somebody typed
 * on purpose. A malformed `day` is dropped rather than 400'd, so a bookmarked
 * link with a stale parameter falls back to the default range instead of an
 * error page on a dashboard.
 */
export function occupancyQuery(params: URLSearchParams): {
  days: number;
  day: string | null;
} {
  return {
    days: clampOccupancyDays(params.get("days")),
    day: parseOccupancyDay(params.get("day")),
  };
}

/**
 * Daily peak occupancy, split by media path. The dashboard's chart.
 *
 * Same two ways in as `/api/admin/metrics`: an instance moderator's session
 * here, and the machine token in `handleApi` ahead of Clerk resolution.
 */
router.get(ADMIN_VOICE_OCCUPANCY_PATH, async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return voiceOccupancyReport(occupancyQuery(url.searchParams));
});

/**
 * Aggregate counts for the operator dashboard. Same gate, same 404. The other
 * way in, a machine token, is resolved in `handleApi` before Clerk runs, so
 * this handler only ever sees a signed-in moderator. See services/metrics.ts
 * for what the payload carries and what it deliberately does not.
 */
router.get(ADMIN_METRICS_PATH, async ({ user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return getAdminMetrics();
});

// ------------------------------------------------- the operator's two levers
//
// Watch party availability per server, and a voice channel's transport pin.
// Same gate and the same two ways in as the reads above: an instance
// moderator's Clerk session here, or the dashboard's machine token, resolved
// in `handleApi` against `ADMIN_MACHINE_ROUTES` before Clerk runs.
//
// These are the FIRST WRITES on that token. What each one costs when it is
// wrong is argued in services/operator.ts; the short version is that neither
// is destructive and both are one click to undo, so neither carries a
// server-side confirmation. The one genuinely disruptive case, turning a
// server off while it is streaming to an audience, is confirmed in the
// dashboard, which is the only place that knows a human is about to do it.

router.get(OPERATOR_SERVERS_PATH, async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return listOperatorServers(url.searchParams.get("q") ?? "");
});

router.get(OPERATOR_CHANNELS_PATH, async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return operatorChannels(url.searchParams.get("serverId"));
});

router.put(OPERATOR_SERVER_LIVE_HLS_PATH, async ({ req, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  const body = setServerLiveHlsSchema.parse(await readJsonBody(req));
  return operatorSetServerLiveHls(body.serverId, body.enabled, user.id);
});

router.put(OPERATOR_CHANNEL_TRANSPORT_PATH, async ({ req, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  const body = setChannelVoiceTransportSchema.parse(await readJsonBody(req));
  return operatorSetChannelTransport(body.channelId, body.transport, user.id);
});

/**
 * EVERYTHING the operator dashboard's machine token can reach, and nothing
 * else, as a flat table of exact (method, pathname) pairs.
 *
 * This is the entire blast radius of `ADMIN_METRICS_TOKEN`. It is a table
 * rather than a chain of `if`s so that adding a route is a visible line in a
 * diff and widening the token by accident is not a thing a refactor can do:
 * there is no pattern here to loosen, no prefix to extend, and a path that is
 * not spelled out below falls through to the ordinary Clerk resolution and
 * ends in the same 404 as a route that does not exist.
 *
 * `DELETE /api/admin/users/:id` is the reason this shape matters. It is on
 * the same `isInstanceModerator` gate as the reads above and is deliberately
 * absent here: terminating somebody's account is not something a token in a
 * Cloudflare Worker behind an HTTP Basic password gets to do.
 *
 * The machine caller has no account, so every write it makes is audited with
 * a NULL actor. See services/operator.ts.
 */
const ADMIN_MACHINE_ROUTES: {
  method: string;
  path: string;
  run: (req: IncomingMessage, query: URLSearchParams) => Promise<unknown>;
}[] = [
  {
    method: "GET",
    path: ADMIN_METRICS_PATH,
    run: async () => getAdminMetrics(),
  },
  {
    method: "GET",
    path: ADMIN_VOICE_OCCUPANCY_PATH,
    run: async (_req, query) => voiceOccupancyReport(occupancyQuery(query)),
  },
  {
    method: "GET",
    path: OPERATOR_SERVERS_PATH,
    run: async (_req, query) => listOperatorServers(query.get("q") ?? ""),
  },
  {
    method: "GET",
    path: OPERATOR_CHANNELS_PATH,
    run: async (_req, query) => operatorChannels(query.get("serverId")),
  },
  {
    method: "PUT",
    path: OPERATOR_SERVER_LIVE_HLS_PATH,
    run: async (req) => {
      const body = setServerLiveHlsSchema.parse(await readJsonBody(req));
      return operatorSetServerLiveHls(body.serverId, body.enabled, null);
    },
  },
  {
    method: "PUT",
    path: OPERATOR_CHANNEL_TRANSPORT_PATH,
    run: async (req) => {
      const body = setChannelVoiceTransportSchema.parse(await readJsonBody(req));
      return operatorSetChannelTransport(body.channelId, body.transport, null);
    },
  },
];

export function matchAdminMachineRoute(
  method: string,
  pathname: string,
): (typeof ADMIN_MACHINE_ROUTES)[number] | null {
  return (
    ADMIN_MACHINE_ROUTES.find(
      (route) => route.method === method && route.path === pathname,
    ) ?? null
  );
}

/**
 * The machine caller's request budget, keyed on the caller rather than on an
 * identity it does not have. Wide enough for a dashboard that polls every 30
 * seconds and an operator clicking, narrow enough that a runaway loop in the
 * page is a 429 rather than a load test against production.
 */
const operatorLimiter = createRateLimiter({
  capacity: limitFromEnv("RATE_LIMIT_OPERATOR_CAPACITY", 60),
  refillPerSecond: limitFromEnv("RATE_LIMIT_OPERATOR_REFILL", 1),
});

/**
 * The four handlers, once, so the session route above and the machine-token
 * dispatch below cannot drift. Every one of them turns a missing target into
 * the same 404 the router would have produced.
 */
async function operatorChannels(serverId: string | null) {
  if (!serverId) {
    throw new HttpError(400, "serverId is required");
  }
  const list = await listOperatorChannels(serverId);
  if (!list) {
    throw new NotFound("Server not found");
  }
  return list;
}

async function operatorSetServerLiveHls(
  serverId: string,
  enabled: boolean | null,
  actorId: string | null,
) {
  try {
    return await setServerLiveHls(serverId, enabled, actorId);
  } catch (error) {
    if (error instanceof OperatorTargetMissing) {
      throw new NotFound(error.message);
    }
    throw error;
  }
}

async function operatorSetChannelTransport(
  channelId: string,
  transport: "mesh" | "livekit" | null,
  actorId: string | null,
) {
  try {
    return await setChannelVoiceTransport(channelId, transport, actorId);
  } catch (error) {
    if (error instanceof OperatorTargetMissing) {
      throw new NotFound(error.message);
    }
    throw error;
  }
}

// --------------------------------------------------------- user discovery

/**
 * Both discovery routes share one bucket, because they are one surface: an
 * attacker enumerating the directory does not care which of the two answers.
 */
function requireDiscoveryBudget(ctx: RequestContext): void {
  const key = `user:${ctx.user.id}`;
  if (!userSearchLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(userSearchLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
}

/**
 * Exact handle lookup — how you reach somebody who told you their tag.
 *
 * Answers 404 for a handle nobody holds, which is not a leak: the caller
 * already had to know both the name and the four digits, and that is the whole
 * point of the number.
 */
router.get("/api/users/lookup", async (ctx) => {
  requireDiscoveryBudget(ctx);
  const parsed = parseUserTag(ctx.url.searchParams.get("tag") ?? "");
  if (!parsed) {
    throw new HttpError(400, "Use the form name#1234");
  }
  const found = await findUserByTag(
    parsed.username,
    parsed.discriminator,
    ctx.user.id,
  );
  if (!found) {
    throw new NotFound("User not found");
  }
  return { user: found };
});

/**
 * Resolve a public handle to the account behind it. SIGNED-IN CALLERS ONLY.
 *
 * This is the second half of `pqp.gg/@rafa` → "Me adiciona no pqp". The public
 * profile endpoint deliberately carries no user id — a stranger needs a name and
 * a picture, not an identifier they can feed to `POST /api/friends` — so the
 * add-intent stashed through the Clerk round trip arrives holding a handle and
 * nothing else. This is where it becomes somebody.
 *
 * It adds NO discovery surface: same `userSearchLimiter` bucket as the tag
 * lookup and the prefix search (they are one surface — see
 * `requireDiscoveryBudget`), same narrow `publicUserSchema` body, and the same
 * `discoverableSql` rule, which is what keeps a character account from being
 * reachable by anyone who read its handle off a screenshot.
 */
router.get("/api/users/by-handle/:handle", async (ctx, { handle }) => {
  requireDiscoveryBudget(ctx);
  const userId = await findUserIdByHandle(handle!);
  if (!userId) {
    throw new NotFound("User not found");
  }
  const found = await findUserById(userId, ctx.user.id);
  if (!found) {
    throw new NotFound("User not found");
  }
  return { user: found };
});

/**
 * Prefix search over handles.
 *
 * Every row is `publicUserSchema` and nothing wider — this is the one place the
 * product hands a user to somebody they share nothing with, so the narrow shape
 * is the feature's safety story rather than a nicety. `clerkId` in particular
 * must never travel here; `toPublicUser` includes it and is the wrong function
 * for this route.
 */
router.get("/api/users/search", async (ctx) => {
  requireDiscoveryBudget(ctx);
  const query = userSearchQuerySchema.safeParse(
    (ctx.url.searchParams.get("q") ?? "").trim(),
  );
  if (!query.success) {
    throw new HttpError(400, "Invalid search query");
  }
  return {
    users: await searchUsersByPrefix(
      query.data,
      ctx.user.id,
      USER_SEARCH_PAGE_SIZE,
    ),
  };
});

// ------------------------------------------------------------------ blocks

router.get("/api/blocks", async ({ user }) => ({
  blocked: await listBlocks(user.id),
}));

router.post("/api/blocks", async ({ req, user }) => {
  const body = createBlockSchema.parse(await readJsonBody(req));
  if (!(await getUserById(body.userId))) {
    throw new NotFound("User not found");
  }
  try {
    const added = await blockUser(user.id, body.userId);
    // Blocking somebody you already blocked is not an error and not a new
    // block, so it answers 200 while the first one answers 201.
    return added ? created({ ok: true }) : { ok: true };
  } catch (error) {
    if (error instanceof SelfBlockError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
});

router.delete("/api/blocks/:userId", async ({ user }, { userId }) => {
  await unblockUser(user.id, userId!);
  return { ok: true };
});

// ----------------------------------------------------------- conversations

router.get("/api/dms", async ({ user }) =>
  etagged({ conversations: await listConversations(user.id) }),
);

/**
 * Open a conversation. 201 when one was created, 200 when an existing 1:1 was
 * handed back — the idempotency `dm_pairs` exists to provide.
 *
 * Every refusal answers with the same message. Distinguishing "they blocked
 * you" from "their privacy setting refuses you" would turn this route into an
 * oracle that reports, for any account, whether that specific person has
 * blocked you — which is precisely what somebody working around a block probes
 * for.
 */
router.post("/api/dms", async ({ req, user }) => {
  const body = createDmSchema.parse(await readJsonBody(req));
  try {
    const opened = await openConversation(user.id, body.userIds);
    const conversation = await getConversation(opened.channelId, user.id);
    if (!conversation) {
      throw new HttpError(500, "Conversation vanished after being opened");
    }
    return opened.created ? created({ conversation }) : { conversation };
  } catch (error) {
    if (error instanceof DmRefusedError) {
      throw new Forbidden("Cannot open a conversation with this user");
    }
    throw error;
  }
});

/**
 * Close a conversation — hide, never delete. Only the caller's own membership
 * goes; the channel, its history and the other participant are untouched, and a
 * 1:1 comes back the moment either side says something in it.
 */
router.delete("/api/dms/:channelId", async ({ user }, { channelId }) => {
  if (!(await hideConversation(channelId!, user.id))) {
    throw new NotFound("Conversation not found");
  }
  // Dropping the membership row is not enough: `broadcastToChannel` fans out on
  // the socket's `channelId`, which is still set from the earlier join-channel,
  // and the client sends no leave frame on this path. Without this eviction
  // somebody who closes a conversation — or leaves a group — keeps receiving
  // its message bodies, reactions and typing frames for the life of the socket.
  // Only the caller's own view goes; the other participants did not leave.
  evictChannelViewers(channelId!, { onlyUserIds: [user.id] });
  return { ok: true };
});

// ------------------------------------------------------------------ voice

router.get("/api/ice-servers", async () => ({
  iceServers: await getIceServers(),
}));

router.get("/api/voice/backend", async () => {
  const backend = getServerVoiceBackend();
  return {
    backend: backend === "livekit" && !isLiveKitConfigured() ? "mesh" : backend,
  };
});

// `?serverId=` answers for that server (its `live_hls_enabled` row, else the
// allowlist); without it, the global flag, which is what a client asks before
// it knows the server. Read per request, so an operator flipping a server on
// the dashboard is answered correctly by the very next call.
router.get("/api/live-hls/config", async ({ url }) =>
  liveHlsConfigForServer(url.searchParams.get("serverId")),
);

/**
 * The signed playlist proxy (`hls-playlist-proxy.ts`): rewrites the live
 * playlist's segment lines into absolute presigned URLs on every request, so
 * the bucket can stay fully private. Auth is the normal Bearer flow (CLAUDE.md
 * pitfall #8) plus the same channel-access check every other voice route
 * uses -- a viewer who cannot see the channel cannot watch its stream either.
 *
 * The same path also answers WITHOUT a header when the URL carries a valid
 * per-viewer `?t=` token (Safari's native player, iOS): that branch lives in
 * `handleApi`, ahead of the Bearer resolution, and ends in this same
 * function, so the channel-access check runs on both.
 */
/**
 * The `?t=` door on the playlist proxy, in ONE place so its two callers
 * cannot drift.
 *
 * Called with no `Authorization` header at all (Safari's native player, iOS),
 * and again after a Bearer header has failed to resolve, which is the shape
 * hls.js produces once a minute when its cached Clerk JWT has just expired.
 * Returns true when it answered the request.
 */
async function tryHlsCapabilityDoor(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = HLS_PLAYLIST_PATH.exec(pathname);
  if (!match) {
    return false;
  }
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    HLS_VIEWER_TOKEN_PARAM,
  );
  const channelId = match[1]!;
  const startedAt = Number(match[2]);
  const viewer = resolveHlsPlaylistViewer({
    bearerUserId: null,
    token,
    channelId,
    startedAt,
  });
  if (!viewer) {
    // Say why before handing back to the 401. A rejection here used to be
    // completely silent, which is why an afternoon went into finding one.
    logHlsPlaylistRejection(
      channelId,
      startedAt,
      token,
      req.headers.authorization,
    );
    return false;
  }
  await serveHlsPlaylistWithToken(
    req,
    res,
    channelId,
    match[2]!,
    viewer.userId,
    viewer.issuedAt ?? 0,
    { rung: match[3], token },
  );
  return true;
}

/**
 * A PLAYLIST REJECTION HAS TO SAY WHY.
 *
 * The proxy answered 401 and logged nothing, so a stall that hit every web
 * viewer of every watch party looked, from the server, exactly like a healthy
 * stream. It took an afternoon and a screenshot of Rafael's network panel to
 * find that hls.js was attaching an expired Clerk JWT on top of a perfectly
 * good `?t=`. One log line would have taken minutes.
 *
 * RATE LIMITED, because this sits on a path every viewer hits every two
 * seconds and a broken client must not be able to turn its own bug into a
 * write amplifier on the log shipper. One line per channel per reason per
 * window is enough to tell an operator what is happening; the counter says
 * how much of it there was.
 */
const HLS_REJECTION_LOG_WINDOW_MS = 30_000;
const hlsRejectionLog = new Map<string, { at: number; since: number }>();

function logHlsPlaylistRejection(
  channelId: string,
  startedAt: number,
  token: string | null,
  authorization: string | undefined,
): void {
  const reason = describeHlsViewerToken(token, { channelId, startedAt });
  if (reason === null) {
    // The capability verified, so this is not a rejection at all: the caller
    // took the door. Nothing to say.
    return;
  }
  // Counted BEFORE the per-channel/per-reason log suppression below, so the
  // metric is a true count of every rejection even during a rolling `expired`
  // wave (pitfall 16), which is the shape the log is rate-limited against.
  noteHlsPlaylistRejected(reason);
  const key = `${channelId}:${reason}`;
  const now = Date.now();
  const seen = hlsRejectionLog.get(key);
  if (seen && now - seen.at < HLS_REJECTION_LOG_WINDOW_MS) {
    seen.since += 1;
    return;
  }
  logEvent("voice.hlsPlaylistRejected", {
    channelId,
    startedAt,
    reason,
    // Whether the caller ALSO sent a header, which is the difference between
    // "a player that cannot authenticate" and "a player whose header is the
    // thing that failed". The header itself is never logged.
    hadAuthorizationHeader: Boolean(authorization),
    suppressed: seen?.since ?? 0,
  });
  hlsRejectionLog.set(key, { at: now, since: 0 });
}

async function hlsPlaylistResponse(
  res: ServerResponse,
  channelId: string,
  startedAt: string,
  userId: string,
  /**
   * When the caller proved themselves with a `?t=` token, the instant it was
   * minted. That token was issued only after a real access check, so it IS
   * the permission and this request asks the database NOTHING. Null means
   * header-only, which proves identity but not access, so that caller still
   * pays for the check.
   */
  tokenIssuedAt: number | null,
  /**
   * Which rendition of a ladder is being asked for. Absent means the caller
   * asked for the SESSION, which is the master playlist listing them all.
   */
  options: { rung?: string; token?: string | null } = {},
): Promise<RawResponse> {
  if (tokenIssuedAt === null) {
    await requireChannelAccess(channelId, userId);
  } else if (isHlsAccessRevoked(userId, channelId, tokenIssuedAt)) {
    // A ban, a kick or a role losing VIEW since the token was minted. A
    // memory lookup, not a query: this runs on every playlist fetch.
    throw new NotFound("Channel not found");
  }
  const parsedStartedAt = Number(startedAt);
  if (!Number.isFinite(parsedStartedAt)) {
    throw new NotFound("No live stream for this channel");
  }
  let body: string;
  // No rung named: this is the session URL a viewer was handed, which is the
  // MASTER playlist when the session ran a ladder. A session with no rung
  // rows predates the ladder and still has a single media playlist of its
  // own, so it falls through to the same call it always made.
  if (!options.rung) {
    const master = await buildMasterPlaylistFor({
      channelId,
      startedAt: parsedStartedAt,
      userId,
      token: options.token,
    });
    if (master !== null) {
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Authorization");
      return new RawResponse(master, "application/vnd.apple.mpegurl");
    }
  }
  try {
    body = await buildSignedPlaylist(channelId, parsedStartedAt, options.rung);
  } catch (error) {
    if (error instanceof HlsPlaylistNotFound) {
      throw new NotFound("No live stream for this channel");
    }
    if (error instanceof HlsPlaylistUnavailable) {
      throw new HttpError(503, "Live HLS storage unavailable");
    }
    throw error;
  }
  // Not even one second. `AVPlayer` treats `max-age` as permission to replay
  // a live playlist it already has, and a ten second window replayed is a
  // playhead sitting on segments the bucket has already deleted. hls.js
  // busts this on its own; the phone does not. `private` plus `Vary` still
  // because the Bearer form of this request is the SAME URL for every
  // viewer and only the header tells them apart. The real saving is the
  // per-session render cache in `hls-playlist-proxy.ts`.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization");
  // BROADCAST_PIPELINE B0.3: how stale, in milliseconds, the freshest
  // segment in this render already was when it was signed -- the T5-T6 span
  // ("in the bucket, to listed in the playlist a viewer polls"), which is the
  // one nothing watched before this. Read from the SAME render just above,
  // so it reflects this exact response body. Not a viewer-facing number: no
  // UI reads this header, only telemetry and an operator's network panel.
  const ageMs = hlsPlaylistAgeMs(channelId, parsedStartedAt, options.rung);
  if (ageMs !== null) {
    res.setHeader("X-Pqp-Playlist-Age-Ms", String(ageMs));
  }
  return new RawResponse(body, "application/vnd.apple.mpegurl");
}

/**
 * The session URL, which is the master playlist once a ladder ran, and the
 * one rendition a pre-ladder session had otherwise.
 */
router.get(
  "/api/voice/hls-playlist/:channelId/:startedAt",
  async ({ user, res, url }, { channelId, startedAt }) =>
    hlsPlaylistRouteResponse(res, url, user.id, channelId!, startedAt!),
);

/**
 * One rendition of a ladder. The master playlist above points at these, and
 * they are what actually carry segments; a viewer's player switches between
 * them without ever coming back through the master.
 */
router.get(
  "/api/voice/hls-playlist/:channelId/:startedAt/:rung",
  async ({ user, res, url }, { channelId, startedAt, rung }) =>
    hlsPlaylistRouteResponse(res, url, user.id, channelId!, startedAt!, rung!),
);

function hlsPlaylistRouteResponse(
  res: ServerResponse,
  url: URL,
  bearerUserId: string,
  channelId: string,
  startedAt: string,
  rung?: string,
): Promise<RawResponse> {
  // hls.js sends BOTH the header and the token. Preferring the token here
  // is what takes the common case off the database: without it every
  // browser viewer still cost an access check every 2 seconds.
  const token = url.searchParams.get(HLS_VIEWER_TOKEN_PARAM);
  const viewer = resolveHlsPlaylistViewer({
    bearerUserId,
    token,
    channelId,
    startedAt: Number(startedAt),
  });
  return hlsPlaylistResponse(
    res,
    channelId,
    startedAt,
    viewer?.userId ?? bearerUserId,
    viewer?.issuedAt ?? null,
    { rung, token },
  );
}

// The rung is optional: without it the path names the session (the master
// playlist), with it one rendition. The viewer token is bound to
// { user, channel, startedAt } and so authorises both.
const HLS_PLAYLIST_PATH =
  /^\/api\/voice\/hls-playlist\/([^/]{1,64})\/(\d{1,20})(?:\/([A-Za-z0-9]{1,16}))?$/;

/**
 * The header-less half of the playlist proxy. Only reached when the request
 * has no `Authorization` header and the `?t=` token verifies for exactly
 * this channel and session (`resolveHlsPlaylistViewer`); anything else falls
 * through to the ordinary Bearer resolution and its 401. The verified user
 * then goes through the same channel-access check and rate limit as a
 * Bearer caller.
 */
async function serveHlsPlaylistWithToken(
  req: IncomingMessage,
  res: ServerResponse,
  channelId: string,
  startedAt: string,
  userId: string,
  tokenIssuedAt: number,
  options: { rung?: string; token?: string | null } = {},
): Promise<void> {
  if (!apiLimiter.take(`user:${userId}`)) {
    res.setHeader("Retry-After", String(apiLimiter.retryAfter(`user:${userId}`)));
    sendError(res, 429, "Too many requests", req);
    return;
  }
  try {
    const result = await hlsPlaylistResponse(
      res,
      channelId,
      startedAt,
      userId,
      tokenIssuedAt,
      options,
    );
    res.writeHead(200, {
      "content-type": result.contentType,
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
    });
    res.end(result.body);
  } catch (error) {
    // Reached only when the playlist proxy's own stale-cache fallback
    // (`renderCachedPlaylist` / `sessionRungs` in hls-playlist-proxy.ts)
    // had nothing to fall back to — a viewer's very first request for a
    // session while the breaker is open. Every subsequent poll for the same
    // session serves the cached window instead of reaching here.
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return;
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return;
    }
    console.error("[voice] hls playlist (token) failed:", error);
    sendError(res, 500, "Internal server error", req);
  }
}

/**
 * Host acknowledgment sheet: "you are responsible for what you stream".
 * `GET` tells the client whether to show it before the presenter starts
 * sharing; `POST` records the confirm so it never shows again for that
 * user+server pair.
 */
router.get(
  "/api/voice/hls-host-ack/:serverId",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    return { acknowledged: await hasAcknowledgedHlsHost(user.id, serverId!) };
  },
);

router.post(
  "/api/voice/hls-host-ack/:serverId",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    await acknowledgeHlsHost(user.id, serverId!);
    return { acknowledged: true };
  },
);

router.post("/api/voice/token", async ({ req, user }) => {
  if (!isLiveKitConfigured()) {
    throw new HttpError(503, "SFU backend not configured");
  }
  const body = voiceSessionRequestSchema.parse(await readJsonBody(req));

  // The peer id must be a live peer owned by this user, in this channel —
  // otherwise a caller could mint a token impersonating someone else. Three
  // proofs, in order of cost:
  //
  // 1. The resume HMAC, if the client sent one. `welcome` minted it for
  //    exactly { user, peer, channel }, so a valid one is sufficient on its
  //    own and needs no lookup at all. This is the proof that works when the
  //    request lands on an API instance that never saw the join (HTTP is
  //    balanced per request; the socket is on one machine).
  // 2. This instance's peer map: exact for anybody whose socket is here, and
  //    the whole story on a single machine. Old clients without the field
  //    keep working through it.
  // 3. The `voice_peers` row, when VOICE_REGISTRY is on: the peer is real but
  //    its socket is elsewhere.
  //
  // The display name is resolved here rather than copied from the peer, so
  // every proof yields the same name the join would have.
  const proven =
    verifyVoiceResumeToken(body.resumeToken, {
      userId: user.id,
      peerId: body.peerId,
      voiceChannelId: body.voiceChannelId,
    }) !== null;
  if (!proven) {
    const local = getVoicePeer(body.peerId);
    const peer =
      local ??
      (isVoiceRegistryEnabled() ? await getVoicePeerRow(body.peerId) : null);
    const peerChannel =
      peer && "voiceChannelId" in peer ? peer.voiceChannelId : peer?.channelId;
    if (
      !peer ||
      peer.userId !== user.id ||
      peerChannel !== body.voiceChannelId
    ) {
      throw new Forbidden("Unknown or mismatched voice peer");
    }
  }

  const channel = await requireChannelAccess(body.voiceChannelId, user.id);
  // Resolved at mint time, not copied from the join: a role edit between the
  // two must land in the token. The SFU only ever consults the grant.
  //
  // FAIL CLOSED, EXPLICITLY. `resolveVoicePublish` reads the watch-party seat
  // cache for `canShowFace` on a watch-party channel, and a cache miss falls
  // through to a real query with no local retry of its own
  // (`cachedWatchPartySeatSnapshot`'s own doc: "failures are not stored
  // either"). Left uncaught, a transient failure here — the seat cache's own
  // query, or `computeMemberPermissions` underneath it — would fall through
  // to `handleApi`'s generic `catch`, which answers a plain 500 for anything
  // that is not a recognised `HttpError`: correct in that no token is minted
  // either way (nothing below this line runs), but it tells the caller
  // nothing about whether trying again is the right move, and a
  // `DatabaseUnavailableError` from the breaker is the only failure shape
  // that already carries that signal. Converting explicitly to a 503 here
  // makes every failure of this specific, security-sensitive resolution
  // retryable by contract, not by accident of which error happened to be
  // thrown.
  let publish: { canSpeak: boolean; canStream: boolean; canShowFace: boolean };
  try {
    publish = await resolveVoicePublish(channel, body.voiceChannelId, user.id);
  } catch (error) {
    console.error("[voice] could not resolve the publish grant:", error);
    throw new HttpError(
      503,
      "Could not verify voice permissions, try again",
    );
  }
  const { canSpeak, canStream, canShowFace } = publish;
  const displayName = await resolveMemberName(
    channel.kind === "server" ? (channel.server_id ?? null) : null,
    user,
  );

  // The room's transport is pinned when its first peer joins and stated in
  // `welcome`; a client in a peer-to-peer room has no business minting an SFU
  // token, and every token minted starts LiveKit participant-minutes billing.
  // A room pinned on another instance is only visible through its row.
  let transport = getRoomTransport(body.voiceChannelId);
  if (isVoiceRegistryEnabled() && !isRoomPinnedLocally(body.voiceChannelId)) {
    transport = (await readVoiceRoomTransport(body.voiceChannelId)) ?? transport;
  }
  if (transport !== "livekit") {
    throw new HttpError(409, "This room runs peer-to-peer");
  }

  try {
    return await createLiveKitSession(
      body.voiceChannelId,
      body.peerId,
      displayName,
      user.id,
      { canSpeak, canStream, canShowFace },
    );
  } catch (error) {
    console.error("[voice] token minting failed:", error);
    throw new HttpError(502, "Voice backend unavailable");
  }
});

// ------------------------------------------------------------------- gifs

/**
 * The button in the composer is hidden entirely on a deployment without a key,
 * so this exists to say so once at bootstrap rather than letting the user open
 * a panel that can only ever show an error.
 */
router.get("/api/gifs/config", async () => ({
  enabled: isGifSearchConfigured(),
}));

function requireGifSearch(ctx: RequestContext): void {
  if (!isGifSearchConfigured()) {
    throw new HttpError(503, "GIF search is not configured on this server");
  }
  const key = `user:${ctx.user.id}`;
  if (!gifLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(gifLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
}

async function respondWithGifs(load: () => Promise<Gif[]>) {
  try {
    return { gifs: await load() };
  } catch (error) {
    if (error instanceof GifBackendError) {
      console.error("[gifs] upstream failed:", error.message);
      throw new HttpError(502, "GIF provider unavailable");
    }
    throw error;
  }
}

router.get("/api/gifs/search", async (ctx) => {
  requireGifSearch(ctx);
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!query) {
    throw new HttpError(400, "Missing search query");
  }
  if (query.length > GIF_QUERY_MAX_LENGTH) {
    throw new HttpError(400, "Search query too long");
  }
  const limit = clampLimit(
    ctx.url.searchParams.get("limit"),
    GIF_PAGE_SIZE,
    GIF_PAGE_MAX,
  );
  return respondWithGifs(() => searchGifs(query, limit));
});

router.get("/api/gifs/trending", async (ctx) => {
  requireGifSearch(ctx);
  const limit = clampLimit(
    ctx.url.searchParams.get("limit"),
    GIF_PAGE_SIZE,
    GIF_PAGE_MAX,
  );
  return respondWithGifs(() => trendingGifs(limit));
});

// ------------------------------------------------------------------ music

/**
 * Resolve a pasted link or a search into a YouTube video for the room's
 * queue (`packages/shared/src/music.ts`). Metadata only: the client plays
 * the result itself through the IFrame player. Per-user limited because a
 * search fans out to YouTube (and to Spotify for a Spotify link).
 */
const musicResolveLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 0.5 });

router.get("/api/music/resolve", async (ctx) => {
  const key = `user:${ctx.user.id}`;
  if (!musicResolveLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(musicResolveLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!query) {
    throw new HttpError(400, "Missing q");
  }
  if (query.length > 2048) {
    throw new HttpError(400, "Query too long");
  }
  try {
    const { tracks, listName } = await resolveMusic(query);
    // `track` stays for the first client build; `tracks` is the list.
    return { track: tracks[0], tracks, listName };
  } catch (error) {
    if (error instanceof MusicResolveError) {
      if (error.code === "busy") {
        ctx.res.setHeader("Retry-After", "5");
        throw new HttpError(429, "Music search is busy, try again in a moment");
      }
      if (error.code === "upstream") {
        console.error("[music] upstream failed:", error.message);
        throw new HttpError(502, "Music provider unavailable");
      }
      throw new HttpError(error.code === "not_found" ? 404 : 400, error.message);
    }
    throw error;
  }
});

router.get("/api/music/search", async (ctx) => {
  const key = `user:${ctx.user.id}`;
  if (!musicResolveLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(musicResolveLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!query) {
    throw new HttpError(400, "Missing q");
  }
  if (query.length > 2048) {
    throw new HttpError(400, "Query too long");
  }
  try {
    const tracks = await searchMusicCandidates(query);
    if (tracks.length === 0) {
      throw new MusicResolveError("not_found", `Nothing on YouTube for "${query}"`);
    }
    return { tracks };
  } catch (error) {
    if (error instanceof MusicResolveError) {
      if (error.code === "busy") {
        ctx.res.setHeader("Retry-After", "5");
        throw new HttpError(429, "Music search is busy, try again in a moment");
      }
      if (error.code === "upstream") {
        console.error("[music] upstream failed:", error.message);
        throw new HttpError(502, "Music provider unavailable");
      }
      throw new HttpError(error.code === "not_found" ? 404 : 400, error.message);
    }
    throw error;
  }
});

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

router.get("/api/music/related", async (ctx) => {
  const key = `user:${ctx.user.id}`;
  if (!musicResolveLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(musicResolveLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  const videoId = (ctx.url.searchParams.get("videoId") ?? "").trim();
  if (!YOUTUBE_VIDEO_ID.test(videoId)) {
    throw new HttpError(400, "Invalid videoId");
  }
  try {
    const tracks = await relatedMusicTracks(videoId);
    return { tracks };
  } catch (error) {
    if (error instanceof MusicResolveError) {
      if (error.code === "busy") {
        ctx.res.setHeader("Retry-After", "5");
        throw new HttpError(429, "Music search is busy, try again in a moment");
      }
      if (error.code === "upstream") {
        console.error("[music] upstream failed:", error.message);
        throw new HttpError(502, "Music provider unavailable");
      }
      throw new HttpError(error.code === "not_found" ? 404 : 400, error.message);
    }
    throw error;
  }
});

// ------------------------------------------------------------ attachments

/**
 * Same contract as `/api/gifs/config`: with no S3 environment the composer
 * hides its attach button entirely, rather than offering an upload that can
 * only ever answer 503.
 *
 * `maxBytes` rides along so the client rejects an oversized file in the file
 * picker instead of discovering the deployment's own lower cap on a 413.
 */
router.get("/api/attachments/config", async () => ({
  enabled: isAttachmentsConfigured(),
  maxBytes: maxAttachmentBytes(),
}));

router.post(
  "/api/channels/:channelId/attachments",
  async ({ req, res, user }, { channelId }) => {
    // Access first, so a channel the caller cannot see answers 404 whether or
    // not this deployment has storage — the 503 would otherwise confirm the
    // channel exists.
    await requireChannelAccess(channelId!, user.id);
    // Not reachable as a harassment vector on its own — the claim happens on
    // message-create, which is blocked — but staging an upload into a
    // conversation you are barred from sending to has no legitimate use, and
    // leaving it open lets a blocked account mint against the sweeper's grace
    // window indefinitely.
    if (await isDmSendBlocked(channelId!, user.id)) {
      throw new Forbidden("You cannot send to this conversation");
    }
    if (!isAttachmentsConfigured()) {
      throw new HttpError(503, "File uploads are not configured on this server");
    }

    const key = `user:${user.id}`;
    if (!uploadLimiter.take(key)) {
      res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }

    const body = createAttachmentSchema.parse(await readJsonBody(req));
    try {
      // The storage key is generated inside the service and never taken from
      // the request: a client-chosen key is a client-chosen overwrite of
      // somebody else's object, and the presigned PUT would sign it happily.
      const pending = await createPendingAttachment({
        channelId: channelId!,
        uploaderId: user.id,
        filename: body.filename,
        contentType: body.contentType,
        byteSize: body.byteSize,
        // Display-only, and dropped here the layout hint is lost for good: the
        // server never measures an image, so a message read back from history
        // would have no box to reserve and every image would land as a reflow.
        width: body.width,
        height: body.height,
      });
      return created({
        attachmentId: pending.attachment.id,
        uploadUrl: pending.uploadUrl,
        expiresAt: pending.expiresAt,
      });
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        throw new HttpError(
          413,
          `Attachments are limited to ${error.limit} bytes`,
        );
      }
      throw error;
    }
  },
);

/**
 * Stage a picked GIF as an attachment on this channel.
 *
 * Deliberately not gated on `isAttachmentsConfigured()`. A GIF needs no bucket
 * — its bytes never leave the GIF host's CDN — and the common deployment has
 * GIF search on with S3 off, so gating this on storage would turn the GIF
 * button into a 503
 * on exactly the setup that has GIFs working.
 */
router.post(
  "/api/channels/:channelId/attachments/gif",
  async ({ req, res, user }, { channelId }) => {
    await requireChannelAccess(channelId!, user.id);
    if (await isDmSendBlocked(channelId!, user.id)) {
      throw new Forbidden("You cannot send to this conversation");
    }

    const key = `user:${user.id}`;
    if (!uploadLimiter.take(key)) {
      res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }

    const body = createGifAttachmentSchema.parse(await readJsonBody(req));
    try {
      const attachment = await createRemoteAttachment({
        channelId: channelId!,
        uploaderId: user.id,
        url: body.url,
        // Provider titles are occasionally empty; either way this is a
        // display name, never a path.
        filename: body.title?.trim() || "GIF",
        contentType: "image/gif",
        width: body.width,
        height: body.height,
      });
      return created({ attachment: toPublicAttachment(attachment) });
    } catch (error) {
      if (error instanceof UnsupportedRemoteHostError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
  },
);

/**
 * A fresh read URL for one attachment.
 *
 * Exists because the URL baked into a message expires while the tab stays open,
 * so an `<img>` that fails asks for a new one rather than staying broken. The
 * access check is the point: this is the one route where an attachment id can
 * be named directly.
 */
router.get(
  "/api/attachments/:attachmentId/url",
  async ({ user }, { attachmentId }) => {
    const attachment = await getAttachmentForViewer(attachmentId!, user.id);
    if (!attachment) {
      // 404 for "no such attachment" and "not yours to see" alike, exactly as
      // requireChannelAccess refuses to confirm a channel exists.
      throw new NotFound("Attachment not found");
    }
    return {
      url: attachment.url,
      expiresAt: new Date(
        Date.now() + attachmentUrlTtlSeconds() * 1000,
      ).toISOString(),
    };
  },
);

// ---------------------------------------------------------------- servers

/**
 * The account's communities.
 *
 * Also the one place the default-community placement runs, and this is the
 * right hook rather than the bootstrap: it is the first authenticated call the
 * client makes that is *about* memberships, it runs before anything renders a
 * list, and a person who is placed here sees the community in the very response
 * that triggered the placement rather than after a refresh.
 *
 * Deliberately awaited, and deliberately incapable of failing the request. The
 * service answers with a reason rather than throwing, and every one of those
 * reasons ends in "carry on and serve the list", including the common case
 * where the feature is switched off entirely.
 */
router.get("/api/servers", async ({ user }) => {
  await placeInDefaultCommunity(user.id).catch(() => {
    // A placement that fell over is not worth the sign-in it would cost.
  });
  return etagged({ servers: (await listServersForUser(user.id)).map(mapServer) });
});

router.post("/api/servers", async ({ req, user }) => {
  // A CHARACTER IS A MEMBER, NEVER A LANDLORD. The communities the product
  // advertises are owned by a person who receives their reports and can be held
  // to them, and `seed-servers.mjs` creates them with the owner's own token for
  // exactly that reason. This is the other half of that promise: it closes the
  // last way a leaked character token could create a durable public artifact —
  // ownership carries invites, bans, retention and the audit log with it.
  if (user.is_character) {
    throw new Forbidden("Character accounts cannot create servers");
  }
  const body = createServerSchema.parse(await readJsonBody(req));
  const { server, channels } = await createServer(body.name, user.id);
  return created({
    server: { ...mapServer(server), role: "owner" as const },
    channels: channels.map(mapChannel),
  });
});

function throwDiscordImportHttp(
  error: unknown,
  res: { setHeader: (name: string, value: string) => void },
): never {
  if (error instanceof DiscordImportParseError) {
    throw new HttpError(400, error.message);
  }
  if (error instanceof DiscordImportCapError) {
    throw new HttpError(400, error.message);
  }
  if (error instanceof DiscordTemplateNotFoundError) {
    throw new NotFound(error.message);
  }
  if (error instanceof DiscordTemplateRateLimitedError) {
    if (error.retryAfterSeconds != null) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    throw new HttpError(429, error.message);
  }
  if (error instanceof DiscordTemplateTooLargeError) {
    throw new HttpError(413, error.message);
  }
  if (error instanceof DiscordTemplateUnavailableError) {
    throw new HttpError(502, error.message);
  }
  throw error;
}

function takeDiscordImportLimiters(
  userId: string,
  res: { setHeader: (name: string, value: string) => void },
): void {
  const userKey = `user:${userId}`;
  if (!discordImportLimiter.take(userKey)) {
    res.setHeader(
      "Retry-After",
      String(discordImportLimiter.retryAfter(userKey)),
    );
    throw new HttpError(429, "Slow down");
  }
  if (!discordFetchLimiter.take("discord")) {
    res.setHeader(
      "Retry-After",
      String(discordFetchLimiter.retryAfter("discord")),
    );
    throw new HttpError(429, "Slow down");
  }
}

router.post("/api/import/discord/preview", async ({ req, user, res }) => {
  if (user.is_character) {
    throw new Forbidden("Character accounts cannot create servers");
  }
  const body = discordImportSourceSchema.parse(await readJsonBody(req));
  if (!parseDiscordTemplateCode(body.source)) {
    throw new HttpError(
      400,
      "Paste a discord.new link or a Discord template code.",
    );
  }
  takeDiscordImportLimiters(user.id, res);
  try {
    const { plan } = await fetchMappedDiscordTemplate(body.source);
    return plan;
  } catch (error) {
    throwDiscordImportHttp(error, res);
  }
});

router.post("/api/import/discord/apply", async ({ req, user, res }) => {
  if (user.is_character) {
    throw new Forbidden("Character accounts cannot create servers");
  }
  const body = discordImportSourceSchema.parse(await readJsonBody(req));
  if (!parseDiscordTemplateCode(body.source)) {
    throw new HttpError(
      400,
      "Paste a discord.new link or a Discord template code.",
    );
  }
  takeDiscordImportLimiters(user.id, res);
  try {
    const { code, plan } = await fetchMappedDiscordTemplate(body.source);
    const createdServer = await createServerFromImport(user.id, code, plan);
    return created(createdServer);
  } catch (error) {
    throwDiscordImportHttp(error, res);
  }
});

router.patch("/api/servers/:serverId", async ({ req, user }, { serverId }) => {
  const body = updateServerSchema.parse(await readJsonBody(req));
  const ownerFields =
    (body.ownerId !== undefined && body.ownerId !== user.id) ||
    body.messageRetentionDays !== undefined ||
    body.ssoEmailDomain !== undefined;
  if (ownerFields) {
    await requireOwner(serverId!, user.id);
  } else if (body.name) {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
  } else {
    await requireServerMember(serverId!, user.id);
  }

  if (body.ownerId && body.ownerId !== user.id) {
    try {
      await transferOwnership(serverId!, user.id, body.ownerId);
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Cannot transfer ownership",
      );
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "server.ownership_transfer",
      targetType: "user",
      targetId: body.ownerId,
      changes: [{ key: "ownerId", old: user.id, new: body.ownerId }],
    });
  }
  let server = body.name ? await renameServer(serverId!, body.name) : null;
  if (server) {
    // The old name is not fetched first — a rename is common enough, and low
    // enough stakes, that the entry recording what it became is worth more
    // than the extra read recording what it was.
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "server.update",
      targetType: "server",
      targetId: serverId!,
      changes: [{ key: "name", old: null, new: body.name }],
    });
  }

  if (body.messageRetentionDays !== undefined) {
    const updated = await updateMessageRetention(serverId!, body.messageRetentionDays);
    if (updated) {
      server = updated.server;
      await logAudit({
        serverId: serverId!,
        actorId: user.id,
        action: "server.retention_update",
        targetType: "server",
        targetId: serverId!,
        changes: [
          {
            key: "messageRetentionDays",
            old: updated.previousDays,
            new: body.messageRetentionDays,
          },
        ],
      });
    }
  }

  if (body.ssoEmailDomain !== undefined) {
    // Validated here rather than in `updateServerSchema` so the specific reason
    // reaches the owner — see the note on that field.
    let domain: string | null = null;
    if (body.ssoEmailDomain !== null) {
      const parsed = ssoEmailDomainSchema.safeParse(body.ssoEmailDomain);
      if (!parsed.success) {
        throw new HttpError(
          400,
          parsed.error.issues[0]?.message ?? "Enter a valid domain",
        );
      }
      domain = parsed.data;
    }
    const updated = await updateSsoEmailDomain(serverId!, domain);
    if (updated) {
      server = updated.server;
      await logAudit({
        serverId: serverId!,
        actorId: user.id,
        action: "server.sso_domain_update",
        targetType: "server",
        targetId: serverId!,
        changes: [
          {
            key: "ssoEmailDomain",
            old: updated.previousDomain,
            new: domain,
          },
        ],
      });
    }
  }

  return { ok: true, ...(server ? { server: mapServer(server) } : {}) };
});

/**
 * Servers the caller can join right now on the strength of a verified email
 * domain. Membership-independent by design — this is what makes an
 * SSO-provisioned user's first login land somewhere instead of an empty app.
 */
router.get("/api/servers/sso-available", async ({ user }) => {
  const servers = await listSsoJoinableServers(user.id);
  return { servers: servers.map(mapServer) };
});

router.post("/api/servers/:serverId/sso-join", async ({ user }, { serverId }) => {
  const result = await joinServerBySso(serverId!, user.id);
  if (!result.ok) {
    if (result.reason === "banned") {
      throw new HttpError(403, "You are banned from this server");
    }
    // `not_found` and `domain_mismatch` deliberately return the same 404: a
    // different answer would let a stranger enumerate which server ids exist.
    throw new HttpError(404, "Server not found");
  }
  if (result.joinedNow) {
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.sso_join",
      targetType: "user",
      targetId: user.id,
      changes: [
        { key: "ssoEmailDomain", old: null, new: result.server.sso_email_domain },
      ],
    });
  }
  return { ok: true, server: mapServer(result.server) };
});

// ------------------------------------------------------- server identity
//
// A server's icon and banner. The upload half only: the *display* half needs
// nothing here, because `iconUrl` / `bannerUrl` are on `SERVER_COLUMNS` and
// therefore ride in every server payload and every directory card already.
//
// Structurally the avatar routes with one difference, and it is the whole
// difference: an avatar's storage key contains the claiming account's own id,
// so the claim authorises itself. A server key contains a *server* id, which
// many people are members of — so `requireOwner` is what stands in for that, on
// every route below, and `isServerImageKey` only ever proves the weaker "this
// object belongs to the server named in the URL".

/**
 * Mirrors `GET /api/avatars/config`, limits in both states so a picker can
 * refuse an over-size file against this deployment's cap rather than
 * discovering it on a 413.
 *
 * Above the `:serverId` routes on purpose: `images` is not a UUID, but the
 * router matches by segment shape and a path that could be read either way is
 * a bug waiting for the first server whose id is the word "images".
 */
router.get("/api/servers/images/config", async () => ({
  enabled: isServerImageUploadConfigured(),
  icon: { maxBytes: MAX_SERVER_ICON_BYTES, size: SERVER_ICON_SIZE },
  banner: {
    maxBytes: MAX_SERVER_BANNER_BYTES,
    width: SERVER_BANNER_WIDTH,
    height: SERVER_BANNER_HEIGHT,
  },
  featured: {
    maxBytes: MAX_SERVER_BANNER_BYTES,
    width: COMMUNITY_FEATURED_IMAGE_WIDTH,
    height: COMMUNITY_FEATURED_IMAGE_HEIGHT,
  },
}));

function serverImageAuditAction(
  kind: ServerImageKind,
): "server.icon_update" | "server.banner_update" | "server.community_update" {
  if (kind === "banner") {
    return "server.banner_update";
  }
  if (kind === "featured") {
    return "server.community_update";
  }
  return "server.icon_update";
}

/**
 * Mint an upload for one of a server's pictures.
 *
 * The per-kind cap is applied here rather than in `createServerImageUploadSchema`
 * because the schema does not know which kind it is parsing, and a banner's
 * eight megabytes must not become an icon's ceiling. The number goes into the
 * *signature* (see `presignPut`), so a client cannot mint a URL for 40 KB and
 * then push eight megabytes through it.
 */
async function mintServerImage(
  kind: ServerImageKind,
  ctx: { req: IncomingMessage; res: ServerResponse; user: { id: string } },
  serverId: string,
) {
  if (kind === "featured") {
    requireCommunities();
  }
  if (!isServerImageUploadConfigured()) {
    throw new HttpError(503, "Image uploads are not configured on this server");
  }
  await requirePermission(serverId, ctx.user.id, Permission.MANAGE_SERVER);

  const key = `user:${ctx.user.id}`;
  if (!uploadLimiter.take(key)) {
    ctx.res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const body = createServerImageUploadSchema.parse(await readJsonBody(ctx.req));
  if (body.byteSize > maxServerImageBytes(kind)) {
    throw new HttpError(413, "That image is too large.");
  }

  return created(
    createServerImageUpload({
      kind,
      serverId,
      contentType: body.contentType,
      byteSize: body.byteSize,
    }),
  );
}

/**
 * The bytes are up: make them the picture.
 *
 * The HEAD runs *before* anything is written, for the reason spelled out in
 * `docs/ATTACHMENTS.md`, and a failure is a 400 rather than a 500 — the request
 * named an object that is not there or is not what it claimed. The object the
 * row stopped pointing at is dropped afterwards and best-effort: it is
 * unreferenced by then, and failing the owner's request over a bucket that did
 * not answer would undo a change that has already committed.
 */
async function claimServerImage(
  kind: ServerImageKind,
  ctx: { req: IncomingMessage; user: { id: string } },
  serverId: string,
) {
  if (kind === "featured") {
    requireCommunities();
  }
  if (!isServerImageUploadConfigured()) {
    throw new HttpError(503, "Image uploads are not configured on this server");
  }
  await requirePermission(serverId, ctx.user.id, Permission.MANAGE_SERVER);

  const body = claimServerImageSchema.parse(await readJsonBody(ctx.req));
  const byteSize = await verifyServerImageObject(kind, serverId, body.key);
  if (byteSize === null) {
    throw new HttpError(400, "That upload could not be verified. Try again.");
  }

  const updated = await setServerImage(
    kind,
    serverId,
    { url: serverImageUrlForKey(kind, serverId, body.key), key: body.key },
    SERVER_COLUMNS,
  );
  if (!updated) {
    throw new NotFound("Server not found");
  }
  if (updated.previousKey && updated.previousKey !== body.key) {
    scheduleDiscardServerImageObject(updated.previousKey);
  }
  await logAudit({
    serverId,
    actorId: ctx.user.id,
    action: serverImageAuditAction(kind),
    targetType: "server",
    targetId: serverId,
    changes: [{ key: kind, old: null, new: "set" }],
  });
  return { server: mapServer(updated.server) };
}

/**
 * Back to the monogram.
 *
 * NOT gated on storage being configured, unlike the two above and for the same
 * reason `DELETE /api/me/avatar` is not: a server that uploaded a banner and
 * then lost its bucket must still be able to stop pointing at it. Clearing the
 * columns is a database write and succeeds either way.
 */
async function clearServerImage(
  kind: ServerImageKind,
  userId: string,
  serverId: string,
) {
  if (kind === "featured") {
    requireCommunities();
  }
  await requirePermission(serverId, userId, Permission.MANAGE_SERVER);
  const updated = await setServerImage(kind, serverId, null, SERVER_COLUMNS);
  if (!updated) {
    throw new NotFound("Server not found");
  }
  if (updated.previousKey) {
    scheduleDiscardServerImageObject(updated.previousKey);
  }
  await logAudit({
    serverId,
    actorId: userId,
    action: serverImageAuditAction(kind),
    targetType: "server",
    targetId: serverId,
    changes: [{ key: kind, old: "set", new: null }],
  });
  return { server: mapServer(updated.server) };
}

router.post("/api/servers/:serverId/icon", async (ctx, { serverId }) =>
  mintServerImage("icon", ctx, serverId!),
);
router.post("/api/servers/:serverId/icon/claim", async (ctx, { serverId }) =>
  claimServerImage("icon", ctx, serverId!),
);
router.delete("/api/servers/:serverId/icon", async ({ user }, { serverId }) =>
  clearServerImage("icon", user.id, serverId!),
);

router.post("/api/servers/:serverId/banner", async (ctx, { serverId }) =>
  mintServerImage("banner", ctx, serverId!),
);
router.post("/api/servers/:serverId/banner/claim", async (ctx, { serverId }) =>
  claimServerImage("banner", ctx, serverId!),
);
router.delete("/api/servers/:serverId/banner", async ({ user }, { serverId }) =>
  clearServerImage("banner", user.id, serverId!),
);

router.post("/api/servers/:serverId/featured", async (ctx, { serverId }) =>
  mintServerImage("featured", ctx, serverId!),
);
router.post("/api/servers/:serverId/featured/claim", async (ctx, { serverId }) =>
  claimServerImage("featured", ctx, serverId!),
);
router.delete("/api/servers/:serverId/featured", async ({ user }, { serverId }) =>
  clearServerImage("featured", user.id, serverId!),
);

// ---------------------------------------------------------- community home (Baú)

function mapCommunityHomeError(error: unknown): never {
  if (error instanceof CommunityHomeError) {
    switch (error.code) {
      case "not_found":
        throw new NotFound(error.message);
      case "forbidden":
        throw new Forbidden(error.message);
      case "storage_off":
        throw new HttpError(503, error.message);
      case "over_limit":
        throw new HttpError(413, error.message);
      default:
        throw new HttpError(400, error.message);
    }
  }
  throw error;
}

async function notifyHome(serverId: string): Promise<void> {
  try {
    await notifyCommunityHomeUpdate(serverId);
  } catch (error) {
    console.error("[community-home] notify failed:", error);
  }
}

/**
 * The gate every Baú route runs first. Same shape as communities: 404, not
 * 503, because with the flag off the surface does not exist here and the
 * paths below name nothing.
 */
/** Spend one token from a Baú budget, or answer 429 with a Retry-After. */
function takeHomeBudget(
  limiter: { take: (key: string) => boolean; retryAfter: (key: string) => number },
  res: ServerResponse,
  userId: string,
): void {
  const key = `home:${userId}`;
  if (!limiter.take(key)) {
    res.setHeader("Retry-After", String(limiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
}

function requireCommunityHome(): void {
  if (!isCommunityHomeEnabled()) {
    throw new NotFound("Not found");
  }
}

/**
 * Still behind auth like every other `/api` route. Answers 200 with the
 * flags rather than 404ing, so the client can tell "off" from "unreachable".
 * `mediaEnabled` is the storage probe, folded in so the client needs one
 * request rather than two before it can draw the composer.
 */
router.get("/api/community-home/config", async () => ({
  enabled: isCommunityHomeEnabled(),
  vipEnabled: isCommunityHomeVipEnabled(),
  mediaEnabled: isCommunityHomeEnabled() && isCommunityHomeMediaConfigured(),
}));

/**
 * This server's own opt-in. The instance flag says Baú exists here; this
 * says the owner turned it on for this server (Server settings). Both gate
 * the row and the landing on the client; only the instance flag gates the
 * routes, so an owner can flip the setting through the same API.
 */
router.get(
  "/api/servers/:serverId/home/config",
  async ({ user }, { serverId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    const server = await getServer(serverId!);
    if (!server) {
      throw new NotFound("Server not found");
    }
    return { enabled: server.community_home_enabled ?? false };
  },
);

router.patch(
  "/api/servers/:serverId/home/config",
  async ({ req, user }, { serverId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const body = updateServerCommunityHomeConfigSchema.parse(
      await readJsonBody(req),
    );
    const server = await setCommunityHomeEnabled(serverId!, body.enabled);
    return {
      enabled: server.community_home_enabled ?? false,
      server: mapServer(server),
    };
  },
);

router.get("/api/servers/:serverId/home/posts", async ({ user }, { serverId }) => {
  requireCommunityHome();
  requireCommunityHome();
  await requireServerMember(serverId!, user.id);
  try {
    const posts = await listCommunityHomePosts(serverId!, user.id);
    return { posts };
  } catch (error) {
    mapCommunityHomeError(error);
  }
});

router.get(
  "/api/servers/:serverId/home/drafts",
  async ({ user }, { serverId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    try {
      const posts = await listCommunityHomeDrafts(serverId!, user.id);
      return { posts };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.get(
  "/api/servers/:serverId/home/posts/:postId",
  async ({ user }, { serverId, postId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    try {
      const post = await getCommunityHomePost(serverId!, postId!, user.id);
      return { post };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts",
  async ({ req, res, user }, { serverId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    takeHomeBudget(homePostLimiter, res, user.id);
    const raw = createCommunityHomePostSchema.parse(await readJsonBody(req));
    try {
      const post = await createCommunityHomePost(serverId!, user.id, {
        title: parseCommunityHomeTitle(raw.title),
        body: parseCommunityHomeBody(raw.body),
        teaser: parseCommunityHomeTeaser(raw.teaser),
        visibility: raw.visibility,
        commentsEnabled: raw.commentsEnabled !== false,
        mediaUploadId: raw.mediaUploadId ?? null,
        youtubeUrl: raw.youtubeUrl ?? null,
        status: raw.status,
        scheduledAt: raw.scheduledAt ?? null,
        scheduleTimezone: raw.scheduleTimezone ?? null,
      });
      await notifyHome(serverId!);
      return created({ post });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new HttpError(400, error.issues[0]?.message ?? "Invalid request");
      }
      mapCommunityHomeError(error);
    }
  },
);

router.patch(
  "/api/servers/:serverId/home/posts/:postId",
  async ({ req, user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const raw = updateCommunityHomePostSchema.parse(await readJsonBody(req));
    try {
      const post = await updateCommunityHomePost(serverId!, postId!, user.id, {
        title:
          raw.title === undefined
            ? undefined
            : parseCommunityHomeTitle(raw.title),
        body:
          raw.body === undefined ? undefined : parseCommunityHomeBody(raw.body),
        teaser:
          raw.teaser === undefined
            ? undefined
            : parseCommunityHomeTeaser(raw.teaser),
        visibility: raw.visibility,
        commentsEnabled: raw.commentsEnabled,
        mediaUploadId: raw.mediaUploadId,
        youtubeUrl: raw.youtubeUrl,
        clearMedia: raw.clearMedia,
      });
      await notifyHome(serverId!);
      return { post };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new HttpError(400, error.issues[0]?.message ?? "Invalid request");
      }
      mapCommunityHomeError(error);
    }
  },
);

router.delete(
  "/api/servers/:serverId/home/posts/:postId",
  async ({ user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    try {
      await deleteCommunityHomePost(serverId!, postId!, user.id);
      await notifyHome(serverId!);
      return { ok: true };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

/**
 * The Baú badge: how many posts this person has not seen. Its own endpoint
 * rather than a field on the feed, because the sidebar row needs the number
 * without loading the posts.
 */
router.get(
  "/api/servers/:serverId/home/unread",
  async ({ user }, { serverId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    try {
      return { count: await countUnreadCommunityHomePosts(serverId!, user.id) };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/read",
  async ({ user }, { serverId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    try {
      await markCommunityHomeRead(serverId!, user.id);
      return { ok: true };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/pin",
  async ({ req, user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const body = pinCommunityHomePostSchema.parse(await readJsonBody(req));
    try {
      const post = await setCommunityHomePostPinned(
        serverId!,
        postId!,
        user.id,
        body.pinned,
      );
      await notifyHome(serverId!);
      return { post };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/publish",
  async ({ user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    try {
      const post = await publishCommunityHomePost(serverId!, postId!, user.id);
      await notifyHome(serverId!);
      return { post };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/unpublish",
  async ({ user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    try {
      const post = await unpublishCommunityHomePost(
        serverId!,
        postId!,
        user.id,
      );
      await notifyHome(serverId!);
      return { post };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/schedule",
  async ({ req, user }, { serverId, postId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const body = scheduleCommunityHomePostSchema.parse(await readJsonBody(req));
    try {
      const post = await scheduleCommunityHomePost(
        serverId!,
        postId!,
        user.id,
        body.scheduledAt,
        body.scheduleTimezone,
      );
      await notifyHome(serverId!);
      return { post };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.get(
  "/api/servers/:serverId/home/posts/:postId/comments",
  async ({ user }, { serverId, postId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    try {
      const comments = await listCommunityHomeComments(
        serverId!,
        postId!,
        user.id,
      );
      return { comments };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/comments",
  async ({ req, res, user }, { serverId, postId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    takeHomeBudget(homeCommentLimiter, res, user.id);
    const raw = createCommunityHomeCommentSchema.parse(await readJsonBody(req));
    let body: string;
    try {
      body = communityHomeCommentBodySchema.parse(raw.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new HttpError(400, error.issues[0]?.message ?? "Invalid comment");
      }
      throw error;
    }
    try {
      const comment = await addCommunityHomeComment(
        serverId!,
        postId!,
        user.id,
        body,
      );
      // Deliberately no fan-out. The frame carries no payload, so every
      // member would refetch the whole feed for one comment on one card —
      // an amplifier a single chatty person could point at the server. The
      // commenter sees their own comment immediately; everyone else sees it
      // on their next load, which is what a comment list is for.
      return created({ comment });
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.delete(
  "/api/servers/:serverId/home/posts/:postId/comments/:commentId",
  async ({ user }, { serverId, postId, commentId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    try {
      await deleteCommunityHomeComment(
        serverId!,
        postId!,
        commentId!,
        user.id,
      );
      await notifyHome(serverId!);
      return { ok: true };
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/posts/:postId/likes",
  async ({ res, user }, { serverId, postId }) => {
    requireCommunityHome();
    await requireServerMember(serverId!, user.id);
    takeHomeBudget(homeLikeLimiter, res, user.id);
    try {
      // No fan-out: a like on a 300-member server would make 300 clients
      // refetch the feed. The actor gets the new count in the response and
      // everybody else sees it on their next load.
      return await toggleCommunityHomeLike(serverId!, postId!, user.id);
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.get("/api/servers/:serverId/home/media/config", async ({ user }, { serverId }) => {
  requireCommunityHome();
  await requireServerMember(serverId!, user.id);
  return {
    enabled: isCommunityHomeMediaConfigured(),
    maxBytes: COMMUNITY_HOME_MAX_BYTES,
  };
});

router.post(
  "/api/servers/:serverId/home/media",
  async (ctx, { serverId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, ctx.user.id, Permission.MANAGE_SERVER);
    if (!isCommunityHomeMediaConfigured()) {
      throw new HttpError(503, "Media uploads are not configured on this server");
    }
    const key = `home-media:${ctx.user.id}`;
    if (!uploadLimiter.take(key)) {
      ctx.res.setHeader("Retry-After", String(uploadLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }
    const body = createCommunityHomeMediaUploadSchema.parse(
      await readJsonBody(ctx.req),
    );
    try {
      return created(
        await mintCommunityHomeMediaUpload({
          serverId: serverId!,
          uploaderId: ctx.user.id,
          contentType: body.contentType,
          byteSize: body.byteSize,
          filename: body.filename,
        }),
      );
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

router.post(
  "/api/servers/:serverId/home/media/claim",
  async ({ req, user }, { serverId }) => {
    requireCommunityHome();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const body = claimCommunityHomeMediaSchema.parse(await readJsonBody(req));
    try {
      return await claimCommunityHomeMediaUpload({
        serverId: serverId!,
        uploaderId: user.id,
        uploadId: body.uploadId,
      });
    } catch (error) {
      mapCommunityHomeError(error);
    }
  },
);

// ------------------------------------------------------------- communities

/**
 * Whether this deployment has the directory at all.
 *
 * The one route in this section that is NOT flag-gated, and it has to be: the
 * client hides the entire Communities surface when this answers `false`, so an
 * endpoint that 404'd with the feature off would leave the client unable to
 * tell "off" from "old server" from "network blip" — three states it must
 * render identically as "nothing here". Same contract as `/api/gifs/config` and
 * `/api/attachments/config`, and it leaks nothing an operator has not already
 * decided to publish.
 *
 * Still behind auth like every other `/api` route (see pitfall 8 in CLAUDE.md
 * — there is no public-route allowlist), which is deliberate rather than
 * incidental: nothing about this feature, the config included, is readable
 * without an account that has passed the 18+ gate.
 */
router.get("/api/communities/config", async () => ({
  enabled: isCommunitiesEnabled(),
}));

/**
 * The gate every other route in this section runs first.
 *
 * 404 AND NOT 503, unlike the GIF and attachment routes. Those two are
 * *configuration* — the feature exists and this deployment has no key — so
 * "unavailable" is the honest answer. This is different in kind: with the flag
 * off, communities do not exist here, no server can be one, and the paths below
 * name nothing. 404 is what an unbuilt feature answers, and it is also what
 * keeps a probe from learning that a future version of pqp has a directory.
 *
 * The single choke point a per-user or percentage rollout would later replace —
 * see `isCommunitiesEnabled`.
 */
function requireCommunities(): void {
  if (!isCommunitiesEnabled()) {
    throw new NotFound();
  }
}

/**
 * The directory.
 *
 * Auth is the router's, and it is load-bearing rather than incidental: browsing
 * is not anonymous, which is what keeps the 18+ gate in front of public content
 * and what makes "hide servers this person is banned from" a question with an
 * answer. See rule 2 in services/communities.ts.
 */
router.get("/api/communities", async ({ url, user }) => {
  requireCommunities();

  const rawCategory = url.searchParams.get("category");
  let category = null;
  if (rawCategory) {
    const parsed = communityCategorySchema.safeParse(rawCategory);
    // An unknown category is refused rather than ignored. Falling back to "all"
    // would answer a filtered request with unfiltered results, which reads as
    // the filter silently not working.
    if (!parsed.success) {
      throw new HttpError(400, "Unknown category");
    }
    category = parsed.data;
  }

  // Absent is "every language" — the client's "todos" segment simply omits the
  // parameter. An unknown value is refused for the same reason an unknown
  // category is: answering a narrowed request with the whole directory reads as
  // the control being broken rather than as a lenient API.
  const rawLanguage = url.searchParams.get("language");
  let language = null;
  if (rawLanguage) {
    const parsed = communityLanguageSchema.safeParse(rawLanguage);
    if (!parsed.success) {
      throw new HttpError(400, "Unknown language");
    }
    language = parsed.data;
  }

  const rawSearch = url.searchParams.get("q");
  let search = null;
  if (rawSearch && rawSearch.trim()) {
    const parsed = communitySearchQuerySchema.safeParse(rawSearch);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid search query");
    }
    search = parsed.data;
  }

  const limit = clampLimit(
    url.searchParams.get("limit"),
    COMMUNITY_PAGE_SIZE,
    COMMUNITY_PAGE_MAX,
  );
  // Clamped through the same helper, with the page ceiling as its own bound: an
  // unbounded OFFSET is a cheap way to make Postgres walk the whole partial
  // index, and nothing in this UI pages past a few screens.
  const offsetParam = Number(url.searchParams.get("offset") ?? 0);
  const offset =
    Number.isFinite(offsetParam) && offsetParam > 0
      ? Math.min(Math.floor(offsetParam), 1000)
      : 0;

  return listCommunities(user.id, { category, language, search, limit, offset });
});

/** One listing, for a deep link into the directory. */
router.get("/api/communities/:serverId", async ({ user }, { serverId }) => {
  requireCommunities();
  const community = await getCommunity(user.id, serverId!);
  if (!community) {
    throw new NotFound("Community not found");
  }
  return { community };
});

/**
 * Join without an invite.
 *
 * Answers 200 whether or not a membership row was written — see `joinCommunity`
 * on why idempotency here is load-bearing. `joinedNow` rides along so the client
 * can tell a welcome from a re-entry without asking again.
 *
 * Audited on the server side of the join, matching `member.sso_join`: an owner
 * looking at their audit log should be able to see who walked in off the
 * directory, which is the one thing a public listing changes about their server.
 */
router.post(
  "/api/communities/:serverId/join",
  async ({ user }, { serverId }) => {
    requireCommunities();
    const result = await joinCommunity(serverId!, user.id);
    if (!result.ok) {
      if (result.reason === "banned") {
        throw new Forbidden("You are banned from this community");
      }
      throw new NotFound("Community not found");
    }
    if (result.joinedNow) {
      await logAudit({
        serverId: serverId!,
        actorId: user.id,
        action: "member.community_join",
        targetType: "user",
        targetId: user.id,
        changes: [],
      });
    }
    return {
      ok: true,
      serverId: result.serverId,
      serverName: result.serverName,
      joinedNow: result.joinedNow,
    };
  },
);

/**
 * Resolve a public slug to the listing behind it — for signed-in callers.
 *
 * THE OTHER HALF OF `?join=<slug>`, and the exact counterpart of
 * `/api/users/lookup`'s role in `?add=<handle>`. Somebody clicks "Entrar na
 * comunidade" on `pqp.gg/c/valorant`, signs up, lands in the app holding a
 * slug and nothing else — the public page deliberately never gave them an id.
 * This turns the slug into the listing, and the client then posts the ordinary
 * join, which re-checks everything under a lock the way it always has.
 *
 * ONE ROUTE RATHER THAN A JOIN-BY-SLUG. Splitting resolve from join keeps
 * exactly one code path that admits a member (`joinCommunity`), with one ban
 * check, one audit entry and one idempotency story. A second door into the same
 * room is a second door to remember to lock.
 *
 * Behind the flag and the router's auth like everything else here. The 404
 * covers "no such slug", "not a community" and "suspended" identically —
 * `findCommunityIdBySlug` cannot tell them apart on purpose.
 */
router.get("/api/communities/by-slug/:slug", async ({ user }, { slug }) => {
  requireCommunities();
  const parsed = communitySlugSchema.safeParse(slug ?? "");
  if (!parsed.success) {
    throw new NotFound("Community not found");
  }
  const serverId = await findCommunityIdBySlug(parsed.data);
  if (!serverId) {
    throw new NotFound("Community not found");
  }
  // ADDRESSED SCOPE, not the directory's. Somebody arriving through
  // `?join=<slug>` was handed the link; whether the room is also browsable is
  // beside the point, and answering 404 here would break the whole reason a
  // community can take an address without opening the directory door.
  const community = await getCommunity(user.id, serverId, "addressed");
  if (!community) {
    // Listed and unsuspended, but the viewer is banned from it. Same 404 a
    // stranger's unknown slug gets — see rule 3 in services/communities.ts: a
    // ban is invisibility, and a 403 here would confirm where they are
    // unwelcome and hand them a page to hammer.
    throw new NotFound("Community not found");
  }
  return { community };
});

/**
 * The listing, as the people who run the server see it.
 *
 * MANAGE SERVER, not owner. The panel is where the public address is set, and
 * the address is a Manage Server field — see the PATCH below for the argument.
 * A read gated harder than the write it feeds would leave an admin a form they
 * can submit and cannot open.
 */
router.get(
  "/api/servers/:serverId/community",
  async ({ user }, { serverId }) => {
    requireCommunities();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const settings = await getCommunitySettings(serverId!);
    if (!settings) {
      throw new NotFound("Server not found");
    }
    return { community: settings };
  },
);

/**
 * Opt in, opt out, or edit the pitch.
 *
 * TWO GATES ON ONE ROUTE, AND THE SPLIT IS THE POINT.
 *
 * `isListed` — the DIRECTORY — IS OWNER ONLY, for the reason `retention` and
 * `ssoEmailDomain` are: it makes a private room findable and joinable by
 * strangers who were sent nothing, and it is what attaches the moderation duty
 * in docs/CONTENT_SAFETY.md §Communities to the instance. That is not a thing an
 * admin should be able to do to somebody else's server. It is enforced in
 * `updateCommunitySettings`, under the row lock, so an admin's save cannot undo
 * a listing the owner turned on a millisecond earlier — nor take it down
 * sideways by emptying the address underneath it.
 *
 * EVERYTHING ELSE IS MANAGE SERVER, the bit that already renames the server and
 * replaces its icon and banner. `isCommunity` — the public ADDRESS — is the
 * field that motivated the split: a community's moderators are the people who
 * hand out its link, and a setting only the owner can reach is a setting a
 * 500-member room cannot use on the day it needs to. The address changes no
 * permission and brings none of the strangers a listing brings; the door behind
 * it is the one an invite already offers.
 *
 * A SEPARATE ROUTE FROM `PATCH /api/servers/:serverId` on purpose. That route
 * must keep working with the flag off; this one must 404. Folding these fields
 * into `updateServerSchema` would mean the general PATCH quietly accepting and
 * discarding them on a deployment where communities do not exist.
 */
router.patch(
  "/api/servers/:serverId/community",
  async ({ req, user }, { serverId }) => {
    requireCommunities();
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    // Read once, here, and handed to the service so the directory check happens
    // under the lock rather than against a value that may already be stale.
    const mayChangeListing =
      (await getMemberRole(serverId!, user.id)) === "owner";
    const body = updateCommunitySchema.parse(await readJsonBody(req));

    // Validated here rather than in the schema for the same reason
    // `ssoEmailDomain` is: the generic ZodError handler flattens everything to
    // "Invalid request", and "your tagline is too long" is a sentence the owner
    // needs to read.
    let tagline: string | null | undefined;
    if (body.tagline !== undefined) {
      if (body.tagline === null || body.tagline.trim() === "") {
        // An emptied box is a cleared tagline, not a stored empty string — the
        // card renders "no tagline" from NULL and would otherwise reserve a
        // line of layout for nothing.
        tagline = null;
      } else {
        const parsed = communityTaglineSchema.safeParse(body.tagline);
        if (!parsed.success) {
          throw new HttpError(
            400,
            parsed.error.issues[0]?.message ?? "Tagline is too long",
          );
        }
        tagline = parsed.data;
      }
    }

    /**
     * The address, validated here rather than in the schema for the tagline's
     * reason and one sharper one.
     *
     * 409 and 422 from this route always mean the address. 400 on the slug
     * still means the address when the message matches "cannot be used".
     * About, links, and featured also 400, and those land on the form as a
     * whole — never on the slug box.
     *
     * `communitySlugSchema` slugifies first, so an owner who types "Valorant
     * Brasil" is answered with `valorant-brasil` rather than told off for
     * typing a space.
     */
    let slug: string | undefined;
    if (body.slug !== undefined) {
      const parsed = communitySlugSchema.safeParse(body.slug);
      if (!parsed.success) {
        throw new HttpError(
          400,
          parsed.error.issues[0]?.message ?? "That address cannot be used",
        );
      }
      slug = parsed.data;
    }

    let about: string | null | undefined;
    if (body.about !== undefined) {
      if (body.about === null || body.about.trim() === "") {
        about = null;
      } else {
        const parsed = communityAboutSchema.safeParse(body.about);
        if (!parsed.success) {
          throw new HttpError(
            400,
            parsed.error.issues[0]?.message ?? "That about text is too long",
          );
        }
        about = parsed.data;
      }
    }

    let links: NonNullable<ReturnType<typeof normalizeCommunityLinks>> | undefined;
    if (body.links !== undefined) {
      const parsed = normalizeCommunityLinks(body.links);
      if (parsed === null) {
        throw new HttpError(
          400,
          "That link is not allowed. Use https, and only YouTube, Twitch, Instagram, TikTok, X, or a website.",
        );
      }
      links = parsed;
    }

    let featured: ReturnType<typeof parseCommunityFeaturedEmbed> | null | undefined;
    if (body.featured !== undefined) {
      if (body.featured === null) {
        featured = null;
      } else {
        const parsed = parseCommunityFeaturedEmbed(body.featured.url);
        if (!parsed || parsed.kind !== body.featured.kind) {
          throw new HttpError(
            400,
            "Featured media has to be a YouTube video or a Twitch link.",
          );
        }
        featured = parsed;
      }
    }

    let updated;
    try {
      updated = await updateCommunitySettings(
        serverId!,
        {
          ...(body.isCommunity !== undefined
            ? { isCommunity: body.isCommunity }
            : {}),
          ...(body.isListed !== undefined ? { isListed: body.isListed } : {}),
          ...(tagline !== undefined ? { tagline } : {}),
          ...(about !== undefined ? { about } : {}),
          ...(links !== undefined ? { links } : {}),
          ...(featured !== undefined ? { featured } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
        },
        { mayChangeListing },
      );
    } catch (error) {
      // 409 for a collision — the status `HandleTakenError` answers, for the
      // same reason: the request was well formed and lost a race, and a retry
      // with a different value works. 422 for a name that cannot become an
      // address, because nothing about *this* request will be different on a
      // retry; the owner has to supply something.
      // 403 and not 404: the caller may plainly see this panel and edit most
      // of it, so hiding the field would only make the switch look broken. The
      // two reasons get two sentences, because "you cannot do that" about a
      // switch the admin never touched is the confusing half.
      if (error instanceof CommunityListingForbiddenError) {
        throw new Forbidden(
          error.reason === "listing"
            ? "Only the owner can list this community in the directory"
            : "This community is in the directory. Only the owner can take it out, so its public address cannot be turned off here.",
        );
      }
      // 409: the request was well formed and lost to the row's state, and a
      // retry that turns the address on first works. Same family as the slug
      // collision below.
      if (error instanceof CommunityListingNeedsAddressError) {
        throw new HttpError(
          409,
          "Turn the public address on before listing this community in the directory",
        );
      }
      if (error instanceof CommunitySlugError) {
        throw new HttpError(
          error.reason === "taken" ? 409 : 422,
          error.reason === "taken"
            ? "That address is already taken. Pick another."
            : "That name cannot become a web address. Pick one.",
        );
      }
      throw error;
    }
    if (!updated) {
      throw new NotFound("Server not found");
    }

    if (updated.previousFeaturedKey) {
      scheduleDiscardServerImageObject(updated.previousFeaturedKey);
    }

    // One entry for the whole patch, carrying only what actually moved. Listing
    // a server publicly is the single most consequential setting an owner can
    // change — it is what puts the room in front of strangers — so the trail has
    // to say who did it and when, not merely that "the server was updated".
    const changes = [
      ...(body.isCommunity !== undefined &&
      updated.previous.isCommunity !== updated.settings.isCommunity
        ? [
            {
              key: "isCommunity",
              old: updated.previous.isCommunity,
              new: updated.settings.isCommunity,
            },
          ]
        : []),
      // Logged on the EFFECTIVE value rather than on what was asked for: the
      // listing can move without anybody naming it, when the address is turned
      // off underneath it. An audit trail that only recorded the field somebody
      // typed would have no record of the room leaving the directory.
      ...(updated.previous.isListed !== updated.settings.isListed
        ? [
            {
              key: "isCommunityListed",
              old: updated.previous.isListed,
              new: updated.settings.isListed,
            },
          ]
        : []),
      ...(tagline !== undefined && updated.previous.tagline !== updated.settings.tagline
        ? [
            {
              key: "communityTagline",
              old: updated.previous.tagline,
              new: updated.settings.tagline,
            },
          ]
        : []),
      ...(body.category !== undefined &&
      updated.previous.category !== updated.settings.category
        ? [
            {
              key: "communityCategory",
              old: updated.previous.category,
              new: updated.settings.category,
            },
          ]
        : []),
      // Logged whether or not the owner asked for it, unlike every entry above:
      // the first opt-in DERIVES a slug from the name, so the most common way
      // this field moves is one nobody typed. An audit trail that only recorded
      // deliberate changes would have no record of how a room got the public
      // URL it is now known by.
      ...(updated.previous.slug !== updated.settings.slug
        ? [
            {
              key: "communitySlug",
              old: updated.previous.slug,
              new: updated.settings.slug,
            },
          ]
        : []),
      ...(body.language !== undefined &&
      updated.previous.language !== updated.settings.language
        ? [
            {
              key: "communityLanguage",
              old: updated.previous.language,
              new: updated.settings.language,
            },
          ]
        : []),
      ...(about !== undefined && updated.previous.about !== updated.settings.about
        ? [
            {
              key: "communityAbout",
              old: updated.previous.about,
              new: updated.settings.about,
            },
          ]
        : []),
      ...(links !== undefined &&
      JSON.stringify(updated.previous.links) !==
        JSON.stringify(updated.settings.links)
        ? [
            {
              key: "communityLinks",
              old: updated.previous.links,
              new: updated.settings.links,
            },
          ]
        : []),
      ...(featured !== undefined &&
      JSON.stringify(updated.previous.featured) !==
        JSON.stringify(updated.settings.featured)
        ? [
            {
              key: "communityFeatured",
              old: updated.previous.featured,
              new: updated.settings.featured,
            },
          ]
        : []),
    ];
    if (changes.length > 0) {
      await logAudit({
        serverId: serverId!,
        actorId: user.id,
        action: "server.community_update",
        targetType: "server",
        targetId: serverId!,
        changes,
      });
    }

    return { ok: true, community: updated.settings };
  },
);

router.delete("/api/servers/:serverId", async ({ user }, { serverId }) => {
  await requireOwner(serverId!, user.id);
  const channelIds = await listServerChannelIds(serverId!);
  await deleteServer(serverId!);
  for (const channelId of channelIds) {
    evictVoiceChannel(channelId);
    evictChannelViewers(channelId);
  }
  return { ok: true };
});

router.post("/api/servers/:serverId/leave", async ({ user }, { serverId }) => {
  try {
    await leaveServer(serverId!, user.id);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Cannot leave server",
    );
  }
  const channelIds = await listServerChannelIds(serverId!);
  evictUserFromChannels(user.id, channelIds);
  evictVoiceUser(user.id, channelIds);
  return { ok: true };
});

router.get("/api/servers/:serverId/unread", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  return { unread: await listUnread(serverId!, user.id) };
});

// --------------------------------------------------------------- channels

router.get(
  "/api/servers/:serverId/channels",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    return etagged({
      channels: (await listChannels(serverId!, user.id)).map(mapChannel),
    });
  },
);

router.post(
  "/api/servers/:serverId/channels",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_CHANNELS);
    const body = createChannelSchema.parse(await readJsonBody(req));
    const channel = await createChannel(
      serverId!,
      body.name,
      body.type,
      body.isPrivate ?? false,
      body.topic ?? null,
    );
    if (channel.is_private) {
      await addChannelMember(channel.id, user.id);
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "channel.create",
      targetType: "channel",
      targetId: channel.id,
      changes: [{ key: "name", old: null, new: channel.name }],
    });
    return created({ channel: mapChannel(channel) });
  },
);

/**
 * What this voice channel is set to, and what it is actually doing.
 *
 * MANAGE_CHANNELS, because the only reader is the channel settings sheet and
 * that sheet already needs it: this adds no surface a member could not
 * already see. One call when the sheet opens, never polled.
 */
router.get(
  "/api/channels/:channelId/voice-transport",
  async ({ user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
    );
    if (channel.type !== "voice") {
      throw new NotFound("Not found");
    }
    return describeChannelVoiceTransport(channel);
  },
);

router.patch("/api/channels/:channelId", async ({ req, user }, { channelId }) => {
  const channel = await requireServerChannel(channelId!);
  await requirePermission(
    channel.server_id,
    user.id,
    Permission.MANAGE_CHANNELS,
  );
  const body = updateChannelSchema.parse(await readJsonBody(req));
  const updated = await updateChannel(channelId!, {
    name: body.name,
    isPrivate: body.isPrivate,
    topic: body.topic,
    imageUrl: body.imageUrl,
    slowmodeSeconds: body.slowmodeSeconds,
    voiceTransport: body.voiceTransport,
  });
  if (!updated) {
    throw new NotFound("Channel not found");
  }

  // Turning a channel private must immediately cut off anyone watching or
  // talking in it who is not on the access list. The audience query is the same
  // predicate canAccessChannel uses, so owners and admins — who keep access
  // without a channel_members row — are not evicted along with everyone else.
  if (updated.is_private && !channel.is_private) {
    const audience = await getChannelAudience(channelId!);
    const allowed = new Set(audience?.userIds ?? []);
    evictChannelViewers(channelId!, { exceptUserIds: [...allowed] });
    evictVoiceUsersExcept(channelId!, allowed);
    // --- threads --- a thread's audience IS the parent's, so going private
    // narrows every thread under this channel by exactly the same allow-list,
    // and their live viewers are cut off in the same breath.
    for (const threadId of await listThreadChannelIds(channelId!)) {
      evictChannelViewers(threadId, { exceptUserIds: [...allowed] });
    }
  }
  // The reverse: a channel that just went public needs nobody kept out
  // anymore, so any channel-private re-sweep still running for it (from an
  // earlier ban, or from an overwrite save while it was still private) is
  // cancelled rather than left to spend its window evicting people — and,
  // while the registry is off, the room's own HLS egress — who have every
  // right to be there now.
  if (!updated.is_private && channel.is_private) {
    void cancelPrivateVoiceResweep(channelId!);
  }
  if (body.isPrivate !== undefined && body.isPrivate !== channel.is_private) {
    pingPermissions(channel.server_id);
  }

  // `channel` (read for the authorization check above) already carries the
  // pre-update row, so the diff costs nothing extra to compute here.
  const changes = (
    [
      ["name", channel.name, updated.name],
      ["topic", channel.topic, updated.topic],
      ["isPrivate", channel.is_private, updated.is_private],
      ["imageUrl", channel.image_url, updated.image_url],
      ["slowmodeSeconds", channel.slowmode_seconds, updated.slowmode_seconds],
      ["voiceTransport", channel.voice_transport, updated.voice_transport],
    ] as const
  )
    .filter(([, oldValue, newValue]) => oldValue !== newValue)
    .map(([key, oldValue, newValue]) => ({ key, old: oldValue, new: newValue }));
  if (changes.length > 0) {
    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "channel.update",
      targetType: "channel",
      targetId: channelId!,
      changes,
    });
  }

  return { channel: mapChannel(updated) };
});

router.delete("/api/channels/:channelId", async ({ user }, { channelId }) => {
  const channel = await requireServerChannel(channelId!);
  await requirePermission(
    channel.server_id,
    user.id,
    Permission.MANAGE_CHANNELS,
  );
  await deleteChannel(channelId!);
  evictVoiceChannel(channelId!);
  evictChannelViewers(channelId!);
  await logAudit({
    serverId: channel.server_id,
    actorId: user.id,
    action: "channel.delete",
    targetType: "channel",
    targetId: channelId!,
    changes: [{ key: "name", old: channel.name, new: null }],
  });
  return { ok: true };
});

/**
 * Reorder or re-parent one channel. Answers with the whole server's fresh
 * channel list rather than a delta, matching how create/rename/delete already
 * behave here: none of the three broadcast live either, so the actor's own
 * client updates from its own response and everyone else sees the new order
 * on their next load. Adding a live broadcast for reorders only, while the
 * other three mutations stay silent, would be an inconsistency worth its own
 * change rather than a side effect of this one.
 */
router.patch(
  "/api/channels/:channelId/move",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
    );
    const body = moveChannelSchema.parse(await readJsonBody(req));

    try {
      await moveChannel(channel.server_id, channelId!, body.parentId, body.index);
    } catch (error) {
      if (error instanceof InvalidChannelMoveError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }

    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "channel.move",
      targetType: "channel",
      targetId: channelId!,
      changes: [
        { key: "parentId", old: channel.parent_id, new: body.parentId },
        { key: "index", old: channel.position, new: body.index },
      ],
    });

    return {
      channels: (await listChannels(channel.server_id, user.id)).map(mapChannel),
    };
  },
);

router.get(
  "/api/channels/:channelId/members",
  async ({ user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
    );
    return { members: await listChannelMembers(channelId!) };
  },
);

router.post(
  "/api/channels/:channelId/members",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
    );
    const body = addChannelMemberSchema.parse(await readJsonBody(req));
    if (!(await isServerMember(channel.server_id, body.userId))) {
      throw new HttpError(400, "User must be a server member");
    }
    await addChannelMember(channelId!, body.userId);
    await bumpPermissionsVersion(channel.server_id);
    pingPermissions(channel.server_id);
    return created({ ok: true });
  },
);

router.delete(
  "/api/channels/:channelId/members/:userId",
  async ({ user }, { channelId, userId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
    );
    await removeChannelMember(channelId!, userId!);
    if (channel.is_private) {
      evictChannelViewers(channelId!, { onlyUserIds: [userId!] });
      evictVoiceUser(userId!, new Set([channelId!]));
      // --- threads --- losing the private parent loses its threads too.
      for (const threadId of await listThreadChannelIds(channelId!)) {
        evictChannelViewers(threadId, { onlyUserIds: [userId!] });
      }
    }
    await bumpPermissionsVersion(channel.server_id);
    pingPermissions(channel.server_id);
    return { ok: true };
  },
);

router.post("/api/channels/:channelId/read", async ({ req, user }, { channelId }) => {
  await requireChannelAccess(channelId!, user.id);
  const body = markChannelReadSchema.parse(await readJsonBody(req));
  const result = await markChannelRead(
    channelId!,
    user.id,
    body.lastReadAt ? new Date(body.lastReadAt) : undefined,
  );
  return {
    ok: true as const,
    previousLastReadAt: result.previousLastReadAt?.toISOString() ?? null,
    lastReadAt: result.lastReadAt.toISOString(),
  };
});

// ----------------------------------------------------- watch party sessions

function mapChannelSessionError(error: unknown): never {
  if (error instanceof ChannelSessionError) {
    if (error.code === "not_found") {
      throw new NotFound(error.message);
    }
    throw new HttpError(409, error.message);
  }
  throw error;
}

router.post(
  "/api/channels/:channelId/sessions",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    // The REPLACE-WHEN-READY from PR #352, honoured: START_WATCH_PARTY is
    // what says "you may run a show here", and it is the same bit the stage
    // asks for, so a mod who can put a screen up can also announce it.
    // MANAGE_CHANNELS is not asked for and is not enough on its own; a
    // manager holds every bit anyway.
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.START_WATCH_PARTY,
      channelId!,
    );
    const body = createChannelSessionSchema.parse(await readJsonBody(req));
    if (new Date(body.startsAt).getTime() <= Date.now()) {
      throw new HttpError(400, "startsAt must be in the future");
    }
    try {
      const session = await createChannelSession({
        channelId: channelId!,
        serverId: channel.server_id,
        title: body.title,
        description: body.description ?? null,
        startsAt: body.startsAt,
        createdBy: user.id,
      });
      return { session };
    } catch (error) {
      mapChannelSessionError(error);
    }
  },
);

/**
 * The channel-level live state for a client that opened the channel before
 * its socket was up (or lost the `channel-live` frame): the stream stamped
 * for this caller, watchers without a seat, and seats. The socket path is
 * the live one; this is belt and braces, and the same VIEW check.
 */
router.get("/api/channels/:channelId/live", async ({ user }, { channelId }) => {
  await requireChannelAccess(channelId!, user.id);
  const state = await getChannelLiveState(channelId!);
  // WHICH OF THE TWO SILENCES THIS IS, and the client cannot work it out for
  // itself. "No stream" covers a show that is over and a presenter who has
  // stepped away from one that is still running, and the watch player's
  // holding screen has to say something different in each ("a sessão acabou"
  // against "esperando o apresentador voltar"). Only the party row knows.
  //
  // A BOOLEAN, NOT THE STATUS. A draft is somebody thinking and is invisible
  // to a viewer by design (`watchPartySurface`); a party being LIVE is
  // already broadcast to the whole server. So this answers the one bit that
  // is public anyway and leaks nothing the sidebar does not already show.
  // Cached per channel (`getActiveWatchPartyRow`), only asked on the answer
  // that needs it, and a lookup that throws leaves the field false rather
  // than failing a read the player depends on.
  const party =
    state.stream === null && state.known
      ? await getActiveWatchPartyRow(channelId!).catch(() => null)
      : null;
  return {
    stream: state.stream ? stampViewerStream(state.stream, user.id) : null,
    // Absent on a null the server could not vouch for (the session table was
    // unreachable), so the client holds what it has instead of reading one
    // failed query as the party being over. Same contract as `channel-live`.
    ...(state.stream === null && state.known
      ? { ended: true, partyLive: party?.status === "live" }
      : {}),
    watching: state.watching,
    participants: state.participants,
  };
});

router.get(
  "/api/channels/:channelId/sessions/upcoming",
  async ({ user }, { channelId }) => {
    await requireChannelAccess(channelId!, user.id);
    return { sessions: await listUpcomingChannelSessions(channelId!, user.id) };
  },
);

router.get(
  "/api/servers/:serverId/sessions/upcoming",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    return {
      sessions: await listUpcomingChannelSessionsForServer(serverId!, user.id),
    };
  },
);

router.patch("/api/sessions/:sessionId", async ({ req, user }, { sessionId }) => {
  const existing = await getChannelSession(sessionId!);
  if (!existing) {
    throw new NotFound("Session not found");
  }
  const channel = await requireServerChannel(existing.channel_id);
  // The host of the session edits their own; MANAGE_CHANNELS edits anyone's.
  // Before this only the second half existed, so a mod who scheduled a
  // session on a channel they did not manage could not fix its time.
  if (existing.host_user_id !== user.id) {
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_CHANNELS,
      existing.channel_id,
    );
  }
  const body = updateChannelSessionSchema.parse(await readJsonBody(req));
  if (body.startsAt && new Date(body.startsAt).getTime() <= Date.now()) {
    throw new HttpError(400, "startsAt must be in the future");
  }
  try {
    return { session: await updateChannelSession(sessionId!, user.id, body) };
  } catch (error) {
    mapChannelSessionError(error);
  }
});

router.post(
  "/api/sessions/:sessionId/cancel",
  async ({ user }, { sessionId }) => {
    const existing = await getChannelSession(sessionId!);
    if (!existing) {
      throw new NotFound("Session not found");
    }
    const channel = await requireServerChannel(existing.channel_id);
    if (existing.host_user_id !== user.id) {
      await requirePermission(
        channel.server_id,
        user.id,
        Permission.MANAGE_CHANNELS,
        existing.channel_id,
      );
    }
    try {
      await cancelChannelSession(sessionId!);
    } catch (error) {
      mapChannelSessionError(error);
    }
    return { ok: true as const };
  },
);

router.post(
  "/api/sessions/:sessionId/remind",
  async ({ user }, { sessionId }) => {
    const existing = await getChannelSession(sessionId!);
    if (!existing) {
      throw new NotFound("Session not found");
    }
    await requireChannelAccess(existing.channel_id, user.id);
    await setChannelSessionReminder(sessionId!, user.id, true);
    return { ok: true as const, reminding: true as const };
  },
);

router.delete(
  "/api/sessions/:sessionId/remind",
  async ({ user }, { sessionId }) => {
    const existing = await getChannelSession(sessionId!);
    if (!existing) {
      throw new NotFound("Session not found");
    }
    await requireChannelAccess(existing.channel_id, user.id);
    await setChannelSessionReminder(sessionId!, user.id, false);
    return { ok: true as const, reminding: false as const };
  },
);


// ------------------------------------------------------- watch parties (event)
/**
 * CONVIDADOS: the guest queue. `docs/plans/WATCH_PARTY_GUESTS.md` §5.8.
 *
 * `/guests` is the route's name; `/stage` is kept as an alias for one release
 * (the compatibility window §2.2 describes) so a stale tab or a native app
 * that has not shipped this yet keeps calling the URL it already knows,
 * carrying the same eight-action body — `watchPartyGuestsRequestSchema` is
 * `watchPartyStageRequestSchema`'s new name, not a new shape.
 *
 * THREE DIFFERENT AUTHORISATIONS, one per group of actions:
 *  - `invite` / `accept` / `decline` / `remove` are the host's and co-hosts',
 *    through the `manageGuests` action — host and co-host only, deliberately
 *    NOT a manager: the roster of who is on air is the show's own call.
 *  - `request` / `withdraw` are a viewer's own, rate-limited
 *    (`guestRequestLimiter`) and refused unless `guests === "request"`.
 *  - `join` / `leave` are the invited person's own, on their own row.
 */
const handleWatchPartyGuestsAction: RouteHandler = async (
  { req, user },
  { sessionId },
) => {
    const body = watchPartyGuestsRequestSchema.parse(await readJsonBody(req));
    const hostSide =
      body.action === "invite" ||
      body.action === "accept" ||
      body.action === "decline" ||
      body.action === "remove";
    const { row, actor } = await requireWatchParty(
      sessionId!,
      user.id,
      hostSide ? "manageGuests" : "view",
    );
    const options = watchPartyOptionsOf(row);

    if (hostSide) {
      if (body.action === "invite") {
        if (!(await canAccessChannel(row.channel_id, body.userId))) {
          throw new HttpError(400, "That person cannot see this channel");
        }
        await inviteWatchPartyGuest(row, body.userId, user.id);
      } else if (body.action === "accept") {
        try {
          await acceptWatchPartyGuestRequest(row, body.userId, user.id);
        } catch (error) {
          if (error instanceof WatchPartyGuestsError) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
      } else if (body.action === "decline") {
        try {
          await declineWatchPartyGuestRequest(sessionId!, body.userId);
        } catch (error) {
          if (error instanceof WatchPartyGuestsError) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
      } else {
        // `remove`. VERIFY FIRST. Muting, revoking a publish grant and
        // evicting from the room are SFU/channel actions whose blast radius
        // is well past this feature — nothing upstream of this branch checks
        // that `body.userId` is actually a guest of this party (`manageGuests`
        // authorises the CALLER, not the target), so without this check a
        // host could silence and eject anybody's live SFU session on the
        // strength of a `userId` that was never invited at all.
        if (!(await isWatchPartyGuest(row.id, body.userId))) {
          throw new HttpError(404, "That person is not a guest of this party");
        }
        // Mute, then revoke the publish grant, then eject, THEN delete the
        // row — in that order, per §3.6: ejecting first leaves a window
        // where a client that has not processed the disconnect is still
        // publishing.
        if (getRoomTransport(row.channel_id) === "livekit") {
          const identities = await findVoicePeerIdentities(
            body.userId,
            row.channel_id,
          );
          await setSfuUserMuted(row.channel_id, body.userId, true, identities);
          await setSfuUserCanPublish(
            row.channel_id,
            body.userId,
            { canSpeak: false, canStream: false, canShowFace: false },
            identities,
          );
          await evictSfuUser(body.userId, [row.channel_id], identities);
        }
        await removeWatchPartyGuest(row, body.userId);
      }
    } else if (body.action === "request" || body.action === "withdraw") {
      if (!guestRequestLimiter.take(user.id)) {
        throw new HttpError(429, "Slow down");
      }
      if (body.action === "withdraw") {
        await withdrawWatchPartyGuestRequest(sessionId!, user.id);
      } else {
        if (options.guests !== "request") {
          throw new HttpError(403, "This party is not taking requests");
        }
        if (row.status !== "live") {
          throw new HttpError(409, "This watch party is not live");
        }
        const declinedAt = await watchPartyGuestDeclinedAt(sessionId!, user.id);
        if (guestRequestCooldownActive(declinedAt)) {
          throw new HttpError(429, "Try again in a few minutes");
        }
        await requestWatchPartyGuestSlot(sessionId!, user.id);
      }
    } else if (body.action === "join") {
      try {
        await joinWatchPartyGuestSlot(row, user.id);
      } catch (error) {
        if (error instanceof WatchPartyGuestsError) {
          throw new HttpError(error.code === "full" ? 409 : 404, error.message);
        }
        throw error;
      }
    } else {
      // `leave`
      await leaveWatchPartyGuestSlot(row, user.id);
    }
    void broadcastWatchParty(sessionId!);
    const updated = await getWatchPartyRow(sessionId!);
    return { party: updated ? await presentWatchParty(updated, actor) : null };
};

router.post("/api/watch-parties/:sessionId/guests", handleWatchPartyGuestsAction);
router.post("/api/watch-parties/:sessionId/stage", handleWatchPartyGuestsAction);



/**
 * The watch party journey. `docs/WATCH_PARTY.md` has the ownership rules; the
 * state machine and the role table live in
 * `packages/shared/src/watch-party-session.ts` and are imported by both sides
 * so a button the client renders and a route the server allows cannot drift.
 *
 * A party is a `channel_sessions` row. These routes are the only ones that
 * know about `draft`, co-hosts and options; the `/api/sessions/...` routes
 * above stay exactly what PR #352 shipped, for the schedule card.
 */
function mapWatchPartyError(error: unknown): never {
  if (error instanceof WatchPartyError) {
    if (error.code === "not_found") {
      throw new NotFound(error.message);
    }
    if (error.code === "forbidden") {
      throw new HttpError(403, error.message);
    }
    throw new HttpError(409, error.message);
  }
  throw error;
}

/**
 * The create routes' 409, with the blocking party named.
 *
 * "This channel already has a watch party being set up, scheduled, or live"
 * was, on 2026-09-18, the entire answer a server owner got while a co-host's
 * abandoned draft held their channel, and a draft is the one thing they
 * could not then find in any list, because a draft is invisible to everyone
 * but its host. The id and the state go in the body so the caller has
 * something to act on, which with the staff override above is a `cancel`
 * they are now allowed to make.
 */
async function watchPartyCreateConflict(
  error: unknown,
  channelId: string,
): Promise<never> {
  if (error instanceof WatchPartyError && error.code === "conflict") {
    const blocking = await getBlockingWatchParty(channelId).catch(() => null);
    if (blocking) {
      throw new HttpErrorWithDetail(409, error.message, {
        blockingParty: blocking,
      });
    }
  }
  mapWatchPartyError(error);
}

/**
 * CREATE A PARTY, AND DO NOT LET AN ABANDONED DRAFT STOP IT.
 *
 * Both create routes go through here. The first attempt is exactly what it
 * always was. Only a `conflict` (the partial unique index, which is the
 * ONLY thing that can make two creates in one channel fail) reaches the
 * second half, which asks whether the thing in the way is an abandoned draft
 * and, if it is, cancels it properly and tries once more.
 *
 * EXACTLY ONE RETRY. A second conflict after a successful supersede means
 * somebody else created a party in the gap, which is a real conflict about a
 * real party and should be reported as one. Looping here would turn a busy
 * channel into a race nobody wins.
 *
 * The presence half is read from THIS process, which is where the host's
 * socket would be if they were on the setup sheet. `hasClusterSocket` covers
 * the other machine wherever `CLUSTER_BUS` is on; without it a connected
 * host on the other machine reads as gone, and their draft is superseded a
 * little sooner than it might have been. That is the direction to be wrong
 * in: the alternative is the 409 that cost an evening.
 */
async function createWatchPartyUnblocking(
  input: Parameters<typeof createWatchParty>[0],
): Promise<Awaited<ReturnType<typeof createWatchParty>>> {
  try {
    return await createWatchParty(input);
  } catch (error) {
    if (!(error instanceof WatchPartyError) || error.code !== "conflict") {
      throw error;
    }
    const superseded = await supersedeStaleWatchPartyDraft({
      channelId: input.channelId,
      requesterId: input.hostUserId,
      isConnected: (userId) =>
        userHasAuthenticatedSocket(userId) || hasClusterSocket(userId),
    });
    if (!superseded) {
      throw error;
    }
    // The person who abandoned it is told it is gone, same as every other
    // ending. Fire-and-forget: the create must not wait on a fan-out.
    void broadcastWatchParty(superseded.sessionId);
    return await createWatchParty(input);
  }
}

/** The actor's effective permissions on the party's channel. */
async function watchPartyActor(
  channel: { server_id: string; id: string },
  userId: string,
): Promise<{ userId: string; permissions: bigint }> {
  return {
    userId,
    permissions: await computeMemberPermissions(
      channel.server_id,
      userId,
      channel.id,
    ),
  };
}

/**
 * Load the party, check the actor may do this to it, and hand back everything
 * the route needs. Every mutating route starts here, so "who may" is asked in
 * one place and asked before anything is written.
 */
async function requireWatchParty(
  sessionId: string,
  userId: string,
  action: WatchPartyAction,
) {
  const loaded = await loadWatchPartyForActor(sessionId, userId);
  try {
    const { role } = await authoriseWatchParty(loaded.row, loaded.actor, action);
    return { ...loaded, role };
  } catch (error) {
    mapWatchPartyError(error);
  }
}

/**
 * The half of `requireWatchParty` that is about EXISTENCE rather than
 * authority: the party is real and this person can reach the channel it is
 * in. Split out because the state route has to answer one question before it
 * asks what the actor may do (is this party already over?) before asking what
 * they may do to it. Asking the
 * action first is what produced "A host may not end a ended watch party" for
 * a host pressing Encerrar on a party the SERVER had ended behind them.
 *
 * The 404 for a non-member is unchanged and stays in one place.
 */
async function loadWatchPartyForActor(sessionId: string, userId: string) {
  const row = await getWatchPartyRow(sessionId);
  if (!row) {
    throw new NotFound("Watch party not found");
  }
  const channel = await requireServerChannel(row.channel_id);
  if (!(await canAccessChannel(row.channel_id, userId))) {
    throw new NotFound("Watch party not found");
  }
  const actor = await watchPartyActor(channel, userId);
  return { row, channel, actor };
}

/**
 * START A WATCH PARTY, without first making a channel for it.
 *
 * The action Rafael asked for: one control for people who hold
 * START_WATCH_PARTY, no channel type to pick, no room to name. This finds or
 * makes the server's hidden party room and opens a draft in it, so the client
 * needs one call rather than a create-channel followed by a create-party.
 *
 * ASKED OF THE SERVER, NOT A CHANNEL, because there may be no channel yet. A
 * per-channel deny on the room that already exists is still honoured: the
 * draft is created through the same service the per-channel route uses, and
 * everything after this point (going live, the stage, the egress) re-resolves
 * the bit against the actual channel.
 */
router.post(
  "/api/servers/:serverId/watch-parties",
  async ({ req, user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    await requirePermission(serverId!, user.id, Permission.START_WATCH_PARTY);
    const body = createWatchPartySchema.parse(await readJsonBody(req));
    if (body.startsAt && new Date(body.startsAt).getTime() <= Date.now()) {
      throw new HttpError(400, "startsAt must be in the future");
    }
    const channelId = await findOrCreateWatchPartyRoom(serverId!);
    const channel = await requireServerChannel(channelId);
    // The room may have just been created, so the client has never seen it.
    // Handing it back whole lets the caller put it in its channel list and
    // select it in one go, the same way the create-channel route does; a bare
    // id would select a channel the client cannot resolve, which is a blank
    // "Escolha um canal" pane on the very click that starts the party.
    const room = mapChannel(channel);
    try {
      const row = await createWatchPartyUnblocking({
        channelId,
        serverId: channel.server_id,
        name: body.name,
        description: body.description ?? null,
        startsAt: body.startsAt ?? null,
        options: body.options ?? {},
        hostUserId: user.id,
      });
      // Funnel step `first_watch_party` -- the host created a party. See the
      // note on `first_watch_party_at` in schema.sql for why hosting, not
      // watching, is the signal.
      await recordActivationStep(user.id, "first_watch_party");
      const actor = await watchPartyActor(channel, user.id);
      const party = await presentWatchParty(row, actor);
      void broadcastWatchParty(row.id);
      return { party, channel: room };
    } catch (error) {
      await watchPartyCreateConflict(error, channelId);
    }
  },
);

router.post(
  "/api/channels/:channelId/watch-parties",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.START_WATCH_PARTY,
      channelId!,
    );
    const body = createWatchPartySchema.parse(await readJsonBody(req));
    if (body.startsAt && new Date(body.startsAt).getTime() <= Date.now()) {
      throw new HttpError(400, "startsAt must be in the future");
    }
    try {
      const row = await createWatchPartyUnblocking({
        channelId: channelId!,
        serverId: channel.server_id,
        name: body.name,
        description: body.description ?? null,
        startsAt: body.startsAt ?? null,
        options: body.options ?? {},
        hostUserId: user.id,
      });
      // Funnel step `first_watch_party` -- the host created a party (a draft
      // counts: the intent is the signal). See `first_watch_party_at` in
      // schema.sql for why hosting, not watching, is what the funnel measures.
      await recordActivationStep(user.id, "first_watch_party");
      const actor = await watchPartyActor(channel, user.id);
      const party = await presentWatchParty(row, actor);
      // A draft is announced to nobody. `broadcastWatchParty` re-resolves the
      // audience per socket and drops anyone who may not see this state, so
      // calling it here is safe as well as correct for a scheduled party.
      void broadcastWatchParty(row.id);
      return { party };
    } catch (error) {
      await watchPartyCreateConflict(error, channelId!);
    }
  },
);

/** The channel's active party as this person may see it, or null. */
router.get(
  "/api/channels/:channelId/watch-party",
  async ({ user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requireChannelAccess(channelId!, user.id);
    const row = await getActiveWatchPartyRow(channelId!);
    if (!row) {
      return { party: null };
    }
    const actor = await watchPartyActor(channel, user.id);
    return { party: await presentWatchParty(row, actor) };
  },
);

/**
 * Every party in the server this person may see, for the sidebar's live
 * block. One request per server rather than one per channel: the block sits
 * above the categories and has to know before any channel is opened.
 */
router.get(
  "/api/servers/:serverId/watch-parties",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    const cache = new Map<string, bigint>();
    const parties = await listActiveWatchPartiesForServer(serverId!, {
      userId: user.id,
      permissionsFor: async (channelId) => {
        const hit = cache.get(channelId);
        if (hit !== undefined) {
          return hit;
        }
        const perms = await computeMemberPermissions(
          serverId!,
          user.id,
          channelId,
        );
        cache.set(channelId, perms);
        return perms;
      },
    });
    // A party on a channel this person cannot see must not leak through the
    // server-wide list, which is why VIEW is re-checked per channel here and
    // not trusted to the party's own row.
    const visible: typeof parties = [];
    for (const party of parties) {
      if (await canAccessChannel(party.channelId, user.id)) {
        visible.push(party);
      }
    }
    return { parties: visible };
  },
);

router.patch("/api/watch-parties/:sessionId", async ({ req, user }, { sessionId }) => {
  const { row, actor, role } = await requireWatchParty(sessionId!, user.id, "edit");
  const body = updateWatchPartySchema.parse(await readJsonBody(req));
  if (body.startsAt && new Date(body.startsAt).getTime() <= Date.now()) {
    throw new HttpError(400, "startsAt must be in the future");
  }
  // "Baixa latência (beta)" IS HOST-ONLY, AND `edit` (this route's own gate)
  // ALSO ALLOWS A CO-HOST OR A MANAGER. Every other field on
  // `watchPartyOptionsSchema` is fine for any of them to set -- this one
  // reaches the server only through the host's own `goLive`
  // (`requestedHlsModeForChannel` in `hls-remux.ts`), so a co-host's or
  // manager's request here would be silently overwritten by the host's next
  // "Ir ao vivo" ANYWAY, but dropping it here rather than trusting that
  // timing is what makes the client's own host-only gate (`watch-party-
  // options.tsx`) an actual rule instead of a suggestion. The key is
  // OMITTED, not set to `undefined`: `updateWatchParty` merges this object
  // onto the party's EXISTING options before re-parsing, and
  // `watchPartyOptionsSchema`'s `.default(false)` treats an explicit
  // `undefined` exactly like a missing key -- setting it would have reset
  // the host's own saved preference to `false` rather than leaving it
  // untouched. Omitted this way, the merge never touches it at all. The rest
  // of a bundled patch (slow mode, reactions) still lands for a co-host who
  // never asked to change this field in the first place.
  let options = body.options;
  if (options && role !== "host" && "lowLatency" in options) {
    const { lowLatency: _lowLatency, ...rest } = options;
    options = rest;
  }
  try {
    const updated = await updateWatchParty(sessionId!, {
      name: body.name,
      description: body.description,
      startsAt: body.startsAt,
      options,
    });
    // The options are editable WHILE the party runs, and a host moving "quem
    // pode falar" from `everyone` to `hosts_only` mid-show has to take effect
    // for the people already in the room. The reconciler is idempotent, so
    // calling it for a rename costs one read and writes nothing.
    if (body.options) {
      await reconcileLiveWatchPartyOptions(sessionId!).catch((error) => {
        console.error("[watch-party] option reconcile failed:", error);
      });
    }
    void broadcastWatchParty(row.id);
    return { party: await presentWatchParty(updated, actor) };
  } catch (error) {
    mapWatchPartyError(error);
  }
});

/**
 * The one route that moves a party: Ir ao vivo, Encerrar, Cancelar, and
 * publishing a draft.
 *
 * ONE ROUTE RATHER THAN FOUR because the transition table already says which
 * moves exist and the role table already says who may make them. Four routes
 * would be four places to forget one of those two checks.
 */
router.post(
  "/api/watch-parties/:sessionId/state",
  async ({ req, user }, { sessionId }) => {
    const body = watchPartyStateRequestSchema.parse(await readJsonBody(req));
    const action: WatchPartyAction =
      body.state === "live"
        ? "goLive"
        : body.state === "ended"
          ? "end"
          : body.state === "cancelled"
            ? "cancel"
            : "schedule";
    // ENDING SOMETHING THAT HAS ALREADY ENDED IS A SUCCESS, NOT A REFUSAL.
    //
    // Rafael, 2026-09-18: the server itself ended a live party (the sharer
    // vanished), the tab never heard about it, and pressing Encerrar answered
    // 403 "A host may not end a ended watch party". Every word of that is
    // technically true and the whole sentence is wrong: the host asked for a
    // state the party is already in, and got told off for it. The same
    // happens whenever two of the host's own tabs are open, or the sweep gets
    // there a second before the click.
    //
    // A terminal transition is therefore IDEMPOTENT: the answer is the party,
    // in the state the caller wanted, with 200. Only for the two terminal
    // states. Asking a live party to go `live` again, or an ended one to go
    // `scheduled`, is still a conflict, because those are requests for a move
    // rather than a restatement of where the thing already is.
    //
    // The authority check is still real. It just asks "may this person stop
    // parties here", not "may this person stop THIS party, in THIS state",
    // because the second question has no good answer for a party that is over.
    const loaded = await loadWatchPartyForActor(sessionId!, user.id);
    if (
      isWatchPartyTerminal(loaded.row.status) &&
      (body.state === "ended" || body.state === "cancelled")
    ) {
      const cohostIds = await listCohostIds(loaded.row.id);
      const mayStop =
        user.id === loaded.row.host_user_id ||
        cohostIds.includes(user.id) ||
        hasWatchPartyStaffPermission(loaded.actor.permissions);
      if (!mayStop) {
        throw new HttpError(
          403,
          watchPartyRefusalMessage({
            action,
            role: watchPartyRole({
              userId: user.id,
              hostUserId: loaded.row.host_user_id,
              cohostUserIds: cohostIds,
              permissions: loaded.actor.permissions,
            }),
            state: loaded.row.status,
          }),
        );
      }
      return { party: await presentWatchParty(loaded.row, loaded.actor) };
    }
    const { row, actor } = await requireWatchParty(sessionId!, user.id, action);
    try {
      const moved = await transitionWatchParty(
        sessionId!,
        body.state,
        row.status,
      );
      // The LL-HLS request field (`docs/plans/LL_HLS.md` L1.5), persisted on
      // the party's own row (`channel_sessions.low_latency_requested`) so
      // `reconcileLiveHlsNow` can read it once a sharer actually appears --
      // which can be well after this call returns, and can survive an API
      // restart in between (a Farol finding on PR #580: an in-memory version
      // did not). Set unconditionally, not only when true: a party going
      // live again without `lowLatency` must not inherit a previous party's
      // request for this channel.
      if (action === "goLive") {
        await setRequestedHlsMode(sessionId!, Boolean(body.lowLatency));
      }
      // Going live is the moment the host's setup choices become the room's
      // rules. Slow mode is a channel field owned by the chat feature; the
      // party only carries what the host picked in the sheet so one press
      // applies it, and ending puts it back.
      await applyWatchPartyOptions(moved, body.state);
      void broadcastWatchParty(sessionId!);
      return { party: await presentWatchParty(moved, actor) };
    } catch (error) {
      mapWatchPartyError(error);
    }
  },
);

router.post(
  "/api/watch-parties/:sessionId/cohosts",
  async ({ req, user }, { sessionId }) => {
    const body = watchPartyCohostRequestSchema.parse(await readJsonBody(req));
    const { row, actor, channel } = await requireWatchParty(
      sessionId!,
      user.id,
      body.cohost ? "promoteCohost" : "demoteCohost",
    );
    if (body.userId === row.host_user_id) {
      throw new HttpError(409, "The host is already running this party");
    }
    if (body.cohost) {
      // A co-host has to be able to reach the channel in the first place;
      // promoting someone who cannot see the room produces a person with
      // authority over a party they cannot open.
      if (!(await canAccessChannel(row.channel_id, body.userId))) {
        throw new HttpError(400, "That person cannot see this channel");
      }
      await requireServerMember(channel.server_id, body.userId);
      await addWatchPartyCohost(row, body.userId, user.id);
    } else {
      await removeWatchPartyCohost(row, body.userId);
    }
    void broadcastWatchParty(sessionId!);
    const updated = await getWatchPartyRow(sessionId!);
    return { party: updated ? await presentWatchParty(updated, actor) : null };
  },
);

/**
 * Hand the party over, or take it after the host dropped.
 *
 * Both live here because they are the same write with different authority:
 * `{ userId }` is the host delegating, `{ claim: true }` is a co-host
 * succeeding. Splitting them would duplicate the transfer transaction.
 */
router.post(
  "/api/watch-parties/:sessionId/host",
  async ({ req, user }, { sessionId }) => {
    const body = watchPartyHostRequestSchema.parse(await readJsonBody(req));
    const claiming = body.claim === true;
    const { row, actor, channel } = await requireWatchParty(
      sessionId!,
      user.id,
      claiming ? "claimHost" : "transferHost",
    );
    const newHostId = claiming ? user.id : body.userId;
    if (!newHostId) {
      throw new HttpError(400, "userId is required to hand the party over");
    }
    if (!claiming) {
      await requireServerMember(channel.server_id, newHostId);
      if (!(await canAccessChannel(row.channel_id, newHostId))) {
        throw new HttpError(400, "That person cannot see this channel");
      }
    }
    try {
      const moved = await transferWatchPartyHost(sessionId!, newHostId);
      void broadcastWatchParty(sessionId!);
      return { party: await presentWatchParty(moved, actor) };
    } catch (error) {
      mapWatchPartyError(error);
    }
  },
);

// ------------------------------------------- watch party history (replay)
/**
 * "Transmissões anteriores": past broadcasts for a watch-party channel, for
 * the owner and moderators to find yesterday's stream. Gated on the
 * channel's START_WATCH_PARTY (whoever can go live) or MANAGE_CHANNELS
 * (whoever administers the room), the same pair `docs/WATCH_PARTY.md`
 * already treats as "runs this room". `hls-history.ts` has the retention
 * and grouping reasoning; this is just the HTTP surface over it.
 */
async function requireWatchPartyHistoryAccess(
  channel: { server_id: string; id: string },
  userId: string,
): Promise<void> {
  await requireServerMember(channel.server_id, userId);
  const allowed =
    (await memberHasPermission(
      channel.server_id,
      userId,
      Permission.START_WATCH_PARTY,
      channel.id,
    )) ||
    (await memberHasPermission(
      channel.server_id,
      userId,
      Permission.MANAGE_CHANNELS,
      channel.id,
    ));
  if (!allowed) {
    throw new Forbidden("You do not have permission to do that");
  }
}

/**
 * The path segment is `:sessionAt` rather than `:sessionId` -- it carries the
 * broadcast's `started_at` in epoch ms (see `hls-history.ts`'s
 * `WatchPartyHistoryEntry.sessionId`, which is the same value, just named
 * for the response body rather than the route). `router.ts` requires any
 * param ending in `Id` to be a UUID and 404s otherwise, which a timestamp
 * never is; naming it `sessionId` here would 404 every request before this
 * function ever ran.
 */
function parseWatchPartyHistorySessionAt(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !/^\d{1,20}$/.test(raw) || !Number.isFinite(parsed)) {
    throw new NotFound("Broadcast not found");
  }
  return parsed;
}

const HISTORY_PAGE_SIZE = 20;
const HISTORY_PAGE_MAX = 50;

router.get(
  "/api/channels/:channelId/watch-party/history",
  async ({ user, url }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requireWatchPartyHistoryAccess(channel, user.id);
    const limit = clampLimit(
      url.searchParams.get("limit"),
      HISTORY_PAGE_SIZE,
      HISTORY_PAGE_MAX,
    );
    return { broadcasts: await listWatchPartyHistory(channelId!, limit) };
  },
);

const watchPartyHistoryPatchSchema = z.object({ keepReplay: z.boolean() });

router.patch(
  "/api/channels/:channelId/watch-party/history/:sessionAt",
  async ({ req, user }, { channelId, sessionAt }) => {
    const channel = await requireServerChannel(channelId!);
    await requireWatchPartyHistoryAccess(channel, user.id);
    const startedAtMs = parseWatchPartyHistorySessionAt(sessionAt);
    const body = watchPartyHistoryPatchSchema.parse(await readJsonBody(req));
    const result = await setWatchPartyKeepReplay(
      channelId!,
      startedAtMs,
      body.keepReplay,
    );
    if (result === "not-found") {
      throw new NotFound("Broadcast not found");
    }
    if (result === "unavailable") {
      throw new HttpError(
        409,
        "This broadcast's recording is no longer available",
      );
    }
    return {
      broadcasts: await listWatchPartyHistory(channelId!, HISTORY_PAGE_MAX),
    };
  },
);

router.get(
  "/api/channels/:channelId/watch-party/history/:sessionAt/replay",
  async ({ user }, { channelId, sessionAt }) => {
    const channel = await requireServerChannel(channelId!);
    await requireWatchPartyHistoryAccess(channel, user.id);
    const startedAtMs = parseWatchPartyHistorySessionAt(sessionAt);
    const access = await checkWatchPartyReplayAccess(channelId!, startedAtMs);
    if (access === "not-found") {
      throw new NotFound("Broadcast not found");
    }
    if (access === "unavailable") {
      throw new HttpError(
        409,
        "This broadcast's recording is no longer available",
      );
    }
    const token = mintHlsViewerToken({
      userId: user.id,
      channelId: channelId!,
      startedAt: startedAtMs,
      purpose: "replay",
    });
    const query = token
      ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(token)}`
      : "";
    return {
      hlsUrl: `/api/voice/hls-replay/${encodeURIComponent(channelId!)}/${startedAtMs}${query}`,
    };
  },
);

// ---------------------------------------- watch party history (download)
/**
 * "Baixar": the same past broadcast as a file, in up to three pieces -- the
 * film, the presenter's camera pip, and the host's voice archive. Same
 * permission as everything else on this surface
 * (`requireWatchPartyHistoryAccess`), same availability rule as replay (404
 * unknown, 409 once the retention sweep has been through), and the same
 * `?t=` capability in the URL.
 *
 * NOTHING IS TRANSCODED. The API hands back the objects the egress already
 * wrote: the rung's MPEG-TS segments concatenated in playlist order, or the
 * `.ogg` the Track Egress wrote, streamed through with backpressure and
 * never buffered. `hls-history.ts`'s download section has the reasoning for
 * why concatenated MPEG-TS is a real, playable file and what the one-line
 * ffmpeg remux to mp4 is.
 *
 * A DOWNLOAD IS A NAVIGATION, NOT A `fetch`. The client cannot ask the
 * browser to save a `fetch` response without buffering the whole broadcast
 * into a Blob in the tab, so the link is a plain `<a href download>` -- and
 * a navigation carries no `Authorization` header, cross-origin `download`
 * is ignored by the browser anyway (the SPA and the API are different
 * origins in production), and `Content-Disposition: attachment` is what
 * actually makes it a download. So the byte route has the same two doors
 * the replay proxy has, for the same reason: `?t=` alone is the shape the
 * product produces, and the Bearer door exists for everything else.
 */

/**
 * The handler wrote the whole response itself. `RawResponse` buffers its
 * body, which is exactly what a multi-gigabyte broadcast must not do, so a
 * streaming route answers with this instead and `handleApi` simply stops.
 */
class StreamedResponse {}

/** `Um Servidor` + `sala-de-cinema` + a date, as something a file system is
 * happy with. Never empty: the epoch date always survives the slug. */
function downloadFilenameStem(
  serverName: string,
  channelName: string,
  startedAtMs: number,
): string {
  const slug = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const date = new Date(startedAtMs).toISOString().slice(0, 10);
  return [slug(serverName), slug(channelName), date].filter(Boolean).join("-");
}

/** The camera and the voice get a suffix so all three can live in one
 * downloads folder without overwriting each other. */
function downloadFilename(stem: string, plan: WatchPartyDownloadPlan): string {
  const suffix =
    plan.kind === "camera" ? "-camera" : plan.kind === "voice" ? "-voice" : "";
  return `${stem}${suffix}.${plan.extension}`;
}

interface PreparedWatchPartyDownload {
  plan: WatchPartyDownloadPlan;
  filename: string;
}

/**
 * Everything that can still answer with a status code, done before a single
 * byte is written: the permission (or the capability), the same
 * availability check replay makes, and the object list itself. Once the head
 * is out a failure can only truncate the file.
 */
async function prepareWatchPartyDownload(input: {
  channelId: string;
  startedAtMs: number;
  kind: WatchPartyDownloadKind;
  userId: string;
  tokenIssuedAt: number | null;
}): Promise<PreparedWatchPartyDownload> {
  const channel = await requireServerChannel(input.channelId);
  if (input.tokenIssuedAt === null) {
    await requireWatchPartyHistoryAccess(channel, input.userId);
  } else if (
    isHlsAccessRevoked(input.userId, input.channelId, input.tokenIssuedAt)
  ) {
    throw new NotFound("Channel not found");
  }
  const access = await checkWatchPartyReplayAccess(
    input.channelId,
    input.startedAtMs,
  );
  if (access === "not-found") {
    throw new NotFound("Broadcast not found");
  }
  if (access === "unavailable") {
    throw new HttpError(
      409,
      "This broadcast's recording is no longer available",
    );
  }
  let plan: WatchPartyDownloadPlan | null;
  try {
    plan = await buildWatchPartyDownloadPlan(
      input.channelId,
      input.startedAtMs,
      input.kind,
    );
  } catch (error) {
    if (error instanceof HlsPlaylistUnavailable) {
      throw new HttpError(503, "Live HLS storage unavailable");
    }
    if (error instanceof HlsPlaylistNotFound) {
      // The playlist names an object the bucket no longer has: a half-swept
      // recording, which is the same thing to a moderator as a swept one and
      // answers with the same 409. Caught HERE rather than mid-stream, which
      // would hand back a file that looks complete and is not.
      throw new HttpError(
        409,
        "This broadcast's recording is no longer available",
      );
    }
    throw error;
  }
  if (!plan) {
    throw new NotFound("This broadcast has no such file");
  }
  const server = await getServer(channel.server_id);
  return {
    plan,
    filename: downloadFilename(
      downloadFilenameStem(
        server?.name ?? "pqp",
        channel.name,
        input.startedAtMs,
      ),
      plan,
    ),
  };
}

function sendWatchPartyDownload(
  req: IncomingMessage,
  res: ServerResponse,
  prepared: PreparedWatchPartyDownload,
): Promise<void> {
  const { plan, filename } = prepared;
  res.writeHead(200, {
    "content-type": plan.contentType,
    // The filename is a slug of `[a-z0-9-]` plus a date, so it needs no
    // quoting beyond the quotes.
    "content-disposition": `attachment; filename="${filename}"`,
    // Exact: the plan refuses to exist unless the listing priced every
    // object it names, so the browser's progress bar is never wrong.
    "content-length": String(plan.bytes),
    "cache-control": "private, no-store",
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  return streamWatchPartyDownload(plan, res).then(
    () => {
      res.end();
    },
    (error: unknown) => {
      // Mid-stream: the status line is long gone, so the only honest signal
      // left is an aborted response, which every client reports as a failed
      // download rather than a complete-looking truncated file.
      console.error("[voice] watch party download failed mid-stream:", error);
      res.destroy();
    },
  );
}

router.get(
  "/api/channels/:channelId/watch-party/history/:sessionAt/download",
  async ({ user }, { channelId, sessionAt }) => {
    const channel = await requireServerChannel(channelId!);
    await requireWatchPartyHistoryAccess(channel, user.id);
    const startedAtMs = parseWatchPartyHistorySessionAt(sessionAt);
    const access = await checkWatchPartyReplayAccess(channelId!, startedAtMs);
    if (access === "not-found") {
      throw new NotFound("Broadcast not found");
    }
    if (access === "unavailable") {
      throw new HttpError(
        409,
        "This broadcast's recording is no longer available",
      );
    }
    let sizes;
    try {
      sizes = await watchPartyDownloadSizes(channelId!, startedAtMs);
    } catch (error) {
      if (error instanceof HlsPlaylistUnavailable) {
        // Not "there is no camera": storage would not answer. The dialog
        // shows a retryable failure rather than claiming the night had no
        // camera and no voice.
        throw new HttpError(503, "Live HLS storage unavailable");
      }
      throw error;
    }
    const token = mintHlsViewerToken({
      userId: user.id,
      channelId: channelId!,
      startedAt: startedAtMs,
      purpose: "replay",
    });
    const query = token
      ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(token)}`
      : "";
    const downloads: Record<
      WatchPartyDownloadKind,
      { bytes: number | null; url: string } | null
    > = { film: null, camera: null, voice: null };
    for (const kind of WATCH_PARTY_DOWNLOAD_KINDS) {
      if (sizes[kind] === null) {
        continue;
      }
      downloads[kind] = {
        bytes: sizes[kind],
        url:
          `/api/channels/${encodeURIComponent(channelId!)}` +
          `/watch-party/history/${startedAtMs}/download/${kind}${query}`,
      };
    }
    return { downloads };
  },
);

router.get(
  "/api/channels/:channelId/watch-party/history/:sessionAt/download/:kind",
  async ({ req, res, user, url }, { channelId, sessionAt, kind }) => {
    const startedAtMs = parseWatchPartyHistorySessionAt(sessionAt);
    if (!kind || !isWatchPartyDownloadKind(kind)) {
      throw new NotFound("Broadcast not found");
    }
    const viewer = resolveHlsPlaylistViewer({
      bearerUserId: user.id,
      token: url.searchParams.get(HLS_VIEWER_TOKEN_PARAM),
      channelId: channelId!,
      startedAt: startedAtMs,
      purpose: "replay",
    });
    await sendWatchPartyDownload(
      req,
      res,
      await prepareWatchPartyDownload({
        channelId: channelId!,
        startedAtMs,
        kind,
        userId: viewer?.userId ?? user.id,
        tokenIssuedAt: viewer?.issuedAt ?? null,
      }),
    );
    return new StreamedResponse();
  },
);

const WATCH_PARTY_DOWNLOAD_PATH =
  /^\/api\/channels\/([0-9a-fA-F-]{36})\/watch-party\/history\/(\d{1,20})\/download\/([a-z]{1,16})$/;

/**
 * The header-less door for a download link, mirroring
 * `tryHlsReplayCapabilityDoor`. A browser navigating to `<a href download>`
 * sends no `Authorization`, so for the product's own link this door is the
 * only one that ever answers.
 */
async function tryWatchPartyDownloadCapabilityDoor(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = WATCH_PARTY_DOWNLOAD_PATH.exec(pathname);
  if (!match) {
    return false;
  }
  const kind = match[3]!;
  if (!isWatchPartyDownloadKind(kind)) {
    return false;
  }
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    HLS_VIEWER_TOKEN_PARAM,
  );
  const channelId = match[1]!;
  const startedAtMs = Number(match[2]);
  const viewer = resolveHlsPlaylistViewer({
    bearerUserId: null,
    token,
    channelId,
    startedAt: startedAtMs,
    purpose: "replay",
  });
  if (!viewer) {
    return false;
  }
  if (!apiLimiter.take(`user:${viewer.userId}`)) {
    res.setHeader(
      "Retry-After",
      String(apiLimiter.retryAfter(`user:${viewer.userId}`)),
    );
    sendError(res, 429, "Too many requests", req);
    return true;
  }
  try {
    await sendWatchPartyDownload(
      req,
      res,
      await prepareWatchPartyDownload({
        channelId,
        startedAtMs,
        kind,
        userId: viewer.userId,
        tokenIssuedAt: viewer.issuedAt ?? 0,
      }),
    );
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return true;
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return true;
    }
    console.error("[voice] watch party download (token) failed:", error);
    sendError(res, 500, "Internal server error", req);
  }
  return true;
}

/**
 * The replay playlist proxy: the same rewrite-segments-into-signed-URLs job
 * as the live one (`hlsPlaylistResponse` above), pointed at
 * `hls-history.ts`'s replay builders instead. Kept as its own path rather
 * than a mode on the live route on purpose -- see that file's header comment.
 *
 * BOTH DOORS CHECK THE HISTORY PERMISSION, NOT JUST CHANNEL ACCESS. A
 * replay is the moderator-only surface (`requireWatchPartyHistoryAccess`
 * gates the list, the toggle and the URL mint), and this proxy is the thing
 * that actually hands out the bytes, so it has to hold the same line: an
 * ordinary member who can see the channel (and so would pass
 * `requireChannelAccess`) must not be able to reach a recording just by
 * knowing or guessing a `startedAt`. The token door is closed the same way
 * one level up, by only ever minting a `purpose: "replay"` token from the
 * permission-checked mint route (`hls-viewer-token.ts`).
 */
async function hlsReplayResponse(
  res: ServerResponse,
  channelId: string,
  startedAt: string,
  userId: string,
  tokenIssuedAt: number | null,
  options: { rung?: string; token?: string | null } = {},
): Promise<RawResponse> {
  if (tokenIssuedAt === null) {
    const channel = await requireServerChannel(channelId);
    await requireWatchPartyHistoryAccess(channel, userId);
  } else if (isHlsAccessRevoked(userId, channelId, tokenIssuedAt)) {
    throw new NotFound("Channel not found");
  }
  const parsedStartedAt = Number(startedAt);
  if (!Number.isFinite(parsedStartedAt)) {
    throw new NotFound("No replay for this channel");
  }
  let body: string;
  try {
    // Inside the try since a low-latency broadcast's master is read from
    // storage (`buildLlReplayMasterPlaylist`), so it can fail like a rung can.
    const master = options.rung
      ? null
      : await buildReplayMasterPlaylist({
          channelId,
          startedAt: parsedStartedAt,
          token: options.token,
        });
    body =
      master ??
      (await buildReplaySignedPlaylist(
        channelId,
        parsedStartedAt,
        options.rung,
      ));
  } catch (error) {
    if (error instanceof HlsPlaylistNotFound) {
      throw new NotFound("No replay for this channel");
    }
    if (error instanceof HlsPlaylistUnavailable) {
      throw new HttpError(503, "Live HLS storage unavailable");
    }
    throw error;
  }
  res.setHeader("Cache-Control", "private, max-age=30");
  res.setHeader("Vary", "Authorization");
  return new RawResponse(body, "application/vnd.apple.mpegurl");
}

router.get(
  "/api/voice/hls-replay/:channelId/:startedAt",
  async ({ user, res, url }, { channelId, startedAt }) =>
    hlsReplayRouteResponse(res, url, user.id, channelId!, startedAt!),
);

router.get(
  "/api/voice/hls-replay/:channelId/:startedAt/:rung",
  async ({ user, res, url }, { channelId, startedAt, rung }) =>
    hlsReplayRouteResponse(res, url, user.id, channelId!, startedAt!, rung!),
);

function hlsReplayRouteResponse(
  res: ServerResponse,
  url: URL,
  bearerUserId: string,
  channelId: string,
  startedAt: string,
  rung?: string,
): Promise<RawResponse> {
  const token = url.searchParams.get(HLS_VIEWER_TOKEN_PARAM);
  const viewer = resolveHlsPlaylistViewer({
    bearerUserId,
    token,
    channelId,
    startedAt: Number(startedAt),
    purpose: "replay",
  });
  return hlsReplayResponse(
    res,
    channelId,
    startedAt,
    viewer?.userId ?? bearerUserId,
    viewer?.issuedAt ?? null,
    { rung, token },
  );
}

// The rung is optional: without it the path names the broadcast (the master
// playlist), with it one rendition. Mirrors `HLS_PLAYLIST_PATH` above.
const HLS_REPLAY_PATH =
  /^\/api\/voice\/hls-replay\/([^/]{1,64})\/(\d{1,20})(?:\/([A-Za-z0-9]{1,16}))?$/;

/**
 * The header-less door for a replay URL: our own client never attaches a
 * Bearer header to one of these (the URL already carries `?t=`, and
 * `isOwnHlsPlaylistProxyUrl` on the client only matches the live path
 * anyway), so this door is the ONLY way a replay request is ever served, not
 * a fallback. Mirrors `tryHlsCapabilityDoor`.
 */
async function tryHlsReplayCapabilityDoor(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const match = HLS_REPLAY_PATH.exec(pathname);
  if (!match) {
    return false;
  }
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    HLS_VIEWER_TOKEN_PARAM,
  );
  const channelId = match[1]!;
  const startedAt = Number(match[2]);
  const viewer = resolveHlsPlaylistViewer({
    bearerUserId: null,
    token,
    channelId,
    startedAt,
    purpose: "replay",
  });
  if (!viewer) {
    return false;
  }
  if (!apiLimiter.take(`user:${viewer.userId}`)) {
    res.setHeader(
      "Retry-After",
      String(apiLimiter.retryAfter(`user:${viewer.userId}`)),
    );
    sendError(res, 429, "Too many requests", req);
    return true;
  }
  try {
    const result = await hlsReplayResponse(
      res,
      channelId,
      match[2]!,
      viewer.userId,
      viewer.issuedAt ?? 0,
      { rung: match[3], token },
    );
    res.writeHead(200, {
      "content-type": result.contentType,
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
    });
    res.end(result.body);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return true;
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return true;
    }
    console.error("[voice] hls replay (token) failed:", error);
    sendError(res, 500, "Internal server error", req);
  }
  return true;
}

// -------------------------------------------------------------- webhooks

function mapWebhook(w: DbWebhook) {
  return {
    id: w.id,
    channelId: w.channel_id,
    name: w.name,
    avatarUrl: w.avatar_url,
    url: `/api/webhooks/${w.id}/${w.token}`,
    createdAt: w.created_at.toISOString(),
  };
}

router.get(
  "/api/channels/:channelId/webhooks",
  async ({ user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(channel.server_id, user.id, Permission.MANAGE_CHANNELS);
    return {
      webhooks: (await listWebhooksForChannel(channelId!)).map(mapWebhook),
    };
  },
);

router.post(
  "/api/channels/:channelId/webhooks",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(channel.server_id, user.id, Permission.MANAGE_CHANNELS);
    const body = createWebhookSchema.parse(await readJsonBody(req));
    const webhook = await createWebhook(
      channelId!,
      channel.server_id,
      body.name,
      body.avatarUrl ?? null,
      user.id,
    );
    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "webhook.create",
      targetType: "webhook",
      targetId: webhook.id,
      changes: [{ key: "name", old: null, new: webhook.name }],
    });
    return created({ webhook: mapWebhook(webhook) });
  },
);

router.delete("/api/webhooks/:webhookId", async ({ user }, { webhookId }) => {
  const webhook = await getWebhook(webhookId!);
  if (!webhook) {
    throw new NotFound("Webhook not found");
  }
  await requirePermission(webhook.server_id, user.id, Permission.MANAGE_CHANNELS);
  await deleteWebhook(webhookId!);
  await logAudit({
    serverId: webhook.server_id,
    actorId: user.id,
    action: "webhook.delete",
    targetType: "webhook",
    targetId: webhookId!,
    changes: [{ key: "name", old: webhook.name, new: null }],
  });
  return { ok: true };
});

// ------------------------------------------------------ outgoing webhooks
//
// Server-scoped. Gated on MANAGE_WEBHOOKS, not MANAGE_CHANNELS: incoming
// execute tokens stay on the channel-row permission so an admin who can
// make a CI bot cannot by itself subscribe an HTTPS URL to every message.

router.get(
  "/api/servers/:serverId/outgoing-webhooks",
  async ({ user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_WEBHOOKS);
    return { webhooks: await listOutgoingWebhooks(serverId!) };
  },
);

router.post(
  "/api/servers/:serverId/outgoing-webhooks",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_WEBHOOKS);
    const body = createOutgoingWebhookSchema.parse(await readJsonBody(req));
    const webhook = await createOutgoingWebhook(serverId!, user.id, body);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "outgoing_webhook.create",
      targetType: "outgoing_webhook",
      targetId: webhook.id,
      changes: [{ key: "name", old: null, new: webhook.name }],
    });
    return created({ webhook });
  },
);

router.patch(
  "/api/outgoing-webhooks/:id",
  async ({ req, user }, { id }) => {
    const existing = await getOutgoingWebhookRow(id!);
    if (!existing) {
      throw new NotFound("Webhook not found");
    }
    await requirePermission(
      existing.server_id,
      user.id,
      Permission.MANAGE_WEBHOOKS,
    );
    const body = updateOutgoingWebhookSchema.parse(await readJsonBody(req));
    const webhook = await updateOutgoingWebhook(id!, body);
    if (!webhook) {
      throw new NotFound("Webhook not found");
    }
    await logAudit({
      serverId: existing.server_id,
      actorId: user.id,
      action: "outgoing_webhook.update",
      targetType: "outgoing_webhook",
      targetId: id!,
      changes: [{ key: "name", old: existing.name, new: webhook.name }],
    });
    return { webhook };
  },
);

router.delete("/api/outgoing-webhooks/:id", async ({ user }, { id }) => {
  const existing = await getOutgoingWebhookRow(id!);
  if (!existing) {
    throw new NotFound("Webhook not found");
  }
  await requirePermission(
    existing.server_id,
    user.id,
    Permission.MANAGE_WEBHOOKS,
  );
  await deleteOutgoingWebhook(id!);
  await logAudit({
    serverId: existing.server_id,
    actorId: user.id,
    action: "outgoing_webhook.delete",
    targetType: "outgoing_webhook",
    targetId: id!,
    changes: [{ key: "name", old: existing.name, new: null }],
  });
  return { ok: true };
});

router.post(
  "/api/outgoing-webhooks/:id/rotate-secret",
  async ({ user }, { id }) => {
    const existing = await getOutgoingWebhookRow(id!);
    if (!existing) {
      throw new NotFound("Webhook not found");
    }
    await requirePermission(
      existing.server_id,
      user.id,
      Permission.MANAGE_WEBHOOKS,
    );
    const webhook = await rotateOutgoingWebhookSecret(id!);
    if (!webhook) {
      throw new NotFound("Webhook not found");
    }
    await logAudit({
      serverId: existing.server_id,
      actorId: user.id,
      action: "outgoing_webhook.rotate",
      targetType: "outgoing_webhook",
      targetId: id!,
      changes: [{ key: "secret", old: "(rotated)", new: "(rotated)" }],
    });
    return { webhook };
  },
);

// --------------------------------------------------------------- messages

/**
 * HTTP send for character accounts. Same `createMessage` + fan-out as the
 * WebSocket `message-create` frame, gated on `users.is_character` and the
 * existing `Bearer character:<token>` branch. A Clerk session cannot use
 * this; a character that is not in the channel gets the same 404 as any
 * other access miss.
 *
 * Text only. Attachments, chance and polls stay on the socket. A thread
 * reply is a POST to the thread's channel id.
 */
router.post(
  "/api/channels/:channelId/messages",
  async ({ req, res, user }, { channelId }) => {
    if (!user.is_character) {
      throw new Forbidden(
        "Only a character account can send messages over HTTP",
      );
    }
    const body = createChannelMessageSchema.parse(await readJsonBody(req));
    // The same per-user send bucket the socket charges, on top of the
    // API-wide `writeLimiter`. Without it HTTP would allow a burst three
    // times the size the socket does for the same account.
    const budget = takeMessageBudget(user.id);
    if (!budget.ok) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))),
      );
      throw new HttpError(429, "Slow down");
    }
    const posted = await postChannelMessage({
      author: user,
      channelId: channelId!,
      body: body.body,
      replyToId: body.replyToId,
    });
    if (!posted.ok) {
      switch (posted.reason) {
        case "no-access":
          throw new NotFound("Channel not found");
        case "cannot-send":
          throw new Forbidden("You cannot send messages here");
        case "undeliverable":
          throw new Forbidden("You cannot send to this conversation");
        case "slow-mode":
        case "rate-limited":
          if (posted.retryAfterMs && posted.retryAfterMs > 0) {
            res.setHeader(
              "Retry-After",
              String(Math.max(1, Math.ceil(posted.retryAfterMs / 1000))),
            );
          }
          throw new HttpError(429, "Slow down");
        case "automod":
          throw new HttpError(
            422,
            posted.automodMessage ?? "This message was blocked by AutoMod",
          );
        case "database-unavailable":
          throw new DatabaseUnavailableError();
        case "bad-reply":
          throw new HttpError(400, "Reply is not in this channel");
        case "empty":
          throw new HttpError(400, "A message needs a body");
        default: {
          posted.reason satisfies never;
          throw new HttpError(400, "A message needs a body");
        }
      }
    }
    return created({ message: posted.message });
  },
);

router.get(
  "/api/channels/:channelId/messages",
  async ({ url, user }, { channelId }) => {
    await requireChannelAccess(channelId!, user.id);

    const limit = clampLimit(
      url.searchParams.get("limit"),
      MESSAGE_PAGE_SIZE,
      MESSAGE_PAGE_MAX,
    );
    const before = url.searchParams.get("before") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    const around = url.searchParams.get("around") ?? undefined;
    const cursors = [before, after, around].filter(
      (cursor) => cursor !== undefined,
    );
    if (cursors.some((cursor) => !isUuid(cursor))) {
      throw new HttpError(400, "Invalid cursor");
    }
    // Combining them has no single answer for which end the page hangs off, and
    // silently picking one would page past history the caller thinks it read.
    if (cursors.length > 1) {
      throw new HttpError(400, "Use one cursor at a time");
    }

    try {
      const page = await listMessages(channelId!, {
        limit,
        before,
        after,
        around,
        viewerId: user.id,
      });
      // Conditional: this is the read a client makes every single time a
      // channel is opened, and most of those opens find nothing changed.
      return etagged({
        messages: page.messages.map(mapMessage),
        hasMore: page.hasMore,
        hasNewer: page.hasNewer,
      });
    } catch (error) {
      if (error instanceof UnknownCursorError) {
        throw new HttpError(400, "Unknown cursor");
      }
      throw error;
    }
  },
);

/**
 * The edit body for a message that carries attachments, where `""` is a legal
 * result: posting an image with a caption and then removing the caption is an
 * edit, not a delete. `updateMessageSchema` keeps its floor of one character for
 * every other message, because there an empty body *is* a delete wearing an
 * edit's clothes — and the shared schema cannot make the distinction, since it
 * never sees what the message already has attached.
 */
const captionEditSchema = z.object({
  body: messageBodyTextSchema,
});

router.patch("/api/messages/:messageId", async ({ req, user }, { messageId }) => {
  const existing = await getMessage(messageId!);
  if (!existing) {
    throw new NotFound("Message not found");
  }
  await requireChannelAccess(existing.channel_id, user.id);
  if (existing.author_id !== user.id) {
    throw new Forbidden("You can only edit your own messages");
  }

  // Editing is a send. The WebSocket paths all consult this guard, but an edit
  // arrives over HTTP, and without it a blocked person can rewrite a message
  // they left before the block into anything at all — `broadcastToChannel`
  // below then delivers the new body live into the blocker's open view. The
  // block would stop new messages and let arbitrary new text through anyway.
  if (await isDmSendBlocked(existing.channel_id, user.id)) {
    throw new Forbidden("You cannot send to this conversation");
  }

  const schema =
    existing.attachments.length > 0 ? captionEditSchema : updateMessageSchema;
  const body = schema.parse(await readJsonBody(req));

  // Same reasoning as the block guard above: an edit is a send. Without this
  // a member posts "hi", edits it into the blocked word, and AutoMod never
  // saw it. The check reads the same rules with the same exemptions as
  // `postChannelMessage`, and a hit is recorded the same way.
  if (existing.server_id) {
    const automodInput = {
      serverId: existing.server_id,
      channelId: existing.channel_id,
      authorId: user.id,
      memberPerms: await computeMemberPermissions(
        existing.server_id,
        user.id,
        existing.channel_id,
      ),
      body: body.body,
    };
    const verdict = await checkAutomod(automodInput);
    if (verdict) {
      void recordAutomodHit(automodInput, verdict)
        .then(applyAutomodEffects)
        .catch((error: unknown) => {
          console.error("[automod] hit effects failed:", error);
        });
      throw new HttpError(
        422,
        verdict.customMessage ?? "This message was blocked by AutoMod",
      );
    }
  }

  const updated = await updateMessageBody(messageId!, body.body);
  if (!updated) {
    throw new NotFound("Message not found");
  }

  const message = mapMessage(updated);
  broadcastToChannel(existing.channel_id, { type: "message-update", message });

  // `updateMessageBody` only ever reads the embed cache, so a link just
  // edited into a body that nobody has posted before comes back with no
  // embed yet — resolve it the same way a fresh message does, in the
  // background, followed by a second `message-update` once it lands. Only a
  // genuine cache miss triggers this: a fresh `failed` row must not be
  // re-fetched on every edit that keeps repeating the same dead link.
  const url = extractFirstUrl(body.body);
  if (url) {
    const state = await getEmbedCacheState(url);
    if (!state.fresh) {
      resolveEmbedInBackground(existing.channel_id, message, url);
    }
  }

  return { message };
});

router.delete("/api/messages/:messageId", async ({ user }, { messageId }) => {
  const existing = await getMessage(messageId!);
  if (!existing) {
    throw new NotFound("Message not found");
  }
  await requireChannelAccess(existing.channel_id, user.id);

  // Authors delete their own; moderators delete anyone's. A conversation has no
  // server and therefore no moderators, so `server_id` being null is not a
  // missing lookup — it is the answer, and the check must stop there rather
  // than fall through to one.
  if (
    existing.author_id !== user.id &&
    !(
      existing.server_id &&
      (await memberHasPermission(
        existing.server_id,
        user.id,
        Permission.MANAGE_MESSAGES,
      ))
    )
  ) {
    throw new Forbidden("You cannot delete this message");
  }

  await deleteMessage(messageId!);
  broadcastToChannel(existing.channel_id, {
    type: "message-delete",
    channelId: existing.channel_id,
    messageId: messageId!,
  });
  // Only a moderator acting on someone else's message is worth a trace — an
  // author deleting their own is not a moderation action, and the body itself
  // is deliberately not recorded: it is already gone, and copying deleted
  // content into a second, longer-retained table is its own privacy question.
  if (existing.author_id !== user.id && existing.server_id) {
    await logAudit({
      serverId: existing.server_id,
      actorId: user.id,
      action: "message.delete",
      targetType: "message",
      targetId: messageId!,
    });
  }
  return { ok: true };
});

/**
 * POST /api/channels/:channelId/messages/bulk-delete
 *
 * The moderation action a 200-person watch party actually needs: clear a raid
 * in one go instead of clicking Delete a hundred times. Two shapes, one route
 * (see `bulkDeleteMessagesSchema`): `{ count }` sweeps the newest N, and
 * `{ messageIds }` deletes a hand-picked set.
 *
 * Server channels only. A conversation has no moderators, so there is nobody
 * this permission could belong to there, and the two-person DM case that a
 * bulk delete would serve ("unsend everything I said") is a different
 * feature with a different rule (it would have to be author-scoped) rather
 * than a missing branch of this one. 404 rather than 400 for the same reason
 * `requireServerChannel` does it: a guessed channel id learns nothing.
 *
 * Unlike the single delete, there is no author fallback. `DELETE /api/messages/
 * :id` lets you remove your own message with no permission at all; this route
 * requires MANAGE_MESSAGES from everyone, including for a set that happens to
 * be all your own. Clearing a hundred rows at once is a moderation action
 * whoever wrote them, and the audit entry it writes should never be able to
 * say "actor: a member with no permissions".
 */
router.post(
  "/api/channels/:channelId/messages/bulk-delete",
  async ({ user, req, res }, { channelId }) => {
    const channel = await requireChannelAccess(channelId!, user.id);
    if (channel.kind !== "server" || !channel.server_id) {
      throw new NotFound("Channel not found");
    }

    // The permission is resolved *for this channel*, not for the server, so a
    // per-channel deny overwrite refuses the purge the same way it refuses a
    // single delete over the socket.
    if (
      !(await memberHasPermission(
        channel.server_id,
        user.id,
        Permission.MANAGE_MESSAGES,
        channelId,
      ))
    ) {
      throw new Forbidden("You cannot delete messages in this channel");
    }

    const key = `user:${user.id}`;
    if (!bulkDeleteLimiter.take(key)) {
      res.setHeader("Retry-After", String(bulkDeleteLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }

    const body = bulkDeleteMessagesSchema.parse(await readJsonBody(req));
    const targets =
      body.count === undefined
        ? body.messageIds
        : await listRecentMessageIds(channelId!, body.count);

    // A `count` sweep of an empty channel, or an id list where every row has
    // already gone. Nothing happened, so nothing is broadcast and nothing is
    // logged. An audit entry reading "cleared 0 messages" is noise in the one
    // place noise is most expensive.
    const deleted = await deleteMessagesBulk(channelId!, targets);
    if (deleted.length === 0) {
      return { deleted: 0, messageIds: [] };
    }

    broadcastToChannel(channelId!, {
      type: "message-bulk-delete",
      channelId: channelId!,
      messageIds: deleted,
    });

    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "message.bulk_delete",
      targetType: "channel",
      targetId: channelId!,
      changes: [{ key: "count", old: null, new: deleted.length }],
    });

    return { deleted: deleted.length, messageIds: deleted };
  },
);

/**
 * A conversation has no moderators, so any participant — already proven by
 * `requireChannelAccess` — may pin or unpin anything in it, the same way any
 * participant there may delete their own message with nobody to escalate to.
 * A server channel gates on the same permission as every other moderation
 * action, matching Discord's own "Manage Messages" requirement rather than
 * letting an author pin their own post unilaterally.
 */
async function requirePinAccess(
  existing: { server_id: string | null },
  userId: string,
): Promise<void> {
  if (
    existing.server_id &&
    !(await memberHasPermission(
      existing.server_id,
      userId,
      Permission.MANAGE_MESSAGES,
    ))
  ) {
    throw new Forbidden("Only owners and admins can pin messages");
  }
}

router.post(
  "/api/messages/:messageId/pin",
  async ({ user }, { messageId }) => {
    const existing = await getMessage(messageId!);
    if (!existing) {
      throw new NotFound("Message not found");
    }
    await requireChannelAccess(existing.channel_id, user.id);
    await requirePinAccess(existing, user.id);

    try {
      const pinned = await pinMessage(messageId!, user.id);
      if (!pinned) {
        throw new NotFound("Message not found");
      }
      const message = mapMessage(pinned);
      broadcastToChannel(existing.channel_id, {
        type: "message-update",
        message,
      });
      return { message };
    } catch (error) {
      if (error instanceof ChannelPinLimitError) {
        throw new HttpError(409, error.message);
      }
      throw error;
    }
  },
);

router.delete(
  "/api/messages/:messageId/pin",
  async ({ user }, { messageId }) => {
    const existing = await getMessage(messageId!);
    if (!existing) {
      throw new NotFound("Message not found");
    }
    await requireChannelAccess(existing.channel_id, user.id);
    await requirePinAccess(existing, user.id);

    const unpinned = await unpinMessage(messageId!);
    if (!unpinned) {
      throw new NotFound("Message not found");
    }
    const message = mapMessage(unpinned);
    broadcastToChannel(existing.channel_id, {
      type: "message-update",
      message,
    });
    return { message };
  },
);

router.get(
  "/api/channels/:channelId/pins",
  async ({ user }, { channelId }) => {
    await requireChannelAccess(channelId!, user.id);
    const messages = await listPinnedMessages(channelId!);
    return { messages: messages.map(mapMessage) };
  },
);

// ---------------------------------------------------------------- threads
//
// One route, because a thread is a channel: its messages, reads, pins,
// reactions, attachments and reports all go through the channel routes above,
// gated by `canAccessChannel`, which answers for a thread with its parent's
// answer. The only thing threads need of their own is being born.

/**
 * Start a thread from a message, or return the one it already has — the
 * server-side of two people tapping "start thread" at once is a single row
 * either way (see the unique index on `thread_root_message_id`).
 *
 * Any member who can read the message may start its thread; that is Discord's
 * own default, and the thread grants nothing the parent channel did not
 * already grant. The HTTP timeout gate covers this route by its
 * `/api/messages/...` shape, so a timed-out member cannot use "start thread"
 * as a way to keep speaking.
 */
/**
 * The active threads of a server, grouped by the channel they hang off — what
 * the channel list nests under each channel row.
 *
 * Its own route rather than a wider `GET .../channels`: that payload is
 * `etagged` because a server's channels barely change, while threads move on
 * every reply. Folding one into the other would either thrash that etag or
 * serve a stale thread list behind a fresh one.
 */
router.get("/api/servers/:serverId/threads", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  // Visibility follows the parent, so asking only about channels this reader
  // can already see is the whole access check — a thread under a private
  // channel never appears in the list its parent is absent from.
  const channels = await listChannels(serverId!, user.id);
  const parents = channels
    .filter((channel) => channel.type === "text")
    .map((channel) => channel.id);
  const byParent = await listActiveThreadsByParent(
    serverId!,
    parents,
    SIDEBAR_THREADS_PER_CHANNEL,
    user.id,
  );
  return {
    threads: Object.fromEntries(byParent),
  };
});

router.post(
  "/api/messages/:messageId/threads",
  async ({ req, user }, { messageId }) => {
    const message = await getMessage(messageId!);
    if (!message) {
      throw new NotFound("Message not found");
    }
    await requireChannelAccess(message.channel_id, user.id);

    const body = createThreadSchema.parse(await readJsonBody(req));
    let result;
    try {
      result = await createThreadForMessage(
        messageId!,
        body.name ?? null,
        user.id,
      );
    } catch (error) {
      if (error instanceof ThreadTargetError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    if (!result) {
      throw new NotFound("Message not found");
    }

    if (result.created) {
      // The chip appears live on everyone's copy of the origin message.
      broadcastToChannel(result.parentChannelId, {
        type: "thread-update",
        channelId: result.parentChannelId,
        messageId: messageId!,
        thread: result.thread,
      });
    }
    return result.created
      ? created({ thread: result.thread })
      : { thread: result.thread };
  },
);

/**
 * Join (PUT) or leave (DELETE) a thread: whether it is listed under its
 * channel in this person's sidebar, and nothing else. Access to the thread and
 * its messages is the parent's answer either way, so leaving hides nothing
 * the chip does not still offer, and joining grants nothing new.
 *
 * 404 for an id that is not a thread, and for a thread whose parent the
 * caller cannot see: `requireChannelAccess` answers for a thread with its
 * parent's answer, so a thread under a private channel fails closed here too.
 */
async function requireThread(threadId: string, userId: string) {
  const channel = await requireChannelAccess(threadId, userId);
  if (channel.type !== "thread") {
    throw new NotFound("Thread not found");
  }
}

router.put("/api/threads/:threadId/membership", async ({ user }, { threadId }) => {
  await requireThread(threadId!, user.id);
  await setThreadMembership(threadId!, user.id, true);
  return { ok: true };
});

router.delete(
  "/api/threads/:threadId/membership",
  async ({ user }, { threadId }) => {
    await requireThread(threadId!, user.id);
    await setThreadMembership(threadId!, user.id, false);
    return { ok: true };
  },
);

// ----------------------------------------------------------------- search

router.get("/api/servers/:serverId/search", async (ctx, { serverId }) => {
  const { url, user, res } = ctx;
  await requireServerMember(serverId!, user.id);

  const key = `user:${user.id}`;
  if (!searchLimiter.take(key)) {
    res.setHeader("Retry-After", String(searchLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const query = messageSearchQuerySchema.safeParse(
    (url.searchParams.get("q") ?? "").trim(),
  );
  if (!query.success) {
    throw new HttpError(400, "Invalid search query");
  }

  const limit = clampLimit(
    url.searchParams.get("limit"),
    SEARCH_PAGE_SIZE,
    SEARCH_PAGE_MAX,
  );

  const rawCursor = url.searchParams.get("before");
  const cursor = rawCursor ? decodeSearchCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    throw new HttpError(400, "Invalid cursor");
  }

  return await searchMessages(
    serverId!,
    user.id,
    query.data,
    limit,
    cursor ?? undefined,
  );
});

// ---------------------------------------------------------------- members

/**
 * Status rides on the member list rather than arriving over the socket.
 *
 * Nothing is pushed: a push has to reach every member of every server the
 * changing user shares, so one idle transition at a thousand concurrent users is
 * a membership query plus a fan-out to hundreds of sockets — almost all of them
 * belonging to clients with no member list on screen. Resolving it here makes
 * the cost proportional to the number of people actually looking, and zero when
 * nobody is. The panel re-reads this while it is open.
 *
 * `resolveStatuses` is pure memory: one pass over this instance's connections
 * plus the contributions the other instances published. It adds no query to a
 * route that already does one, and it is decorated here rather than inside
 * `listServerMembers` so that the other caller of that function — the LGPD data
 * export — does not quietly acquire a live presence field.
 */
router.get("/api/servers/:serverId/members", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  const members = await listServerMembers(serverId!);
  const statuses = resolveStatuses(members.map((member) => member.id));
  // Characters that only POST have no socket, so the registry calls them
  // offline. Paint them online on this roster while the server's outgoing
  // hook is `active` — that is "Grok can still be woken", not a stored
  // presence bit. A live socket still wins (idle / dnd / invisible).
  const hookListening = members.some((member) => member.isCharacter)
    ? await serverHasActiveOutgoingWebhook(serverId!)
    : false;
  return {
    members: members.map((member) => ({
      ...member,
      // `offline` is the floor, and it is what an invisible member resolves to.
      status: statusWithCharacterHook(
        statuses.get(member.id) ?? "offline",
        member.isCharacter,
        hookListening,
      ),
    })),
  };
});

router.get(
  "/api/servers/:serverId/permissions",
  async ({ user }, { serverId }) => {
    await requireServerMember(serverId!, user.id);
    const channels = await listChannels(serverId!, user.id);
    return getPermissionsSnapshot(
      serverId!,
      user.id,
      channels.map((channel) => channel.id),
    );
  },
);

router.get("/api/servers/:serverId/roles", async ({ user }, { serverId }) => {
  await requireServerMember(serverId!, user.id);
  return { roles: (await listRoles(serverId!)).map(mapRole) };
});

router.post("/api/servers/:serverId/roles", async ({ req, user }, { serverId }) => {
  await requirePermission(serverId!, user.id, Permission.MANAGE_ROLES);
  const body = createRoleSchema.parse(await readJsonBody(req));
  const actorPerms = await computeMemberPermissions(serverId!, user.id);
  const requested = body.permissions
    ? parsePermissions(body.permissions)
    : 0n;
  const permissions = clampRolePermissions(actorPerms, requested, 0n);
  const role = await createRole(serverId!, {
    name: body.name,
    color: body.color,
    mentionable: body.mentionable,
    permissions,
  });
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "role.create",
      targetType: "role",
      targetId: role.id,
      changes: [{ key: "name", old: null, new: role.name }],
    });
    pingPermissions(serverId!);
    return created({ role: mapRole(role) });
});

router.patch(
  "/api/servers/:serverId/roles/order",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_ROLES);
    const actor = await getMemberHierarchy(serverId!, user.id);
    if (!actor) {
      throw new NotFound("Server not found");
    }
    const body = reorderRolesSchema.parse(await readJsonBody(req));
    await reorderRoles(serverId!, body.roleIds, actor);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "role.update",
      targetType: "server",
      targetId: serverId!,
      changes: [{ key: "order", old: null, new: body.roleIds }],
    });
    pingPermissions(serverId!);
    return { ok: true };
  },
);

router.patch("/api/roles/:roleId", async ({ req, user }, { roleId }) => {
  const role = await getRole(roleId!);
  if (!role) {
    throw new NotFound("Role not found");
  }
  const { actorPerms } = await assertCanEditRole(user.id, role);
  const body = updateRoleSchema.parse(await readJsonBody(req));
  if (role.is_everyone && body.name) {
    throw new HttpError(400, "The @everyone role cannot be renamed");
  }
  if (role.system_key === "owner" && body.permissions !== undefined) {
    throw new HttpError(400, "The Owner role cannot carry permissions");
  }
  const nextPermissions =
    body.permissions !== undefined
      ? clampRolePermissions(
          actorPerms,
          parsePermissions(body.permissions),
          parsePermissions(role.permissions),
        )
      : undefined;
  const updated = await updateRole(role, {
    name: body.name,
    color: body.color,
    mentionable: body.mentionable,
    hoist: body.hoist,
    showBadge: body.showBadge,
    permissions: nextPermissions,
  });
  await logAudit({
    serverId: role.server_id,
    actorId: user.id,
    action: "role.update",
    targetType: "role",
    targetId: role.id,
    changes: [{ key: "name", old: role.name, new: updated.name }],
  });
  pingPermissions(role.server_id);
  return { role: mapRole(updated) };
});

router.delete("/api/roles/:roleId", async ({ user }, { roleId }) => {
  const role = await getRole(roleId!);
  if (!role) {
    throw new NotFound("Role not found");
  }
  await assertCanEditRole(user.id, role);
  await deleteRole(role);
  await logAudit({
    serverId: role.server_id,
    actorId: user.id,
    action: "role.delete",
    targetType: "role",
    targetId: role.id,
    changes: [{ key: "name", old: role.name, new: null }],
  });
  pingPermissions(role.server_id);
  return { ok: true };
});

router.put(
  "/api/servers/:serverId/members/:userId/roles/:roleId",
  async ({ user }, { serverId, userId, roleId }) => {
    const role = await getRole(roleId!);
    if (!role || role.server_id !== serverId) {
      throw new NotFound("Role not found");
    }
    await assertCanEditRole(user.id, role);
    if (!(await isServerMember(serverId!, userId!))) {
      throw new NotFound("Member not found");
    }
    await requireOutranked(serverId!, user.id, userId!, "kick");
    await assignRole(serverId!, userId!, roleId!);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.roles_update",
      targetType: "user",
      targetId: userId!,
      changes: [{ key: "roleId", old: null, new: roleId }],
    });
    pingPermissions(serverId!);
    return { ok: true };
  },
);

router.delete(
  "/api/servers/:serverId/members/:userId/roles/:roleId",
  async ({ user }, { serverId, userId, roleId }) => {
    const role = await getRole(roleId!);
    if (!role || role.server_id !== serverId) {
      throw new NotFound("Role not found");
    }
    await assertCanEditRole(user.id, role);
    if (!(await isServerMember(serverId!, userId!))) {
      throw new NotFound("Member not found");
    }
    await requireOutranked(serverId!, user.id, userId!, "kick");
    await unassignRole(serverId!, userId!, roleId!);
    const revoked = new Set(
      await listRevokedPrivateChannelIds(serverId!, userId!),
    );
    if (revoked.size > 0) {
      evictUserFromChannels(userId!, revoked);
      evictVoiceUser(userId!, revoked);
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.roles_update",
      targetType: "user",
      targetId: userId!,
      changes: [{ key: "roleId", old: roleId, new: null }],
    });
    pingPermissions(serverId!);
    return { ok: true };
  },
);

/**
 * Every overwrite save cancels any outstanding channel-private re-sweep for
 * the room before recomputing who belongs. `evictVoiceUsersExcept` below
 * schedules a fresh one keyed to the audience this call just read whenever
 * the room still needs one, so cancelling first never leaves a still-private
 * channel unprotected — it only ever removes a sweep this call is about to
 * either replace with a current one or make unnecessary. That matters
 * because `is_private` alone does not tell us access just widened: it stays
 * true across an overwrite PUT/DELETE that restores `@everyone` VIEW or
 * grants a role access, and per `cancelSfuPrivateResweep`'s own contract,
 * callers are expected to call it unconditionally rather than infer in
 * advance whether a resweep is actually live.
 *
 * The cancellation is AWAITED, not fired and forgotten: `cancelSfuPrivateResweep`
 * deletes the `voice_resweeps` row (with a retry, so it can take a moment),
 * and `evictVoiceUsersExcept` below can write a replacement row for the same
 * key when the room still needs one. Racing those two — a delete still in
 * flight when the fresh upsert lands — would let the delete land second and
 * erase the replacement, leaving a still-private room with no cluster
 * resweep at all. Finishing the delete first makes that ordering impossible.
 */
async function evictViewersOutsideAudience(channelId: string): Promise<void> {
  await cancelPrivateVoiceResweep(channelId);
  const audience = await getChannelAudience(channelId);
  if (!audience) {
    return;
  }
  const allowed = [...audience.userIds];
  evictChannelViewers(channelId, { exceptUserIds: allowed });
  evictVoiceUsersExcept(channelId, new Set(allowed));
  for (const threadId of await listThreadChannelIds(channelId)) {
    evictChannelViewers(threadId, { exceptUserIds: allowed });
  }
}

function pingPermissions(serverId: string): void {
  void notifyPermissionsUpdate(serverId).catch((error) => {
    console.error("[api] permissions-update failed:", error);
  });
}

router.get(
  "/api/channels/:channelId/overwrites",
  async ({ user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_ROLES,
    );
    return { overwrites: await listChannelOverwrites(channelId!) };
  },
);

router.put(
  "/api/channels/:channelId/overwrites",
  async ({ req, user }, { channelId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_ROLES,
    );
    const body = channelOverwriteSchema.parse(await readJsonBody(req));
    const actorPerms = await computeMemberPermissions(
      channel.server_id,
      user.id,
    );
    let allow = parsePermissions(body.allow);
    let deny = parsePermissions(body.deny);
    if (
      (actorPerms & Permission.ADMINISTRATOR) !== Permission.ADMINISTRATOR &&
      ((allow & ~actorPerms) !== 0n || (deny & ~actorPerms) !== 0n)
    ) {
      throw new Forbidden("You can only overwrite permissions you have");
    }
    const everyoneId = await getEveryoneRoleId(channel.server_id);
    if (body.targetType === "role" && body.targetId === everyoneId) {
      const coerced = coerceEveryoneViewOverwrite(
        channel.is_private,
        allow,
        deny,
      );
      allow = coerced.allow;
      deny = coerced.deny;
    }
    if (allow === 0n && deny === 0n) {
      await deleteChannelOverwrite(
        channelId!,
        channel.server_id,
        body.targetType,
        body.targetId,
      );
    } else {
      await upsertChannelOverwrite(
        channelId!,
        channel.server_id,
        body.targetType,
        body.targetId,
        allow,
        deny,
      );
    }
    if (channel.is_private && body.targetType === "role" && body.targetId === everyoneId) {
      await restorePrivateEveryoneViewOverwrite(channelId!, channel.server_id);
    }
    await evictViewersOutsideAudience(channelId!);
    pingPermissions(channel.server_id);
    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "channel.overwrite_update",
      targetType: "channel",
      targetId: channelId!,
      changes: [
        { key: "targetId", old: null, new: body.targetId },
        { key: "allow", old: null, new: body.allow },
        { key: "deny", old: null, new: body.deny },
      ],
    });
    return { ok: true };
  },
);

router.delete(
  "/api/channels/:channelId/overwrites/:targetType/:targetId",
  async ({ user }, { channelId, targetType, targetId }) => {
    const channel = await requireServerChannel(channelId!);
    await requirePermission(
      channel.server_id,
      user.id,
      Permission.MANAGE_ROLES,
    );
    if (targetType !== "role" && targetType !== "member") {
      throw new HttpError(400, "Invalid overwrite target");
    }
    await deleteChannelOverwrite(
      channelId!,
      channel.server_id,
      targetType,
      targetId!,
    );
    if (channel.is_private && targetType === "role") {
      const everyoneId = await getEveryoneRoleId(channel.server_id);
      if (targetId === everyoneId) {
        await restorePrivateEveryoneViewOverwrite(channelId!, channel.server_id);
      }
    }
    await evictViewersOutsideAudience(channelId!);
    pingPermissions(channel.server_id);
    await logAudit({
      serverId: channel.server_id,
      actorId: user.id,
      action: "channel.overwrite_delete",
      targetType: "channel",
      targetId: channelId!,
      changes: [
        { key: "targetType", old: targetType, new: null },
        { key: "targetId", old: targetId, new: null },
      ],
    });
    return { ok: true };
  },
);

router.patch(
  "/api/servers/:serverId/members/:userId",
  async ({ req, user }, { serverId, userId }) => {
    const body = updateMemberRoleSchema.parse(await readJsonBody(req));
    if (body.nickname !== undefined) {
      if (userId === user.id) {
        await requirePermission(
          serverId!,
          user.id,
          Permission.CHANGE_NICKNAME,
        );
      } else {
        await requirePermission(
          serverId!,
          user.id,
          Permission.MANAGE_NICKNAMES,
        );
        await requireOutranked(serverId!, user.id, userId!, "kick");
      }
      await setMemberNickname(serverId!, userId!, body.nickname);
      // A nickname is what this person is called in this server, calls
      // included: refresh any room they are sitting in right now.
      const renamed = await getUserById(userId!);
      if (renamed) {
        void refreshVoiceIdentity(userId!, {
          display_name: renamed.display_name,
          avatar_url: renamed.avatar_url,
        });
      }
      await logAudit({
        serverId: serverId!,
        actorId: user.id,
        action: "member.nickname_update",
        targetType: "user",
        targetId: userId!,
        changes: [{ key: "nickname", old: null, new: body.nickname }],
      });
    }
    if (body.role === undefined) {
      return { ok: true };
    }
    await requireOwner(serverId!, user.id);
    const previousRole = await getMemberRole(serverId!, userId!);
    await updateMemberRole(serverId!, userId!, body.role);

    // A DEMOTION IS A REVOCATION, AND A REVOCATION HAS TO EVICT.
    //
    // `channelVisibleSql` admits admins to a private channel on rank alone, so
    // `admin` → `member` takes away every private channel they were not
    // explicitly added to — without touching one membership row. `updateMemberRole`
    // invalidates the audience cache for exactly this reason, but a cache
    // invalidation only fixes what the *next* query answers: the socket already
    // sitting in that channel keeps receiving every message body, and the peer
    // already in its voice room keeps hearing it, until they happen to navigate
    // away. Same two `evict*` helpers the kick and ban paths call, for the same
    // reason and with the same process-local caveat noted on `DELETE /api/me`.
    if (previousRole === "admin" && body.role === "member") {
      const revoked = new Set(
        await listRevokedPrivateChannelIds(serverId!, userId!),
      );
      if (revoked.size > 0) {
        evictUserFromChannels(userId!, revoked);
        evictVoiceUser(userId!, revoked);
      }
    }

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.role_update",
      targetType: "user",
      targetId: userId!,
      changes: [{ key: "role", old: previousRole, new: body.role }],
    });
    pingPermissions(serverId!);
    return { ok: true };
  },
);

// ------------------------------------------------------------- timeouts
//
// The middle of the enforcement ladder. MODERATE_MEMBERS to see and act, and
// `requireOutranked` for who may be acted on — the same rank rule as kick and
// ban, argued there.
//
// The *enforcement* of a timeout is nowhere near these routes: it lives in the
// two chokepoints (`handleApi` above, `handleChatMessage` in ws/chat.ts) plus
// the voice join. These three only issue, lift and list.

router.get(
  "/api/servers/:serverId/timeouts",
  async ({ user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MODERATE_MEMBERS);
    return { timeouts: await listActiveTimeouts(serverId!) };
  },
);

router.post(
  "/api/servers/:serverId/timeouts",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MODERATE_MEMBERS);
    const body = issueTimeoutSchema.parse(await readJsonBody(req));
    if (body.userId === user.id) {
      throw new HttpError(400, "You cannot time yourself out");
    }
    // Unlike a ban, a timeout cannot be pre-emptive: it silences somebody
    // *inside* a server, and there is nothing to silence about a person who is
    // not there. `requireOutranked` returns null for a non-member.
    const targetRole = await requireOutranked(
      serverId!,
      user.id,
      body.userId,
      "timeout",
    );
    if (!targetRole) {
      throw new NotFound("Member not found");
    }

    const timeout = await issueTimeout({
      serverId: serverId!,
      userId: body.userId,
      issuedBy: user.id,
      minutes: body.minutes,
      reason: body.reason ?? null,
    });

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.timeout",
      targetType: "user",
      targetId: body.userId,
      reason: body.reason ?? null,
      changes: [
        // The row is replaced rather than appended to and is deleted when it
        // expires, so this entry is the only durable record of how long the
        // sanction was for. `expiresAt` old→new reads as an extension when the
        // person was already timed out, and as a fresh sanction when not.
        {
          key: "expiresAt",
          old: timeout.previousExpiresAt?.toISOString() ?? null,
          new: timeout.expiresAt.toISOString(),
        },
        { key: "minutes", old: null, new: body.minutes },
      ],
    });

    // A timeout refuses the voice *join*; somebody already in a room joined
    // before it existed and would otherwise keep talking through the whole
    // sanction. Scoped to this server's channels so a conversation call the
    // person is in is untouched — a server's moderators do not get to hang up
    // their members' DMs. Text needs no equivalent: nothing is pushed *from*
    // the sanctioned client, and they keep read access by design.
    const channelIds = await listServerChannelIds(serverId!);
    evictVoiceUser(body.userId, channelIds);

    return created({ timeout, message: timeoutMessage(timeout) });
  },
);

router.delete(
  "/api/servers/:serverId/timeouts/:userId",
  async ({ user }, { serverId, userId }) => {
    await requirePermission(serverId!, user.id, Permission.MODERATE_MEMBERS);
    // No rank check on the way *out*. Lifting a sanction only ever gives
    // something back, and an admin who can see the list should be able to undo
    // a mistake without waiting for the owner.
    if (!(await liftTimeout(serverId!, userId!))) {
      throw new NotFound("No active timeout for that member");
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.timeout_lift",
      targetType: "user",
      targetId: userId!,
    });
    return { ok: true };
  },
);

router.delete(
  "/api/servers/:serverId/members/:userId",
  async ({ req, user }, { serverId, userId }) => {
    await requirePermission(serverId!, user.id, Permission.KICK_MEMBERS);
    const body = removeMemberSchema.parse(await readJsonBody(req));
    if (userId === user.id) {
      throw new HttpError(400, "Use leave to remove yourself");
    }
    const targetRole = await requireOutranked(
      serverId!,
      user.id,
      userId!,
      "kick",
    );
    if (!targetRole) {
      throw new NotFound("Member not found");
    }

    if (body.ban) {
      await requirePermission(serverId!, user.id, Permission.BAN_MEMBERS);
      await banMember(serverId!, userId!, user.id, null);
    } else {
      await kickMember(serverId!, userId!);
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: body.ban ? "member.ban" : "member.kick",
      targetType: "user",
      targetId: userId!,
    });

    const channelIds = await listServerChannelIds(serverId!);
    evictUserFromChannels(userId!, channelIds);
    evictVoiceUser(userId!, channelIds);
    return { ok: true };
  },
);

// ------------------------------------------------------- voice moderation
//
// Voice-specific tools between "do nothing" and the kick/ban/timeout ladder.
// Same permission model as kick throughout: `requireManager` to act,
// `requireOutranked` for who may be acted on — a voice sanction is still a
// sanction. All three are audit-logged, and the target is told over their own
// socket (`notifyVoiceModeration` — the sanction-notice principle) before
// anything is torn down.
//
// Scope: like the roster these act on, targeting is per-instance (see the
// note in ws/voice.ts). The routes 404 when this instance holds no peer for
// the target, which matches exactly the badges the moderator was looking at.

/** The target's current voice channel in this server, or a 404. */
async function requireVoiceTarget(
  serverId: string,
  targetUserId: string,
): Promise<string> {
  const channelIds = await listServerChannelIds(serverId);
  const voiceChannelId = await findVoiceChannelForUser(
    targetUserId,
    channelIds,
  );
  if (!voiceChannelId) {
    throw new NotFound("That member is not in a voice channel in this server");
  }
  return voiceChannelId;
}

/** Shared preamble: rank rules, no self-targeting, target must be a member. */
async function requireVoiceModeration(
  serverId: string,
  actorId: string,
  targetUserId: string,
  action: "disconnect" | "move" | "mute" | "lower hand",
  voiceChannelId: string,
): Promise<void> {
  await requirePermission(
    serverId,
    actorId,
    action === "mute" || action === "lower hand"
      ? Permission.MUTE_MEMBERS
      : Permission.MOVE_MEMBERS,
    voiceChannelId,
  );
  if (targetUserId === actorId) {
    throw new HttpError(400, "Use the leave button on yourself");
  }
  const targetRole = await requireOutranked(
    serverId,
    actorId,
    targetUserId,
    action,
  );
  if (!targetRole) {
    throw new NotFound("Member not found");
  }
}

router.post(
  "/api/servers/:serverId/members/:userId/voice-disconnect",
  async ({ user }, { serverId, userId }) => {
    const voiceChannelId = await requireVoiceTarget(serverId!, userId!);
    await requireVoiceModeration(
      serverId!,
      user.id,
      userId!,
      "disconnect",
      voiceChannelId,
    );

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.voice_disconnect",
      targetType: "user",
      targetId: userId!,
      // The roster is ephemeral; this row is the only durable record of which
      // room they were ejected from.
      changes: [{ key: "channelId", old: voiceChannelId, new: null }],
    });

    disconnectVoiceUser(
      userId!,
      voiceChannelId,
      { message: "A moderator disconnected you from voice." },
      await findVoicePeerIdentities(userId!, voiceChannelId),
    );
    return { ok: true };
  },
);

const voiceMoveSchema = z.object({ channelId: z.string().uuid() });

/**
 * "Move to channel" is eject-and-invite, because a server cannot force-join a
 * client — and must not be able to. The eviction carries a `movedToChannelId`
 * hint, and the target's client follows it by issuing an ordinary
 * `join-voice-room`, which re-runs every admission check server-side.
 *
 * THE CONSENT MODEL: being connected to this server's voice is the consent —
 * a moderator can already end that session outright (disconnect above), so
 * redirecting it within the same server is strictly less power, and the auto-
 * follow reach is capped to voice channels the target can already see: the
 * `canAccessChannel(target)` check below refuses the move up front, and the
 * join the client performs re-checks it (plus timeout, transport, room-full)
 * even against a forged hint. A client that ignores the hint is merely
 * disconnected — never worse off than the blunter tool.
 */
router.post(
  "/api/servers/:serverId/members/:userId/voice-move",
  async ({ req, user }, { serverId, userId }) => {
    const body = voiceMoveSchema.parse(await readJsonBody(req));
    const fromChannelId = await requireVoiceTarget(serverId!, userId!);
    await requireVoiceModeration(
      serverId!,
      user.id,
      userId!,
      "move",
      fromChannelId,
    );

    const destination = await requireServerChannel(body.channelId);
    if (destination.server_id !== serverId) {
      throw new NotFound("Channel not found");
    }
    if (!isVoiceRoomChannelType(destination.type)) {
      throw new HttpError(400, "Members can only be moved to a voice channel");
    }
    // Both directions of visibility: the moderator must be able to see where
    // they are sending someone (404, like every other invisible channel)…
    if (!(await canAccessChannel(body.channelId, user.id))) {
      throw new NotFound("Channel not found");
    }
    // …and the target must already have access — a move must never place
    // somebody in a room they could not have joined themselves.
    if (!(await canAccessChannel(body.channelId, userId!))) {
      throw new Forbidden("They don't have access to that channel");
    }

    if (fromChannelId === body.channelId) {
      throw new HttpError(400, "They are already in that channel");
    }

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.voice_move",
      targetType: "user",
      targetId: userId!,
      changes: [{ key: "channelId", old: fromChannelId, new: body.channelId }],
    });

    disconnectVoiceUser(
      userId!,
      fromChannelId,
      {
        movedToChannelId: body.channelId,
        message: `A moderator moved you to ${destination.name}.`,
      },
      await findVoicePeerIdentities(userId!, fromChannelId),
    );
    return { ok: true };
  },
);

const voiceMuteSchema = z.object({ muted: z.boolean() });

/**
 * Server-side mute — SFU rooms only, and refused honestly everywhere else.
 *
 * In a mesh room the audio flows peer-to-peer and never touches this server,
 * so a "server mute" there could only be a polite request to the target's own
 * client — enforcement theater that any modified client ignores. The timeouts
 * work established the rule: do not fake it. On a LiveKit room the mute is
 * real (the SFU stops forwarding the track), with one honest caveat carried
 * into the UI copy: LiveKit lets the participant unmute themselves afterwards,
 * so this is "cut the hot mic now", not a standing sanction — those remain
 * timeout and disconnect.
 */
router.post(
  "/api/servers/:serverId/members/:userId/voice-mute",
  async ({ req, user }, { serverId, userId }) => {
    const body = voiceMuteSchema.parse(await readJsonBody(req));
    const voiceChannelId = await requireVoiceTarget(serverId!, userId!);
    await requireVoiceModeration(
      serverId!,
      user.id,
      userId!,
      "mute",
      voiceChannelId,
    );

    // Both transports end up with the same roster flag; they differ in what
    // else happens to the media.
    //
    // LiveKit: the SFU is in the audio path, so it stops forwarding the track
    // too. That call runs FIRST and can refuse, because the mute IS the
    // action here, and an SFU that did not accept it must be reported instead
    // of half-happening.
    //
    // Mesh: the audio never touches the server, and for a long time this
    // route refused for that reason. But eviction works on mesh, and it works
    // because every other client enforces the roster. The flag on the roster
    // is enforced the same way: every receiver forces the peer's playback to
    // zero and the target's own client refuses to unmute. See
    // `roomServerMutes` in `ws/voice.ts` for the whole argument.
    if (getRoomTransport(voiceChannelId) === "livekit") {
      const changed = await setSfuUserMuted(
        voiceChannelId,
        userId!,
        body.muted,
        await findVoicePeerIdentities(userId!, voiceChannelId),
      );
      if (!changed) {
        throw new HttpError(
          502,
          "The voice server did not accept the mute. They may not be publishing audio right now.",
        );
      }
    }

    await setVoiceUserServerMuted(voiceChannelId, userId!, body.muted);

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: body.muted ? "member.voice_mute" : "member.voice_unmute",
      targetType: "user",
      targetId: userId!,
      changes: [{ key: "channelId", old: voiceChannelId, new: voiceChannelId }],
    });

    notifyVoiceModeration(userId!, voiceChannelId, {
      action: body.muted ? "muted" : "unmuted",
      message: body.muted
        ? "A moderator muted your microphone for everyone in the call. Only a moderator can unmute you."
        : "A moderator unmuted your microphone. You can turn it back on.",
    });
    return { ok: true };
  },
);

/**
 * Lower somebody else's hand: what happens when they have been called on.
 *
 * WHY IT IS A MODERATION ROUTE AND NOT A WS FRAME. Raising is your own hand
 * and rides the voice socket with the rest of your own state. Lowering
 * somebody else's is an action taken ON a person, so it goes where the other
 * three already live, behind the same helper, and inherits the same three
 * answers: the actor must hold `Permission.MUTE_MEMBERS` in that channel (the
 * bit the voice moderation actions already use, rather than a fifth bit
 * nobody would think to grant), must outrank the target, and must not be
 * aiming at themselves, since a person lowers their own hand from the call.
 *
 * NOT AUDITED, and that is a decision rather than an omission. The audit log
 * is for sanctions somebody may have to answer for weeks later; calling on
 * the next person in a queue is the ordinary running of a room, forty times
 * in one stream, and filing each one would bury the rows that matter. The
 * target sees it happen: their hand comes down on the same roster everyone
 * else reads.
 *
 * Idempotent. Two moderators reaching for the same name is not an error, and
 * neither is a hand that came down on its own a moment earlier.
 */
router.post(
  "/api/servers/:serverId/members/:userId/voice-lower-hand",
  async ({ user }, { serverId, userId }) => {
    const voiceChannelId = await requireVoiceTarget(serverId!, userId!);
    await requireVoiceModeration(
      serverId!,
      user.id,
      userId!,
      "lower hand",
      voiceChannelId,
    );
    await setVoiceUserHandRaised(voiceChannelId, userId!, false);
    return { ok: true };
  },
);

// ----------------------------------------------------- end voice moderation

/**
 * An alert channel must be a text channel of this very server: a rule that
 * posted into another hall's channel would be a cross-server write with the
 * owner's fingerprints nowhere on it.
 */
async function requireAutomodAlertChannel(
  serverId: string,
  channelId: string | null,
): Promise<void> {
  if (!channelId) {
    return;
  }
  const channel = await getChannel(channelId);
  if (
    !channel ||
    channel.kind !== "server" ||
    channel.server_id !== serverId ||
    channel.type !== "text"
  ) {
    throw new HttpError(400, "The alert channel must be a text channel in this server");
  }
}

// AutoMod rules. Reading needs MANAGE_MESSAGES (a moderator may see what the
// filter does), writing needs MANAGE_SERVER (the owner's list, like the
// server's other settings). Matching itself is in @pqp/shared and runs on
// every send in `postChannelMessage`; the client's settings page runs the
// same code for its preview, so there is no test endpoint.
router.get(
  "/api/servers/:serverId/automod/rules",
  async ({ user }, { serverId }) => {
    await requireAnyPermission(serverId!, user.id, [
      Permission.MANAGE_SERVER,
      Permission.MANAGE_MESSAGES,
    ]);
    return { rules: await listAutomodRules(serverId!) };
  },
);

router.post(
  "/api/servers/:serverId/automod/rules",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const body = createAutomodRuleSchema.parse(await readJsonBody(req));
    await requireAutomodAlertChannel(serverId!, body.alertChannelId ?? null);
    const rule = await createAutomodRule(serverId!, {
      kind: body.kind,
      enabled: body.enabled ?? true,
      keywords: body.keywords ?? [],
      allowList: body.allowList ?? [],
      mentionLimit: body.mentionLimit ?? AUTOMOD_MENTION_LIMIT_DEFAULT,
      exemptRoleIds: body.exemptRoleIds ?? [],
      exemptChannelIds: body.exemptChannelIds ?? [],
      customMessage: body.customMessage ?? "",
      alertChannelId: body.alertChannelId ?? null,
      timeoutMinutes: body.timeoutMinutes ?? 0,
      blockPqpInvites: body.blockPqpInvites ?? false,
    });
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "automod.rule_create",
      targetType: "automod_rule",
      targetId: rule.id,
      changes: [{ key: "kind", old: null, new: rule.kind }],
    });
    return created({ rule });
  },
);

router.patch(
  "/api/servers/:serverId/automod/rules/:ruleId",
  async ({ req, user }, { serverId, ruleId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    if (!isUuid(ruleId)) {
      throw new NotFound("Rule not found");
    }
    const body = updateAutomodRuleSchema.parse(await readJsonBody(req));
    if (body.alertChannelId !== undefined) {
      await requireAutomodAlertChannel(serverId!, body.alertChannelId);
    }
    const before = await getAutomodRule(serverId!, ruleId);
    if (!before) {
      throw new NotFound("Rule not found");
    }
    const rule = await updateAutomodRule(serverId!, ruleId, body);
    if (!rule) {
      throw new NotFound("Rule not found");
    }
    const changes = (
      [
        ["enabled", before.enabled, rule.enabled],
        ["keywords", before.keywords.length, rule.keywords.length],
        ["allowList", before.allowList.length, rule.allowList.length],
        ["mentionLimit", before.mentionLimit, rule.mentionLimit],
        ["alertChannelId", before.alertChannelId, rule.alertChannelId],
        ["timeoutMinutes", before.timeoutMinutes, rule.timeoutMinutes],
        ["blockPqpInvites", before.blockPqpInvites, rule.blockPqpInvites],
      ] as const
    )
      .filter(([, oldValue, newValue]) => oldValue !== newValue)
      .map(([key, oldValue, newValue]) => ({ key, old: oldValue, new: newValue }));
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "automod.rule_update",
      targetType: "automod_rule",
      targetId: rule.id,
      changes: [{ key: "kind", old: null, new: rule.kind }, ...changes],
    });
    return { rule };
  },
);

router.delete(
  "/api/servers/:serverId/automod/rules/:ruleId",
  async ({ user }, { serverId, ruleId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    if (!isUuid(ruleId)) {
      throw new NotFound("Rule not found");
    }
    const before = await getAutomodRule(serverId!, ruleId);
    if (!before || !(await deleteAutomodRule(serverId!, ruleId))) {
      throw new NotFound("Rule not found");
    }
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "automod.rule_delete",
      targetType: "automod_rule",
      targetId: ruleId,
      changes: [{ key: "kind", old: before.kind, new: null }],
    });
    return { ok: true };
  },
);

router.get("/api/servers/:serverId/bans", async ({ user }, { serverId }) => {
  await requirePermission(serverId!, user.id, Permission.BAN_MEMBERS);
  return { bans: await listBans(serverId!) };
});

router.post(
  "/api/servers/:serverId/bans",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.BAN_MEMBERS);
    const body = banMemberSchema.parse(await readJsonBody(req));
    if (body.userId === user.id) {
      throw new HttpError(400, "You cannot ban yourself");
    }
    // server_bans carries an FK to users, so the account has to exist — but it
    // need not be a member: a pre-emptive ban is a valid thing to want.
    if (!(await getUserById(body.userId))) {
      throw new NotFound("User not found");
    }
    await requireOutranked(serverId!, user.id, body.userId, "ban");

    await banMember(serverId!, body.userId, user.id, body.reason);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.ban",
      targetType: "user",
      targetId: body.userId,
      reason: body.reason,
    });

    const channelIds = await listServerChannelIds(serverId!);
    evictUserFromChannels(body.userId, channelIds);
    evictVoiceUser(body.userId, channelIds);
    return { ok: true };
  },
);

router.delete(
  "/api/servers/:serverId/bans/:userId",
  async ({ user }, { serverId, userId }) => {
    await requirePermission(serverId!, user.id, Permission.BAN_MEMBERS);
    await unbanMember(serverId!, userId!);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "member.unban",
      targetType: "user",
      targetId: userId!,
    });
    return { ok: true };
  },
);

/**
 * Gated on `requireManager` like every other moderation read here — a plain
 * member does not get to see who kicked whom, only that they can no longer
 * see the person. `before`/`limit` follow the same cursor contract
 * `listMessages` uses, so the client's existing infinite-scroll pattern
 * covers this screen too.
 */
router.get(
  "/api/servers/:serverId/audit-log",
  async ({ url, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    const before = url.searchParams.get("before") ?? undefined;
    const limit = clampLimit(
      url.searchParams.get("limit"),
      AUDIT_LOG_PAGE_SIZE,
      AUDIT_LOG_PAGE_MAX,
    );
    const rawAction = url.searchParams.get("action");
    const action = rawAction
      ? (auditActionSchema.safeParse(rawAction).data ?? undefined)
      : undefined;
    const actorId = url.searchParams.get("actorId") ?? undefined;
    return listAuditLog(serverId!, { before, limit, action, actorId });
  },
);

/** Strips everything but the characters a filename and a quoted
 * `Content-Disposition` value both tolerate — the server name is fully
 * user-controlled, and the alternative is trusting it inside a header. */
function sanitizeFilenameSegment(value: string, fallback = "server"): string {
  return value.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || fallback;
}

/**
 * Owner-only, like delete — a full export is as sensitive as destroying the
 * server: every private channel, every member, every message body. Logged
 * to the audit trail specifically because it is a read that matters (see
 * the comment on `server.data_export`), not despite being one.
 */
router.get(
  "/api/servers/:serverId/export",
  async ({ user, res }, { serverId }) => {
    await requireOwner(serverId!, user.id);

    const key = `user:${user.id}`;
    if (!exportLimiter.take(key)) {
      res.setHeader("Retry-After", String(exportLimiter.retryAfter(key)));
      throw new HttpError(429, "Slow down");
    }

    const data = await buildServerExport(serverId!);
    if (!data) {
      throw new NotFound("Server not found");
    }

    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "server.data_export",
      targetType: "server",
      targetId: serverId!,
    });

    const filename = `${sanitizeFilenameSegment(data.server.name)}-export-${data.exportedAt.slice(0, 10)}.json`;
    return new RawResponse(
      JSON.stringify(data, null, 2),
      "application/json",
      filename,
    );
  },
);

// ---------------------------------------------------------------- reports

/**
 * Report ids are BIGSERIAL, not uuids, so they cannot use the router's `:xxxId`
 * convention — that helper rejects anything that is not a uuid. The parameter
 * is therefore named `:report` and validated here instead, because an
 * unvalidated value reaching `$1::bigint` is a 500 rather than a 404.
 */
function reportIdParam(value: string | undefined): string {
  if (!value || !/^[0-9]{1,19}$/.test(value)) {
    throw new NotFound("Report not found");
  }
  return value;
}

function reportListOptions(url: URL) {
  const rawStatus = url.searchParams.get("status");
  return {
    before: url.searchParams.get("before") ?? undefined,
    limit: clampLimit(
      url.searchParams.get("limit"),
      REPORT_PAGE_SIZE,
      REPORT_PAGE_MAX,
    ),
    // An unrecognised status filters nothing rather than 400s: the queue is a
    // read, and a client sending a value this build does not know should still
    // see the reports.
    status: rawStatus
      ? (reportStatusSchema.safeParse(rawStatus).data ?? undefined)
      : undefined,
  };
}

/**
 * File a report.
 *
 * The body names *what* is being reported and never where it goes — see the
 * header of services/reports.ts. Everything this route can refuse is a 404 by
 * design: "you cannot see that" and "there is no such thing" must be the same
 * answer, or the endpoint becomes a way to test message ids for existence.
 */
router.post("/api/reports", async ({ req, res, user }) => {
  const key = `user:${user.id}`;
  if (!reportLimiter.take(key)) {
    res.setHeader("Retry-After", String(reportLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }

  const body = createReportSchema.parse(await readJsonBody(req));
  // A community report is only a thing where communities are a thing. Refused
  // with the same 404 every other unreachable subject gets, rather than being
  // silently coerced into some other kind of report.
  if (body.subjectType === "server" && !isCommunitiesEnabled()) {
    throw new NotFound("Not found");
  }
  try {
    const result = await createReport(
      body.subjectType === "message"
        ? {
            subjectType: "message",
            reporterId: user.id,
            messageId: body.messageId,
            reason: body.reason,
            details: body.details,
          }
        : body.subjectType === "server"
          ? {
              subjectType: "server",
              reporterId: user.id,
              serverId: body.serverId,
              reason: body.reason,
              details: body.details,
            }
          : {
              subjectType: "user",
              reporterId: user.id,
              userId: body.userId,
              serverId: body.serverId ?? null,
              reason: body.reason,
              details: body.details,
            },
    );
    // Re-reporting something already in the queue is not an error and not a new
    // report, so it answers 200 while the first one answers 201 — the same
    // contract POST /api/blocks uses.
    return result.duplicate
      ? { report: result.report }
      : created({ report: result.report });
  } catch (error) {
    if (error instanceof ReportTargetNotVisibleError) {
      throw new NotFound("Not found");
    }
    if (error instanceof ReportFloodError) {
      throw new HttpError(429, "You have filed too many reports recently");
    }
    throw error;
  }
});

/** The reporter's own reports, in the narrow shape they may see. */
router.get("/api/reports/mine", async ({ url, user }) =>
  listReportsByReporter(user.id, reportListOptions(url)),
);

/**
 * The instance queue — every report with no server behind it, which is exactly
 * the set of reports about conversations. Gated on `isInstanceModerator`, which
 * is operator configuration and not any role held inside the app. A server
 * owner has no more access here than anybody else, which is the point.
 */
router.get("/api/reports/instance", async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    // 404, not 403: whether this deployment has an instance queue at all is not
    // a fact a member needs confirmed.
    throw new NotFound("Not found");
  }
  return listInstanceReports(reportListOptions(url));
});

/**
 * Every report on the instance — the read that closed the gap the operator
 * dashboard's "abertas" count exposed: a two-member server's own automated
 * gore flag, visible only to that server's owner and admins, with no screen
 * an instance moderator could open to see or resolve it. Gated exactly like
 * `/api/reports/instance` — `isInstanceModerator` and nothing an in-app role
 * can grant — and 404 for anyone else for the same reason: whether this
 * deployment has an instance moderator at all is not a fact to confirm.
 */
router.get("/api/reports/all", async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  return listAllReports(reportListOptions(url));
});

/**
 * One server's queue. `requireManager`, like every other moderation read — and
 * it can only ever return reports about that server's own channels, because a
 * report about a conversation has no server id to match (see the `reports`
 * table CHECK constraint).
 */
router.get(
  "/api/servers/:serverId/reports",
  async ({ url, user }, { serverId }) => {
    await requireAnyPermission(serverId!, user.id, [
      Permission.KICK_MEMBERS,
      Permission.BAN_MEMBERS,
      Permission.MODERATE_MEMBERS,
    ]);
    return listServerReports(serverId!, reportListOptions(url));
  },
);

/**
 * Close a report, actioned or dismissed.
 *
 * Who may act follows the report's own scope, plus one override: a server id
 * means a manager of that server OR an instance moderator (this is the gap
 * `docs/CONTENT_SAFETY.md` §"Operator review of server queues" closes — a
 * two-member server's automated flag had no screen an instance moderator
 * could reach), no server id means an instance moderator. The scope is read
 * before anything is returned, so an unauthorized caller learns nothing
 * about the report — not even that the id exists.
 *
 * `canSanctionOnServer` is a NARROWER question than "may resolve", checked
 * separately below: an instance moderator may close any report, but timing a
 * member out is still a server-rank action, so an instance moderator with no
 * standing in that particular server may resolve it and nothing more.
 */
router.patch("/api/reports/:report", async ({ req, user }, { report }) => {
  const reportId = reportIdParam(report);
  const scope = await getReportScope(reportId);
  if (!scope) {
    throw new NotFound("Report not found");
  }
  let canSanctionOnServer = false;
  if (scope.serverId) {
    if (isInstanceModerator(user)) {
      // Resolving is allowed regardless; only note it down if they also
      // happen to hold a real management role on this server, which is what
      // the timeout branch below asks for.
      try {
        await requireAnyPermission(scope.serverId, user.id, [
          Permission.KICK_MEMBERS,
          Permission.BAN_MEMBERS,
          Permission.MODERATE_MEMBERS,
        ]);
        canSanctionOnServer = true;
      } catch {
        // Not a manager of this particular server — still fine to resolve.
      }
    } else {
      await requireAnyPermission(scope.serverId, user.id, [
        Permission.KICK_MEMBERS,
        Permission.BAN_MEMBERS,
        Permission.MODERATE_MEMBERS,
      ]);
      canSanctionOnServer = true;
    }
  } else if (!isInstanceModerator(user)) {
    throw new NotFound("Report not found");
  }

  const body = resolveReportSchema.parse(await readJsonBody(req));

  // ------------------------------------------- resolve and sanction as one
  //
  // Everything that can refuse the sanction is checked BEFORE the report is
  // closed. The failure this ordering exists to prevent is the one that costs
  // the moderator most: closing the queue entry, failing the rank check, and
  // leaving a closed report with nobody sanctioned and no obvious way to tell
  // that is what happened. Either both happen or neither does.
  let timeoutTarget: string | null = null;
  if (body.timeoutMinutes != null) {
    if (!scope.serverId) {
      // An instance-queue report is about a conversation, which has no server
      // and therefore no place to be timed out *in*. Silencing somebody's DMs
      // is not a sanction this product has, and inventing one here would hand
      // it to whoever reads that queue. 400 rather than a quiet skip.
      throw new HttpError(
        400,
        "A report with no server behind it cannot carry a timeout",
      );
    }
    if (!canSanctionOnServer) {
      // An instance moderator resolving a server's report with no management
      // standing there at all may still close it (above); a timeout is a
      // server-rank sanction and stays refused, distinctly from the "no
      // server at all" case above.
      throw new Forbidden("You do not have permission to do that");
    }
    await requirePermission(
      scope.serverId,
      user.id,
      Permission.MODERATE_MEMBERS,
    );
    if (body.status !== "actioned") {
      throw new HttpError(400, "Only an actioned report can carry a timeout");
    }
    const report = await getReport(reportId);
    if (!report?.reportedUserId) {
      // `reported_user_id` is `ON DELETE SET NULL`: the account has gone since
      // the report was filed, and there is nobody left to sanction.
      throw new HttpError(400, "The reported account no longer exists");
    }
    if (report.reportedUserId === user.id) {
      throw new HttpError(400, "You cannot time yourself out");
    }
    // Same rank rule as the standalone route — resolving a report is not a way
    // around "an admin cannot sanction an admin".
    if (
      !(await requireOutranked(
        scope.serverId,
        user.id,
        report.reportedUserId,
        "timeout",
      ))
    ) {
      throw new NotFound("The reported account is not a member of this server");
    }
    timeoutTarget = report.reportedUserId;
  }

  const resolved = await resolveReport(
    reportId,
    user.id,
    body.status,
    body.note,
  );
  if (!resolved) {
    // Someone else closed it between the scope read and the update.
    throw new HttpError(409, "This report has already been resolved");
  }

  if (timeoutTarget && scope.serverId && body.timeoutMinutes != null) {
    const timeout = await issueTimeout({
      serverId: scope.serverId,
      userId: timeoutTarget,
      issuedBy: user.id,
      minutes: body.timeoutMinutes,
      // The note the moderator already typed is the justification. Asking for
      // it a second time is how the reason field ends up empty.
      reason: body.note ?? null,
    });
    await logAudit({
      serverId: scope.serverId,
      actorId: user.id,
      action: "member.timeout",
      targetType: "user",
      targetId: timeoutTarget,
      reason: body.note ?? null,
      changes: [
        {
          key: "expiresAt",
          old: timeout.previousExpiresAt?.toISOString() ?? null,
          new: timeout.expiresAt.toISOString(),
        },
        { key: "minutes", old: null, new: body.timeoutMinutes },
        // Which report produced this sanction. `audit_log.target_id` is a uuid
        // and a report id is a bigint, so it travels here — the same dodge the
        // `report.resolve` entry below makes, for the same reason.
        { key: "report", old: null, new: reportId },
      ],
    });
    const channelIds = await listServerChannelIds(scope.serverId);
    evictVoiceUser(timeoutTarget, channelIds);
  }

  // Server-scoped resolutions join the same trail as every other moderator
  // action. A conversation report has no server to file under and is recorded
  // on the report row alone — see the `report.resolve` comment in shared/audit.
  if (scope.serverId) {
    await logAudit({
      serverId: scope.serverId,
      actorId: user.id,
      action: "report.resolve",
      targetType: "report",
      // `audit_log.target_id` is a uuid column and a report id is a bigint, so
      // the id travels in `changes` rather than being coerced into a shape it
      // does not fit.
      targetId: null,
      reason: body.note ?? null,
      changes: [
        { key: "report", old: null, new: reportId },
        { key: "status", old: "open", new: body.status },
      ],
    });
  }

  return { report: resolved };
});

/**
 * Remove a flagged attachment's message — the operator action a moderator
 * reading `GET /api/reports/all` has no other button for: closing the report
 * says the queue entry was handled, it does not take the content down.
 *
 * A sibling route rather than a field on the PATCH above, on purpose: the two
 * are independent actions with independent failure modes (a report can be
 * resolved with nothing to remove — the message may already be gone, or the
 * report may be a `user`/`server` subject with no message at all), and
 * folding "also delete this" into the resolve body would make one request
 * responsible for two very different kinds of refusal.
 *
 * Same authorization as the PATCH immediately above: a manager of the
 * report's server, or — the gap this feature closes — an instance moderator
 * regardless of their standing in that particular server.
 */
router.post(
  "/api/reports/:report/remove-message",
  async ({ user }, { report }) => {
    const reportId = reportIdParam(report);
    const scope = await getReportScope(reportId);
    if (!scope) {
      throw new NotFound("Report not found");
    }
    if (scope.serverId) {
      if (!isInstanceModerator(user)) {
        await requireAnyPermission(scope.serverId, user.id, [
          Permission.KICK_MEMBERS,
          Permission.BAN_MEMBERS,
          Permission.MODERATE_MEMBERS,
        ]);
      }
    } else if (!isInstanceModerator(user)) {
      throw new NotFound("Report not found");
    }

    const full = await getReport(reportId);
    if (!full || full.subjectType !== "message" || !full.messageId) {
      // A `user` or `server` report names an account or a community, never a
      // message — and a message report whose message is already gone (the
      // ordinary delete path, or a previous call to this same route) reads
      // `messageId: null` per the `messageDeleted` contract on the schema.
      // Both are "nothing left to remove", not a server error.
      throw new HttpError(
        400,
        "This report has no live message left to remove",
      );
    }

    const existing = await getMessage(full.messageId);
    if (!existing) {
      // The row raced ahead of the report's own snapshot — deleted by its
      // author, or by this same action from another tab, between the read
      // above and this one.
      throw new HttpError(400, "The reported message is already gone");
    }

    await deleteMessage(full.messageId);
    broadcastToChannel(existing.channel_id, {
      type: "message-delete",
      channelId: existing.channel_id,
      messageId: full.messageId,
    });

    // Deliberately unconditional and deliberately not only the DB row below:
    // a conversation message has no server and therefore no `audit_log` row
    // to carry it (that table's `server_id` is NOT NULL), so this line is the
    // only trail that case gets. Shouty on purpose, same register as the
    // `[content-safety]` lines this queue's automated reports come from.
    console.log(
      `[moderation] operator removed message — report ${reportId}, ` +
        `message ${full.messageId}, moderator ${user.id}`,
    );

    if (existing.server_id) {
      // Best-effort, deliberately, and AFTER the deletion has already
      // committed and been broadcast: the message is gone either way, so an
      // audit-log hiccup (a pooled connection blip, say) must not turn an
      // already-completed removal into an error response — the client would
      // show "failed", a retry would hit the "already gone" 400 above, and
      // the operator would be left unsure whether the message was actually
      // removed. Same shape as `escalateScanResult`'s `createAutomatedReport`
      // call in `services/attachments.ts`.
      try {
        await logAudit({
          serverId: existing.server_id,
          actorId: user.id,
          action: "message.delete",
          targetType: "message",
          targetId: full.messageId,
          changes: [{ key: "report", old: null, new: reportId }],
        });
      } catch (error) {
        console.error(
          `[moderation] audit write failed after removing message ` +
            `${full.messageId} (report ${reportId}):`,
          error,
        );
      }
    }

    return { ok: true };
  },
);

// ----------------------------------------------------------- call ratings

/**
 * How the last call went, one number, asked once when it ends.
 *
 * Write-only for everybody: there is no route to read an individual rating,
 * and the operator sees only the aggregate that rides along on
 * `GET /api/admin/metrics`. That is the whole privacy design, so resist adding
 * a `GET /api/voice/ratings/:id` later.
 */
router.post("/api/voice/ratings", async ({ req, res, user }) => {
  const key = `user:${user.id}`;
  if (!callRatingLimiter.take(key)) {
    res.setHeader("Retry-After", String(callRatingLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  const body = createCallRatingSchema.parse(await readJsonBody(req));
  await recordCallRating(user.id, body);
  // Nothing meaningful to hand back. The client has already dismissed the
  // prompt by the time this resolves, and returning the row would only invite
  // somebody to build a reader for it later.
  return { ok: true };
});

// --------------------------------------------------------------- feedback

/**
 * Same escape hatch as `reportIdParam`, for the same reason: feedback ids are
 * BIGSERIAL, so the `:xxxId`-must-be-uuid convention cannot carry them.
 */
function feedbackIdParam(value: string | undefined): string {
  if (!value || !/^[0-9]{1,19}$/.test(value)) {
    throw new NotFound("Feedback not found");
  }
  return value;
}

/**
 * BROADCAST_PIPELINE B0.5: sampled, batched, droppable client playback
 * telemetry for a live watch party. Authenticated (the normal Bearer flow,
 * CLAUDE.md pitfall #8) and rate-limited, but deliberately NOT gated on
 * channel access via a database round trip: this is an aggregate operational
 * metric, not a read of anything sensitive, and a query here is a cost this
 * doc's whole premise is to avoid.
 *
 * SESSION IDENTITY IS BOUND TO THE VIEWER TOKEN, NOT TRUSTED AS FREE TEXT (a
 * Farol finding, 2026-09-13: "authenticated users can submit telemetry for
 * arbitrary sessions", permitting cross-session log/metric poisoning).
 * `batch.sessionToken` is the SAME `?t=` capability the client's playlist
 * request carried (`hls-viewer-token.ts`), which already names a user, a
 * channel and a `startedAt` and is signed by this server -- so verifying it
 * here costs one HMAC, not a query, and the channel/session it reports is
 * the one the token's own signature vouches for rather than whatever the
 * client typed. A token that does not verify, or that names a user other
 * than the one this request authenticated as, is rejected outright: a wrong
 * token is a stronger signal of a caller lying about its session than
 * omitting one. The verified `channelId`/`startedAt` is then resolved to the
 * ACTUAL `hls_sessions.id` (`resolveHlsSessionId`, sharing the playlist
 * proxy's own cache) so the id this route records is the identical string
 * the master playlist's `#EXT-X-PQP-SESSION` tag carries and `voice.hlsStarted`
 * logs -- a p95 per session can join against the egress log by equality (a
 * second Farol finding, 2026-09-14: the earlier `channelId:startedAt` pair
 * read the same to a human but was never the same string).
 *
 * NO SESSION LABEL AT ALL WITHOUT A TOKEN (a third Farol finding,
 * 2026-09-14). `LIVE_HLS_SIGNED_URLS=false` mints no viewer token
 * (`stampViewerStream`) and that configuration is fully supported, but a
 * batch with no token to verify gets no session identity either: `sessionId`
 * is recorded as the literal string `"unsigned"`, and the per-session rate
 * limit below is skipped entirely (the per-USER limit above already bounds
 * this caller). Anything else -- accepting the client's own `sessionId` as a
 * label, or as a rate-limit key -- reopens the exact unbounded,
 * attacker-controlled key space the `rung` whitelist (3dde4d4a) closed on
 * the histogram side of this same route.
 *
 * A REJECTED BATCH IS A NO-OP THE CLIENT NEVER RETRIES (see
 * `client/src/lib/hls-playback.ts`'s telemetry queue): this is a measurement,
 * not an event anything downstream is waiting on, so there is no retry
 * machinery here to abuse and no reason to build one.
 */
router.post("/api/live-hls/telemetry", async ({ req, res, user }) => {
  const key = `user:${user.id}`;
  if (!liveHlsTelemetryLimiter.take(key)) {
    recordHlsTelemetryBatchRejectedRateLimit();
    res.setHeader("Retry-After", String(liveHlsTelemetryLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  let batch: ReturnType<typeof liveHlsTelemetryBatchSchema.parse>;
  try {
    batch = liveHlsTelemetryBatchSchema.parse(await readJsonBody(req));
  } catch (error) {
    recordHlsTelemetryBatchRejectedSchema();
    throw error;
  }
  // `sessionVerified` says whether `sessionId` below is this server's own
  // resolved, signature-backed identity (trustworthy for the log line, and
  // the key the per-session rate limit uses) or the fixed `"unsigned"`
  // bucket a tokenless batch gets instead of a caller-chosen label.
  let sessionId = "unsigned";
  let sessionVerified = false;
  if (batch.sessionToken !== undefined) {
    const claims = decodeHlsViewerToken(batch.sessionToken);
    if (!claims || claims.userId !== user.id) {
      recordHlsTelemetryBatchRejectedSession();
      throw new HttpError(400, "Invalid session token");
    }
    // The verified pair, needing no query of its own: the cheap check below
    // gates the database work, not the other way around (a Farol finding,
    // 2026-09-14). It also outlives `resolveHlsSessionId`'s own answer, so
    // it is what the per-session rate limit is keyed on throughout, not the
    // resolved row id -- both name the same session, but this one is
    // available before any lookup runs.
    const compositeKey = `${claims.channelId}:${claims.startedAt}`;
    sessionVerified = true;
    sessionId = compositeKey;

    const sessionKey = `session:${compositeKey}`;
    if (!liveHlsTelemetrySessionLimiter.take(sessionKey)) {
      recordHlsTelemetryBatchRejectedRateLimit();
      res.setHeader(
        "Retry-After",
        String(liveHlsTelemetrySessionLimiter.retryAfter(sessionKey)),
      );
      throw new HttpError(429, "Slow down");
    }

    // `hlsSessionLookupGuard` bounds the query to
    // `HLS_SESSION_LOOKUP_TIMEOUT_MS` and negatively caches a struggling key
    // for `HLS_SESSION_LOOKUP_NEGATIVE_CACHE_MS` -- see its own doc comment
    // for the two Farol findings this closes. A resolution miss that is NOT
    // a timeout (the session just ended, or its rung rows have not landed
    // yet) still deserves a batch that JOINS on repetition, even if it
    // cannot join against the egress log for this one -- so that case falls
    // back to `compositeKey` rather than the shared `"unsigned"` bucket,
    // which would wrongly lump a real, verified session in with every
    // tokenless one.
    const lookup = await hlsSessionLookupGuard.resolve(compositeKey, () =>
      resolveHlsSessionId(claims.channelId, claims.startedAt),
    );
    if (lookup.outcome === "timeout") {
      recordHlsTelemetryBatchRejectedSessionLookupTimeout();
      throw new HttpError(503, "Session lookup timed out");
    }
    if (lookup.outcome === "resolved") {
      sessionId = lookup.sessionId ?? compositeKey;
    }
    // "negatively-cached": no lookup was attempted; `sessionId` stays the
    // composite fallback already assigned above.
  }
  // `recordHlsLatencySample` refuses a rung it does not recognise on its
  // own (a caller-independent guard against an authenticated account
  // growing the per-rung histogram map without bound -- a Farol finding,
  // 2026-09-13), but the log line below is built here too, so it filters
  // the same way first: otherwise a batch full of garbage rung names would
  // still produce a clean-looking log line while every sample inside it was
  // silently dropped from the histogram.
  // Every sample goes through `recordHlsLatencySample`, unfiltered: it is
  // the one place that counts `samplesRejectedUnknownRung`, and pre-filtering
  // here (a Farol finding, 2026-09-13) fed it only the samples it would have
  // accepted anyway, so a batch full of garbage rungs recorded nothing AND
  // never incremented the counter meant to say so.
  for (const sample of batch.samples) {
    recordHlsLatencySample(sample.rung, sample.latencyMs);
  }
  // `knownSamples` is for the log line below ONLY -- it must not name a rung
  // this build refused, but it plays no part in what got recorded above.
  const knownSamples = batch.samples.filter((sample) =>
    isKnownHlsRung(sample.rung),
  );
  recordHlsTelemetryBatchAccepted();
  // One structured line per batch (not per sample): a live party's worth of
  // these is meant to be readable by a human during an event, not a second
  // copy of the histogram in the log shipper. `medianLatencyMs` is a numeric
  // field so Loki's `quantile_over_time` can chart a live trend
  // (`docs/MONITORING.md` B0.6); it is the median of THIS batch's own
  // samples, not the rung's real p50 across every viewer -- that number,
  // correctly bucketed per rung, is `GET /api/admin/metrics`'s
  // `liveHls.latency.byRung`, which this line is a rough live preview of and
  // not a replacement for.
  const sortedLatencies = knownSamples
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b);
  // The schema also accepts `bufferSeconds`/`stalls`/`rebufferMs`/
  // `startupMs`/`playerRebuildCount`, and until this line they were parsed,
  // validated and then thrown away entirely (a Farol finding, 2026-09-13):
  // the request returned 200 while none of that reached anywhere a human or
  // a panel could read it. There is no per-field histogram for these -- that
  // is more than a live party's log line needs -- so they are folded into
  // one summary per batch instead, which is enough to say "the audience is
  // stalling" or "rebuilding the player a lot" during an event.
  const totalStalls = batch.samples.reduce(
    (sum, sample) => sum + (sample.stalls ?? 0),
    0,
  );
  const maxRebufferMs = batch.samples.reduce(
    (max, sample) => Math.max(max, sample.rebufferMs ?? 0),
    0,
  );
  const maxPlayerRebuildCount = batch.samples.reduce(
    (max, sample) => Math.max(max, sample.playerRebuildCount ?? 0),
    0,
  );
  const startupMs = batch.samples.find((sample) => sample.startupMs !== undefined)
    ?.startupMs;
  const bufferSecondsValues = batch.samples
    .map((sample) => sample.bufferSeconds)
    .filter((value): value is number => value !== undefined);
  const avgBufferSeconds =
    bufferSecondsValues.length > 0
      ? bufferSecondsValues.reduce((sum, value) => sum + value, 0) /
        bufferSecondsValues.length
      : undefined;
  logEvent("voice.hlsTelemetryBatch", {
    sessionId,
    sessionVerified,
    samples: batch.samples.length,
    droppedUnknownRungSamples: batch.samples.length - knownSamples.length,
    rungs: [...new Set(knownSamples.map((sample) => sample.rung))],
    medianLatencyMs:
      sortedLatencies.length > 0
        ? sortedLatencies[Math.floor(sortedLatencies.length / 2)]
        : undefined,
    totalStalls,
    maxRebufferMs,
    maxPlayerRebuildCount,
    startupMs,
    avgBufferSeconds:
      avgBufferSeconds !== undefined ? Math.round(avgBufferSeconds * 10) / 10 : undefined,
  });
  return { ok: true };
});

/**
 * Screen-share / watch-party video quality telemetry: fps, bitrate,
 * resolution and (presenter side only) WebRTC's own
 * `qualityLimitationReason`, folded straight into the bounded histograms
 * `GET /api/admin/metrics`'s `streamQuality` block reads
 * (`voice/stream-quality-metrics.ts`). See that module's own doc comment for
 * why this schema carries no free-text field and therefore has only one
 * rejection shape (schema), unlike the HLS latency route above it.
 *
 * NO PII, NO SESSION IDENTITY. Every field is a closed enum or a bounded
 * number; nothing here names a channel, a room or a session. The Bearer
 * token this route requires (like every other `/api/*` route, see
 * `handleApi`) exists only to key the per-caller rate limit below — the
 * sample itself is written into an aggregate bucket the server could not
 * trace back to who sent it even if it wanted to.
 *
 * A REJECTED BATCH IS A NO-OP THE CLIENT NEVER RETRIES, the same convention
 * `POST /api/live-hls/telemetry` documents above: this is a measurement, not
 * an event anything downstream is waiting on.
 */
router.post("/api/stream-quality/telemetry", async ({ req, res, user }) => {
  const key = `user:${user.id}`;
  if (!streamQualityTelemetryLimiter.take(key)) {
    recordStreamQualityBatchRejectedRateLimit();
    res.setHeader(
      "Retry-After",
      String(streamQualityTelemetryLimiter.retryAfter(key)),
    );
    throw new HttpError(429, "Slow down");
  }
  let batch: ReturnType<typeof streamQualityTelemetryBatchSchema.parse>;
  try {
    batch = streamQualityTelemetryBatchSchema.parse(await readJsonBody(req));
  } catch (error) {
    recordStreamQualityBatchRejectedSchema();
    throw error;
  }
  for (const sample of batch.samples) {
    recordStreamQualitySample(sample);
  }
  recordStreamQualityBatchAccepted();
  return { ok: true };
});

/**
 * The settings box. Rate-limited like reports — it is the same "small text
 * box that writes a row anybody can fill" shape — but routed to the operator
 * rather than to any moderation queue; see services/feedback.ts.
 */
router.post("/api/feedback", async ({ req, res, user }) => {
  const key = `user:${user.id}`;
  if (!feedbackLimiter.take(key)) {
    res.setHeader("Retry-After", String(feedbackLimiter.retryAfter(key)));
    throw new HttpError(429, "Slow down");
  }
  const body = createFeedbackSchema.parse(await readJsonBody(req));
  const item = await createFeedback(user.id, body);
  return created({ feedback: item });
});

/** The operator's inbox. Same gate as the instance report queue, same 404. */
router.get("/api/feedback/instance", async ({ url, user }) => {
  if (!isInstanceModerator(user)) {
    throw new NotFound("Not found");
  }
  const rawStatus = url.searchParams.get("status");
  return listFeedback({
    before: url.searchParams.get("before") ?? undefined,
    limit: clampLimit(
      url.searchParams.get("limit"),
      FEEDBACK_PAGE_SIZE,
      FEEDBACK_PAGE_MAX,
    ),
    status: rawStatus
      ? (feedbackStatusSchema.safeParse(rawStatus).data ?? undefined)
      : undefined,
  });
});

/**
 * Close or confirm one item. Confirming a bug is the fun path: it grants the
 * author the caça-bugs badge — see `resolveFeedback`.
 */
router.patch("/api/feedback/:item", async ({ req, user }, { item }) => {
  const feedbackId = feedbackIdParam(item);
  if (!isInstanceModerator(user)) {
    throw new NotFound("Feedback not found");
  }
  const body = resolveFeedbackSchema.parse(await readJsonBody(req));
  const resolved = await resolveFeedback(feedbackId, body.status);
  if (!resolved) {
    throw new NotFound("Feedback not found");
  }
  return { feedback: resolved };
});

// ---------------------------------------------------------------- invites

router.get("/api/servers/:serverId/invites", async ({ user }, { serverId }) => {
  await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
  return { invites: (await listInvites(serverId!)).map(mapInvite) };
});

router.post(
  "/api/servers/:serverId/invites",
  async ({ req, user }, { serverId }) => {
    await requirePermission(serverId!, user.id, Permission.CREATE_INVITE);
    const body = createInviteSchema.parse(await readJsonBody(req));
    const invite = await createInvite(serverId!, user.id, {
      maxUses: body.maxUses,
      expiresInHours: body.expiresInHours,
    });
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "invite.create",
      targetType: "invite",
      targetId: invite.id,
      changes: [{ key: "code", old: null, new: invite.code }],
    });
    return created({ invite: mapInvite(invite) });
  },
);

router.delete(
  "/api/servers/:serverId/invites/:inviteId",
  async ({ user }, { serverId, inviteId }) => {
    await requirePermission(serverId!, user.id, Permission.MANAGE_SERVER);
    await deleteInvite(serverId!, inviteId!);
    await logAudit({
      serverId: serverId!,
      actorId: user.id,
      action: "invite.delete",
      targetType: "invite",
      targetId: inviteId!,
    });
    return { ok: true };
  },
);

router.post("/api/invites/:code/join", async ({ user }, { code }) => {
  try {
    return await redeemInvite(code!, user.id);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid invite",
    );
  }
});

router.get("/api/invites/:code", async ({ user }, { code }) => {
  const invite = await getInviteByCode(code!);
  if (!invite) {
    throw new NotFound("Invite not found");
  }
  // Preview is intentionally readable by any signed-in user — that is the point
  // of an invite link — but it must not leak who else is in the server.
  void user;
  return { invite: mapInvite(invite) };
});

// ---------------------------------------------------------------- dispatch

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

const EMBED_IMAGE_PATH = /^\/api\/embeds\/([0-9a-f]{64})\/image$/;

/**
 * Deliberately unauthenticated, unlike every other `/api/` route: it only
 * ever re-serves a URL our own server already fetched from a link someone
 * posted — `getEmbedImageUrl` returns null for any hash that is not already
 * in the cache — refetched through the same SSRF-guarded path that cached it
 * in the first place. That exposes nothing an unauthenticated visitor to the
 * original page could not already see, so gating it behind Clerk would buy
 * no confidentiality while breaking the plain `<img src>` tag that renders
 * it: a browser cannot attach a Bearer token to an image request.
 */
async function serveEmbedImage(
  req: IncomingMessage,
  res: ServerResponse,
  urlHash: string,
): Promise<void> {
  const imageUrl = await getEmbedImageUrl(urlHash);
  if (!imageUrl) {
    sendError(res, 404, "Not found", req);
    return;
  }
  try {
    const response = await safeFetch(imageUrl, { accept: "image/*" });
    const contentType = (response.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim();
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      !contentType.startsWith("image/")
    ) {
      sendError(res, 404, "Not found", req);
      return;
    }
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    });
    res.end(response.body);
  } catch {
    sendError(res, 404, "Not found", req);
  }
}

const AVATAR_OBJECT_PATH =
  /^\/api\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Somebody's uploaded profile picture, as a redirect to the object store.
 *
 * DELIBERATELY UNAUTHENTICATED, the third route in this file that is, and for
 * the same reason as the embed-image proxy above: a browser cannot attach a
 * Bearer token to an `<img src>`. Gating it behind Clerk would buy nothing
 * either — an avatar is `publicUserSchema` material, readable about any account
 * by any other through user search, so this discloses nothing that was not
 * already enumerable. What it deliberately does *not* accept is a storage key:
 * the path names a user, the key is looked up, and there is no shape of request
 * that can address an arbitrary object in the bucket.
 *
 * A redirect rather than a proxy — the opposite of the embed route, which
 * fetches the bytes itself. That one has to, because the origin is a third
 * party we are hiding the reader's IP from. Here the bytes are in our own
 * bucket, and streaming five megabytes per avatar per viewer through the API is
 * exactly the egress bill the presigned-URL design exists to avoid.
 *
 * The 404 covers "no such user", "no uploaded avatar" and "storage is
 * unconfigured" identically. All three mean the same thing to the client, which
 * draws the monogram; and answering them apart would turn this into a way to
 * probe which account ids exist.
 */
async function serveAvatarObject(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  let url: string | null;
  try {
    url = await presignAvatarRead(userId);
  } catch (error) {
    console.error(`[avatars] could not resolve ${userId}:`, error);
    sendError(res, 404, "Not found", req);
    return;
  }
  if (!url) {
    sendError(res, 404, "Not found", req);
    return;
  }
  // Cacheable because the URL carries `?v=<hash of the key>`: a new avatar is a
  // new address, so nothing here can serve a stale picture. The window is kept
  // under the presigned target's own hour so a cached redirect cannot outlive
  // the URL it points at.
  res.writeHead(302, {
    location: url,
    "cache-control": "public, max-age=300",
  });
  res.end();
}

const USER_BANNER_OBJECT_PATH =
  /^\/api\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/banner$/;

/**
 * Somebody's uploaded banner, as a redirect to the object store.
 *
 * UNAUTHENTICATED FOR THE REASON `serveAvatarObject` IS, and with a stronger
 * case: a browser cannot attach a Bearer token to an `<img src>`, and the one
 * page that draws this is served to people with no account at all. What it
 * discloses is one image about an account whose id the caller already has — and
 * the only way to have that id is to be inside the instance, because the public
 * profile deliberately does not carry one.
 *
 * A redirect rather than a proxy, exactly as avatars are: the bytes are in our
 * own bucket, and streaming eight megabytes per banner per viewer through the
 * API is the egress bill the presigned-URL design exists to avoid.
 *
 * The 404 covers "no such user", "no uploaded banner" and "storage is
 * unconfigured" identically, so this cannot be used to probe which ids exist.
 */
async function serveUserBannerObject(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  let url: string | null;
  try {
    url = await presignUserBannerRead(userId);
  } catch (error) {
    console.error(`[banners] could not resolve ${userId}:`, error);
    sendError(res, 404, "Not found", req);
    return;
  }
  if (!url) {
    sendError(res, 404, "Not found", req);
    return;
  }
  // Cacheable because the URL carries `?v=<hash of the key>`: a new banner is a
  // new address, so nothing here can serve a stale picture. The window stays
  // under the presigned target's own hour so a cached redirect cannot outlive
  // the URL it points at.
  res.writeHead(302, {
    location: url,
    "cache-control": "public, max-age=300",
  });
  res.end();
}

const SERVER_IMAGE_OBJECT_PATH =
  /^\/api\/servers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(icon|banner|featured)$/;

/**
 * A server's icon, banner, or community featured image, as a redirect to the
 * object store.
 *
 * DELIBERATELY UNAUTHENTICATED, the fourth route in this file that is, and for
 * the same reason as `serveAvatarObject`: a browser cannot attach a Bearer
 * token to an `<img src>`. Featured reads `community_featured_key`, not the
 * icon or banner columns — the kind in the path is the lookup. What it
 * discloses is one image about a server whose id the caller already has — and
 * for a listed community, the directory hands that id to strangers by design.
 * For an unlisted server, the id is the secret (as it is for every other id in
 * this schema), and a picture is strictly less than the name and member count
 * an invite already reveals.
 *
 * A redirect rather than a proxy, exactly as avatars are: the bytes are in our
 * own bucket and streaming a banner per viewer per render is the egress bill
 * the presigned-URL design exists to avoid.
 *
 * The 404 covers "no such server", "no picture of that kind" and "storage is
 * unconfigured" identically — all three mean the same thing to the client,
 * which draws the monogram or nothing at all, and answering them apart would
 * turn this into a way to probe which server ids exist.
 */
async function serveServerImageObject(
  req: IncomingMessage,
  res: ServerResponse,
  serverId: string,
  kind: ServerImageKind,
): Promise<void> {
  if (kind !== "icon" && kind !== "banner" && kind !== "featured") {
    sendError(res, 404, "Not found", req);
    return;
  }
  let url: string | null;
  try {
    url = await presignServerImageRead(kind, serverId);
  } catch (error) {
    console.error(`[server-images] could not resolve ${serverId}:`, error);
    sendError(res, 404, "Not found", req);
    return;
  }
  if (!url) {
    sendError(res, 404, "Not found", req);
    return;
  }
  // Cacheable because the URL carries `?v=<hash of the key>`: a new picture is
  // a new address, so nothing here can serve a stale one. The window stays
  // under the presigned target's own hour so a cached redirect cannot outlive
  // the URL it points at.
  res.writeHead(302, {
    location: url,
    "cache-control": "public, max-age=300",
  });
  res.end();
}

const PUBLIC_PROFILE_PATH = /^\/api\/public\/profiles\/([^/]{1,64})$/;

/**
 * One person's public profile, by handle.
 *
 * DELIBERATELY UNAUTHENTICATED — the fourth route in this file that is, and the
 * only one that answers with a person rather than with bytes. It has to be:
 * `pqp.gg/@rafa` is a link somebody puts in an Instagram bio, and a link that
 * demands a login before it will render is a link nobody clicks. The Cloudflare
 * Pages middleware that injects Open Graph tags calls this too, from an edge
 * worker that has no session to offer and never will.
 *
 * WHAT MAKES THAT SAFE IS THE SHAPE, not the gate. `getPublicProfileByHandle`
 * returns `publicProfileSchema` and nothing wider: a handle the person chose to
 * publish, the display name and picture every member of every shared server can
 * already see, the public communities they are in, and a count. No id, no
 * `name#1234` tag, no email, no presence, no message content, no private
 * servers. Everything here is already public *about somebody who claimed a
 * public handle*, and claiming one is opt-in.
 *
 * NOT ENUMERABLE. There is no list route and no prefix route — the caller must
 * already know the handle, the same way `/api/users/lookup` requires the four
 * digits. The 404 covers "no such handle", "that handle is a character", and
 * "that handle is a webhook row" identically, so this cannot be used to sort
 * accounts into kinds. It is also, deliberately, the exact answer the claim
 * landing reads as "this handle is free".
 *
 * Rate limited on its own bucket rather than sharing `anonLimiter`: the claim
 * landing calls it on a debounce while somebody types, so the shape of legitimate
 * traffic here is bursty in a way no other public route is. Keyed by address,
 * which is the only key available before auth.
 */
async function servePublicProfile(
  req: IncomingMessage,
  res: ServerResponse,
  handle: string,
): Promise<void> {
  const address = clientAddress(req as never);
  if (!publicProfileLimiter.take(`profile:${address}`)) {
    res.setHeader(
      "Retry-After",
      String(publicProfileLimiter.retryAfter(`profile:${address}`)),
    );
    sendError(res, 429, "Too many requests", req);
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(handle);
  } catch {
    sendError(res, 404, "Not found", req);
    return;
  }

  let profile;
  try {
    profile = await getPublicProfileByHandle(decoded);
  } catch (error) {
    console.error(`[profiles] could not resolve ${decoded}:`, error);
    sendError(res, 503, "Profiles temporarily unavailable", req);
    return;
  }

  if (!profile) {
    sendError(res, 404, "Not found", req);
    return;
  }

  // THE ONE JSON RESPONSE IN THIS FILE THAT IS NOT `no-store`, which is why it
  // is written by hand instead of through `sendJson`.
  //
  // Everything else here is per-viewer and Bearer-authed, so a shared cache
  // holding one would be handing one user's data to the next caller — hence the
  // blanket `no-store` in lib/http.ts. This body is the exact opposite: it is
  // identical for every caller by construction, it required no credential to
  // obtain, and the traffic shape is a link going around WhatsApp. A minute is
  // long enough that a thousand recipients are not a thousand queries, and short
  // enough that changing your avatar is visible before you have finished telling
  // people to look.
  //
  // The 404 above stays `no-store` deliberately — it is what the claim landing
  // reads as "this handle is free", and a cached "free" is a cached wrong answer
  // the moment somebody claims it.
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60",
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  res.end(JSON.stringify({ profile }));
}

const PUBLIC_COMMUNITY_PATH = /^\/api\/public\/communities\/([^/]{1,64})$/;

/**
 * One community's public page, by slug.
 *
 * THE FIFTH UNAUTHENTICATED ROUTE IN THIS FILE and the second that answers with
 * something other than bytes. It exists for the reason `servePublicProfile`
 * does: `pqp.gg/c/valorant-brasil` is a link somebody puts in a Twitch bio, and
 * a link that demands a login before it renders is a link nobody clicks. The
 * Pages middleware that injects Open Graph tags calls it too, from an edge
 * worker that has no session to offer and never will.
 *
 * WHAT MAKES THAT SAFE IS THE SHAPE, not the gate. `getPublicCommunity` returns
 * `publicCommunitySchema` and nothing wider: the name, the address, the pitch,
 * the category, a member COUNT, the two pictures, and a month. No member list —
 * that is a disclosure of who talks to whom and is the single worst thing this
 * page could do — no messages, no channels, no owner, and no id. The id in
 * particular is withheld so the join intent has to travel as a slug and be
 * resolved behind auth.
 *
 * NOT A BROWSE, WHICH IS WHY IT DOES NOT ROUTE AROUND THE 18+ GATE. There is no
 * list route and no prefix route; the caller must already hold the exact slug,
 * which means somebody sent them the link. Reading the poster is not walking
 * in, and the CTA leads to sign-up and the age check like every other door.
 *
 * BEHIND `COMMUNITIES_ENABLED`, and the 404 it answers with when the flag is
 * off is indistinguishable from an unknown slug. A deployment without the
 * directory has no public community pages, and a probe cannot learn that a
 * future version of pqp does.
 *
 * Shares `publicProfileLimiter`'s posture but not its bucket: the two are
 * different traffic shapes reached from different pages, and one budget spent
 * by a crawler walking profiles must not close the door on a community link
 * going around WhatsApp.
 */
async function servePublicCommunity(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<void> {
  const address = clientAddress(req as never);
  if (!publicCommunityLimiter.take(`community:${address}`)) {
    res.setHeader(
      "Retry-After",
      String(publicCommunityLimiter.retryAfter(`community:${address}`)),
    );
    sendError(res, 429, "Too many requests", req);
    return;
  }

  if (!isCommunitiesEnabled()) {
    sendError(res, 404, "Not found", req);
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(slug).toLowerCase();
  } catch {
    sendError(res, 404, "Not found", req);
    return;
  }
  // Shape-checked before it reaches Postgres. A slug is a path segment from the
  // open internet, and the alternative is one query per junk string a scanner
  // throws at us.
  if (!COMMUNITY_SLUG_PATTERN.test(decoded)) {
    sendError(res, 404, "Not found", req);
    return;
  }

  let community;
  try {
    community = await getPublicCommunity(decoded);
  } catch (error) {
    console.error(`[communities] could not resolve ${decoded}:`, error);
    sendError(res, 503, "Communities temporarily unavailable", req);
    return;
  }

  if (!community) {
    sendError(res, 404, "Not found", req);
    return;
  }

  // Cacheable for the same minute the public profile gets, and for the same
  // three reasons: identical for every caller by construction, obtained with no
  // credential, and shaped like a link going around a group chat. The 404 above
  // stays `no-store` — a community can be listed at any moment, and a cached
  // "no such page" would outlive the decision to publish it.
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60",
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  res.end(JSON.stringify({ community }));
}

const WEBHOOK_EXECUTE_PATH =
  /^\/api\/webhooks\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)$/;

/**
 * Deliberately unauthenticated, same reasoning as the embed-image proxy —
 * except here the URL itself (id + token) *is* the credential, exactly the
 * way a real Discord webhook URL is: whoever configured this address in
 * GitHub, a CI job, or a monitoring tool never has a Clerk session to send.
 * `getWebhookForExecution` requires both halves to match, so this answers
 * the same 404 whether the id is wrong, the token is wrong, or both.
 *
 * Slow mode does not reach here, on purpose. This path has its own INSERT and
 * never goes through `postChannelMessage`, and that is the right shape: a
 * webhook is a pipe, not a resident. Its URL was configured once by somebody
 * who held MANAGE_WEBHOOKS on the channel, what comes out of it is a build
 * result or an alert that is useless late, and there is no person on the other
 * end to show a countdown to. A flood from one is a webhook to revoke rather
 * than a member to slow down. `webhookExecuteLimiter` above is its budget. A
 * *character account* is the opposite case and is not exempt: it has a name, a
 * face and a seat in the room, so it waits like anyone else -- see
 * docs/BOT_SEND.md.
 */
async function handleWebhookExecute(
  req: IncomingMessage,
  res: ServerResponse,
  webhookId: string,
  token: string,
): Promise<void> {
  if (!webhookExecuteLimiter.take(`webhook:${webhookId}`)) {
    res.setHeader(
      "Retry-After",
      String(webhookExecuteLimiter.retryAfter(`webhook:${webhookId}`)),
    );
    sendError(res, 429, "Too many requests", req);
    return;
  }

  const webhook = await getWebhookForExecution(webhookId, token);
  if (!webhook) {
    sendError(res, 404, "Unknown webhook", req);
    return;
  }

  let body;
  try {
    body = executeWebhookSchema.parse(await readJsonBody(req));
  } catch {
    sendError(res, 400, "Invalid webhook payload", req);
    return;
  }

  const message = await executeWebhook(webhook, body);
  const mapped = mapMessage(message);
  broadcastToChannel(webhook.channel_id, {
    type: "message-broadcast",
    message: mapped,
  });
  sendJson(res, 200, { message: mapped }, req);
}

/**
 * Tab close cannot wait for a Clerk token, and a WebSocket `leave-voice-room`
 * sent from `pagehide` is often dropped with the socket. The resume HMAC is
 * the credential, the same way a webhook URL is: whoever holds it can only
 * retire that one peer. Invalid or unknown pairs still answer 204 so this
 * is not an oracle for live peer ids.
 */
async function handleVoiceLeaveBeacon(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const key = `ip:${clientAddress(req as never)}`;
  if (!voiceLeaveLimiter.take(key)) {
    res.setHeader(
      "Retry-After",
      String(voiceLeaveLimiter.retryAfter(key)),
    );
    sendError(res, 429, "Too many requests", req);
    return;
  }

  let body: { resumePeerId?: unknown; resumeToken?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return;
    }
    sendError(res, 400, "Invalid JSON body", req);
    return;
  }

  const resumePeerId =
    typeof body.resumePeerId === "string" ? body.resumePeerId : "";
  const resumeToken =
    typeof body.resumeToken === "string" ? body.resumeToken : "";
  if (isUuid(resumePeerId) && resumeToken.length > 0) {
    // Local seat: removed before this returns. Foreign seat (registry on):
    // the row, on its own time; the beacon has no reply to wait for.
    void leaveVoiceByResumeToken(resumePeerId, resumeToken);
  }

  res.writeHead(204, {
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  res.end();
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (handleCors(req, res)) {
    return;
  }

  const address = clientAddress(req as never);
  if (!anonLimiter.take(`ip:${address}`)) {
    res.setHeader("Retry-After", String(anonLimiter.retryAfter(`ip:${address}`)));
    sendError(res, 429, "Too many requests", req);
    return;
  }

  const imageMatch =
    req.method === "GET" ? EMBED_IMAGE_PATH.exec(pathname) : null;
  if (imageMatch) {
    await serveEmbedImage(req, res, imageMatch[1]!);
    return;
  }

  const avatarMatch =
    req.method === "GET" ? AVATAR_OBJECT_PATH.exec(pathname) : null;
  if (avatarMatch) {
    await serveAvatarObject(req, res, avatarMatch[1]!);
    return;
  }

  const userBannerMatch =
    req.method === "GET" ? USER_BANNER_OBJECT_PATH.exec(pathname) : null;
  if (userBannerMatch) {
    await serveUserBannerObject(req, res, userBannerMatch[1]!);
    return;
  }

  const serverImageMatch =
    req.method === "GET" ? SERVER_IMAGE_OBJECT_PATH.exec(pathname) : null;
  if (serverImageMatch) {
    await serveServerImageObject(
      req,
      res,
      serverImageMatch[1]!,
      serverImageMatch[2] as ServerImageKind,
    );
    return;
  }

  const profileMatch =
    req.method === "GET" ? PUBLIC_PROFILE_PATH.exec(pathname) : null;
  if (profileMatch) {
    await servePublicProfile(req, res, profileMatch[1]!);
    return;
  }

  const publicCommunityMatch =
    req.method === "GET" ? PUBLIC_COMMUNITY_PATH.exec(pathname) : null;
  if (publicCommunityMatch) {
    await servePublicCommunity(req, res, publicCommunityMatch[1]!);
    return;
  }

  const webhookMatch =
    req.method === "POST" ? WEBHOOK_EXECUTE_PATH.exec(pathname) : null;
  if (webhookMatch) {
    await handleWebhookExecute(req, res, webhookMatch[1]!, webhookMatch[2]!);
    return;
  }

  if (req.method === "POST" && pathname === "/api/voice/leave") {
    await handleVoiceLeaveBeacon(req, res);
    return;
  }

  // The HLS playlist proxy for players that cannot send a header: a verified
  // per-viewer `?t=` token stands in for the Bearer. With no header at all
  // this is the only door; with a header that FAILS it is tried again below,
  // after the Bearer resolution has had its say (see `tryHlsCapabilityDoor`).
  if (!req.headers.authorization) {
    if (await tryHlsCapabilityDoor(req, res, pathname)) {
      return;
    }
    if (await tryHlsReplayCapabilityDoor(req, res, pathname)) {
      return;
    }
    if (await tryWatchPartyDownloadCapabilityDoor(req, res, pathname)) {
      return;
    }
  }

  // The operator dashboard's machine token, for exactly two GETs and nothing
  // else. Checked before Clerk resolution because the caller (a Cloudflare
  // Worker) has no session to present; a header that does not match falls
  // through to the normal resolution, so a moderator's JWT still works and an
  // unauthenticated probe still ends in the same 404 as a non-moderator.
  //
  // The second one is the voice occupancy history. It is on the same token
  // deliberately: it is the same reader, the same dashboard and the same
  // sensitivity (aggregate counts, no id, no name), and a second secret to
  // rotate would be a second secret to forget.
  const machineRoute = matchAdminMachineRoute(req.method ?? "GET", pathname);
  const isAdminMachineRequest = machineRoute !== null;
  if (machineRoute && isAdminMetricsTokenValid(req.headers.authorization)) {
    // The operator's own bucket. The per-identity limiters below are keyed on
    // a user id and this caller has none, so without this a loop in the
    // dashboard's own JavaScript would hit the database as fast as the Worker
    // could forward it. One dashboard, generous; a script, not.
    if (!operatorLimiter.take("machine")) {
      res.setHeader("Retry-After", String(operatorLimiter.retryAfter("machine")));
      sendError(res, 429, "Slow down", req);
      return;
    }
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    try {
      sendJson(res, 200, await machineRoute.run(req, query), req);
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        sendDatabaseUnavailable(res, req);
      } else if (error instanceof HttpError) {
        sendError(res, error.status, error.message, req);
      } else if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ZodError"
      ) {
        sendError(res, 400, "Invalid request", req);
      } else {
        console.error("[operator] machine route failed:", error);
        sendError(res, 500, "Internal server error", req);
      }
    }
    return;
  }

  let resolved: Awaited<ReturnType<typeof resolveAuthSession>> = null;
  try {
    // Its own label, not the eventual route's: this runs before the router
    // has matched anything (a 404 gets resolved too), and a Clerk/DB round
    // trip here is shared account-resolution work, not business logic that
    // belongs to whichever endpoint happens to follow it. Without this label
    // every one of these queries — 53k UPDATEs in 16.5h of the 2026-09-13
    // Vultr cutover alone — was silently folded into `dbQueries.byRoute`'s
    // `"other"` bucket, hiding a real cost center behind the same label used
    // for WS handlers and cold jobs.
    resolved = await runWithRoute(AUTH_ROUTE_LABEL, () =>
      resolveAuthSession(req.headers.authorization),
    );
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      // The breaker is open: this rejected in milliseconds rather than
      // hanging on the pool, and the caller gets the same shape every other
      // DB-dependent route does instead of the generic message below.
      sendDatabaseUnavailable(res, req);
      return;
    }
    console.error("[auth] resolve failed:", error);
    sendError(res, 503, "Authentication temporarily unavailable", req);
    return;
  }

  if (!resolved) {
    // A FAILED BEARER MUST NOT VETO A CAPABILITY WE SIGNED OURSELVES.
    //
    // This is the stall Rafael chased for an afternoon, and it took a
    // screenshot of his network panel to find because the server said nothing.
    // `handleApi` resolves a Bearer ahead of the router, so any header had to
    // succeed or the request was 401 before the `?t=` in the URL was ever
    // looked at. hls.js attaches a Clerk JWT on top of the token, refreshes it
    // every 30 s without `forceRefresh`, and a Clerk JWT lives about 60, so
    // roughly once a minute a playlist request carried a dead JWT and was
    // rejected: every web viewer, every watch party, since the feature
    // shipped. Proved on production with one URL and one valid token: token
    // alone 200, token plus an expired Bearer 401, token plus garbage 401.
    //
    // Nothing could see it. Every server-side test and every curl sent only
    // `?t=`, the one shape that never fails, and native iOS and Safari send
    // only `?t=` too. The failure lived solely in the shape hls.js produces.
    //
    // HERE rather than ahead of the router, deliberately. Trying the token
    // first would also let it serve a caller whose Bearer resolves to somebody
    // ELSE, which is a rule this route already has and keeps (a token naming
    // another user is not this caller's capability). Reaching it only once the
    // header has failed means there is no other caller to confuse it with: the
    // token, which names its user, channel and session, is HMACed by this
    // server and is minted only after a real access check, is then the
    // strongest evidence available. Revocation is still checked against its
    // own issue time.
    if (req.method === "GET" && (await tryHlsCapabilityDoor(req, res, pathname))) {
      return;
    }
    if (
      req.method === "GET" &&
      (await tryHlsReplayCapabilityDoor(req, res, pathname))
    ) {
      return;
    }
    if (
      req.method === "GET" &&
      (await tryWatchPartyDownloadCapabilityDoor(req, res, pathname))
    ) {
      return;
    }
    // The metrics route answers 404 to everybody it refuses, whether that is a
    // wrong token, no token, or a signed-in non-moderator. A 401 here would
    // tell a probe that the route exists and only the credential was wrong.
    if (isAdminMachineRequest) {
      sendError(res, 404, "Not found", req);
    } else {
      sendError(res, 401, "Unauthorized", req);
    }
    return;
  }

  const user = resolved.user;
  const method = req.method ?? "GET";

  if (!apiLimiter.take(`user:${user.id}`)) {
    res.setHeader("Retry-After", String(apiLimiter.retryAfter(`user:${user.id}`)));
    sendError(res, 429, "Too many requests", req);
    return;
  }
  if (WRITE_METHODS.has(method) && !writeLimiter.take(`user:${user.id}`)) {
    res.setHeader(
      "Retry-After",
      String(writeLimiter.retryAfter(`user:${user.id}`)),
    );
    sendError(res, 429, "Slow down", req);
    return;
  }

  // ------------------------------------------------------------ the age gate
  //
  // Here, and not in the routes. This is the same chokepoint argument the
  // Bearer resolution above rests on (see CLAUDE.md pitfall #8): the router has
  // over a hundred handlers and grows every week, so a per-route check is a
  // check somebody will forget on the route where it matters. Placed before
  // `router.match` so it covers every path — including ones that do not exist
  // yet, and including 404s and 405s, which a refused account has no business
  // enumerating either.
  //
  // The WebSocket half of the same gate lives in `resolveAuthUser`, which
  // refuses outright; only this caller can see a path, so only this caller can
  // grant the exemptions in `isAgeGateExempt`.
  if (resolved.ageGate !== "passed" && !isAgeGateExempt(method, pathname)) {
    sendError(
      res,
      403,
      resolved.ageGate === "blocked"
        ? AGE_GATE_BLOCKED_MESSAGE
        : AGE_GATE_PENDING_MESSAGE,
      req,
    );
    return;
  }

  // ----------------------------------------------------- the timeout gate
  //
  // Immediately after the age gate, and for the same reason it is here rather
  // than in the routes: a per-route check is a check somebody forgets on the
  // route where it matters. Placed before `router.match` so it covers paths
  // that do not exist yet.
  //
  // Narrower than the age gate in two ways, both deliberate. It runs on WRITE
  // methods only — a timeout takes away speaking, not reading, and gating GETs
  // would make it a partial ban. And it only asks the database at all when the
  // pathname names a server, a channel or a message; `/api/me`, `/api/dms`,
  // `/api/blocks` and `/api/reports` match no scope and cost nothing, which is
  // also how a timed-out member keeps the ability to report the fight they are
  // in. `findTimeoutForRequest` owns both rules — see the comment on
  // `TIMEOUT_EXEMPT_SUFFIXES` for the two writes that stay open.
  if (WRITE_METHODS.has(method)) {
    // Same reasoning as the `resolveAuthSession` call above: a gate that
    // runs ahead of every route, labelled as what it is rather than folded
    // into "other".
    const timeout = await runWithRoute(AUTH_ROUTE_LABEL, () =>
      findTimeoutForRequest(user.id, method, pathname),
    );
    if (timeout) {
      sendError(res, 403, timeoutMessage(timeout), req);
      return;
    }
  }

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(method, pathname);
    if (!matched) {
      sendError(res, 404, "Not found", req);
      return;
    }

    const ctx: RequestContext = { req, res, url, user, ageGate: resolved.ageGate };
    const result = await runWithRoute(`${method} ${matched.routePath}`, () =>
      matched.handler(ctx, matched.params),
    );
    // Conditional reads. Deliberately *here*, downstream of everything above:
    // the Bearer token has been resolved, the age gate and timeout gate have
    // run, the route matched, and the handler has finished — which means its
    // own `requireChannelAccess` / `requireServerMember` check has already
    // passed. An `If-None-Match` cannot short-circuit any of that, because the
    // tag is computed from a body this caller was just proved entitled to. A
    // caller who cannot see the channel gets the same 403/404 they always did,
    // whatever validator they present.
    if (result instanceof Etagged) {
      sendConditionalJson(req, res, result.body);
      return;
    }
    if (result instanceof Created) {
      sendJson(res, 201, result.body, req);
      return;
    }
    // The handler streamed its own answer (a past-broadcast download). There
    // is nothing left to write, and `sendJson` would throw on a socket whose
    // head went out long ago.
    if (result instanceof StreamedResponse) {
      return;
    }
    if (result instanceof RawResponse) {
      res.writeHead(200, {
        "content-type": result.contentType,
        ...(result.filename
          ? { "content-disposition": `attachment; filename="${result.filename}"` }
          : {}),
        ...SECURITY_HEADERS,
        ...corsHeaders(req),
      });
      res.end(result.body);
      return;
    }
    sendJson(res, 200, result, req);
  } catch (error) {
    // A3.1: the breaker rejected a query in milliseconds rather than the
    // route hanging on a saturated or unreachable pool for
    // `connectionTimeoutMillis`. Checked ahead of `HttpErrorWithDetail` and
    // `HttpError`, which it extends, for the same reason as the check below —
    // the extra header this one carries would be silently dropped by the
    // more general match.
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return;
    }
    // Checked before the plain `HttpError` branch it extends, or the extra
    // fields would be silently dropped by the more general match.
    if (error instanceof HttpErrorWithDetail) {
      sendJson(res, error.status, { error: error.message, ...error.detail }, req);
      return;
    }
    if (error instanceof OutgoingWebhookChannelsError) {
      sendJson(
        res,
        error.status,
        { error: error.message, code: error.code, channels: error.channels },
        req,
      );
      return;
    }
    if (error instanceof OutgoingWebhookSkipUsersError) {
      sendJson(
        res,
        error.status,
        { error: error.message, code: error.code, users: error.users },
        req,
      );
      return;
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return;
    }
    if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
      sendError(res, 400, "Invalid request", req);
      return;
    }
    console.error(error);
    sendError(res, 500, "Internal server error", req);
  }
}

// ===========================================================================
// PUSH ROUTES (Web Push) — bannered section, appended after handleApi.
//
// Registration order does not matter to the router (routes are matched from
// an array built at module load, and every registration below runs before the
// first request), so this section lives at the end of the file where it can
// be appended and merged without touching anyone else's routes. The import
// declarations are hoisted like any other.
//
// All of the behaviour lives in services/push.ts; these handlers only parse,
// authorise by the session user, and answer. Like the attachment routes, each
// leg is inert until its own env is configured — VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY / VAPID_SUBJECT for the browser, APNS_KEY_ID /
// APNS_TEAM_ID / APNS_PRIVATE_KEY for the iOS app. `/api/push/config` is how
// either client finds out, and the write routes refuse rather than store
// registrations nothing will ever send to.
// ===========================================================================

import {
  deletePushSubscription,
  deleteTokenSubscription,
  getPushSettings,
  getVapidPublicKey,
  isPushEnabled,
  pushRegistrationSchema,
  pushSettingsSchema,
  savePushRegistration,
  savePushSettings,
} from "../services/push.js";
import { isApnsEnabled } from "../services/apns.js";
import { isFcmEnabled } from "../services/fcm.js";

/**
 * What a client needs before it can offer the toggle: whether this server can
 * send at all, the public VAPID key to subscribe with, and the account's
 * DM-detail choice so the settings screen renders the stored truth. Neither
 * private key ever has a route.
 *
 * `enabled` remains the *Web Push* answer, unqualified, because that is what
 * the browser has always read it as. `apns` is the iOS app's equivalent, and
 * the two are independent: a deployment can run either, both, or neither.
 */
router.get("/api/push/config", async ({ user }) => {
  const enabled = isPushEnabled();
  return {
    enabled,
    publicKey: enabled ? getVapidPublicKey() : null,
    apns: isApnsEnabled(),
    // The Android app's gate. Absent until now, it defaulted false on the
    // client (see `gg.pqp.app.push.PushApi`), so an already-installed build
    // starts offering notifications the moment this answers true, no update
    // required.
    fcm: isFcmEnabled(),
    ...(await getPushSettings(user.id)),
  };
});

/**
 * Register this device. One route for both platforms — the body's shape says
 * which (see `pushRegistrationSchema`) — and idempotent per device identity:
 * the browser re-posts on every enable and after a rotation, and iOS hands the
 * app a device token on *every* launch, so the upsert keeps exactly one row per
 * endpoint or token, owned by the caller.
 *
 * The refusal is per leg. A server with VAPID keys and no APNs/FCM key must not
 * accept device tokens it can never send to, and vice versa — which is exactly
 * what makes an Android build's registration return 409 until the FCM leg is
 * configured (the client reads that as "no FCM leg", not an error).
 */
router.post("/api/push/subscriptions", async ({ req, user }) => {
  const body = pushRegistrationSchema.parse(await readJsonBody(req));
  const platform =
    "platform" in body ? (body.platform as "apns" | "fcm") : "web";
  const legEnabled =
    platform === "apns"
      ? isApnsEnabled()
      : platform === "fcm"
        ? isFcmEnabled()
        : isPushEnabled();
  if (!legEnabled) {
    throw new HttpError(409, "Push notifications are not configured on this server");
  }
  await savePushRegistration(user.id, body);
  return { ok: true };
});

/**
 * Unregister. Both identities travel as query parameters because one of them is
 * a URL — a path segment would need double-encoding, and the router's `:xId`
 * params are UUID-gated anyway. Exactly one must be given. Scoped to the
 * caller's own rows in the service.
 */
router.delete("/api/push/subscriptions", async ({ url, user }) => {
  const endpoint = url.searchParams.get("endpoint");
  const token = url.searchParams.get("token");
  if (endpoint) {
    await deletePushSubscription(user.id, endpoint);
    return { ok: true };
  }
  if (token) {
    // Covers both token platforms (APNs and FCM); the query carries only the
    // string, and scoping to the caller's own token rows deletes the right one
    // whichever it is.
    await deleteTokenSubscription(user.id, token);
    return { ok: true };
  }
  throw new HttpError(400, "endpoint or token query parameter required");
});

/**
 * The one push setting: whether a DM push may name the sender. Its own route
 * rather than a key in `PATCH /api/me/preferences`, because that route's
 * schema strips keys it does not know — see the note on push settings in
 * services/push.ts.
 */
router.patch("/api/push/settings", async ({ req, user }) => {
  const body = pushSettingsSchema.parse(await readJsonBody(req));
  return await savePushSettings(user.id, body);
});

// ================================================================== friends
//
// Appended as a self-contained section, imports included (ESM hoists them; the
// routes register on the same module-level `router` the rest of the file
// uses). Semantics — one row per pair, Discord's silent decline, block
// dominance — are argued in packages/shared/src/friends.ts and on the
// `friendships` table in schema.sql; enforcement is in services/friends.ts.
import { friendNudgeFor, friendRequestSchema } from "@pqp/shared";
import { notifyFriendActivity } from "../ws/chat.js";
import {
  acceptFriendRequest,
  FriendRequestFloodError,
  FriendRequestRefusedError,
  listFriendships,
  removeFriendship,
  sendFriendRequest,
} from "../services/friends.js";

/**
 * The volatile half of the abuse budget (the durable half is the
 * outgoing-pending cap counted in the database — see `sendFriendRequest`).
 * A friend request is contact with a stranger, so the budget is shaped like
 * `userSearchLimiter`'s: a burst that covers adding the handful of people you
 * met tonight, sustained about two a minute — a human adding friends, and a
 * spam run that would take all day. It also bounds the one loop the durable
 * cap cannot see: send-cancel-resend to the same person, which never
 * accumulates pending rows but re-surfaces an entry in their list each time.
 */
const friendRequestLimiter = createRateLimiter({
  capacity: 10,
  refillPerSecond: 1 / 30,
});

/**
 * The whole relationship surface in one read: friends (with status), requests
 * waiting on the caller, requests the caller has standing.
 *
 * Status is stamped here exactly the way the members route stamps it, and only
 * onto ACCEPTED friends. `resolveStatuses` can only produce `UserStatus`,
 * which cannot carry `invisible` — an invisible friend reads as `offline`, the
 * same privacy-first merge every other surface gets. Pending entries carry no
 * status at all: a stranger must not learn whether you are at your keyboard by
 * the act of asking.
 */
router.get("/api/friends", async ({ user }) => {
  const { friends, incoming, outgoing } = await listFriendships(user.id);
  const statuses = resolveStatuses(friends.map((friend) => friend.id));
  return {
    friends: friends.map((friend) => ({
      ...friend,
      status: statuses.get(friend.id) ?? "offline",
    })),
    incoming,
    outgoing,
  };
});

/**
 * Send a request. 201 when a new request now stands, 200 when the tap changed
 * nothing (already pending — deliberately without re-notifying) or completed
 * the handshake (`accepted`: they had already asked, or you already were
 * friends).
 *
 * Every refusal answers with the same message. "You blocked them", "they
 * blocked you" — telling those apart would make this route an oracle for
 * whether a specific person has blocked you, the exact probe POST /api/dms
 * already refuses to be. There is no new discovery here either: the body wants
 * a user id, which the caller can only have via the existing exact-handle
 * lookup or prefix search, both budgeted by `requireDiscoveryBudget`.
 */
router.post("/api/friends", async ({ req, user }) => {
  const body = friendRequestSchema.parse(await readJsonBody(req));
  if (!friendRequestLimiter.take(`user:${user.id}`)) {
    throw new HttpError(429, "Too many friend requests — slow down");
  }
  if (!(await getUserById(body.userId))) {
    throw new NotFound("User not found");
  }
  try {
    const result = await sendFriendRequest(user.id, body.userId);
    // The live half of "what does the other person SEE, and when". Which of the
    // four outcomes earns a nudge is `friendNudgeFor`'s decision, in shared and
    // under test, because the rule that matters is a NEGATIVE one:
    // `already-pending` must stay silent or resending becomes a bell. The
    // recipient is always the target here — for a fresh request they are the
    // one being asked, and for an auto-accept they are the one who asked first
    // and is still waiting to hear.
    const nudge = friendNudgeFor(result);
    if (nudge) {
      notifyFriendActivity(body.userId, nudge);
    }
    if (result === "pending") {
      return created({ state: "pending" });
    }
    return {
      state:
        result === "accepted" || result === "already-friends"
          ? "accepted"
          : "pending",
    };
  } catch (error) {
    if (error instanceof FriendRequestRefusedError) {
      // One message for every reason — see the route comment.
      throw new Forbidden("Cannot send a friend request to this user");
    }
    if (error instanceof FriendRequestFloodError) {
      throw new HttpError(429, error.message);
    }
    throw error;
  }
});

/** Accept a request somebody sent the caller. 404 when none is waiting. */
router.post("/api/friends/:userId/accept", async ({ user }, { userId }) => {
  if (!(await acceptFriendRequest(user.id, userId!))) {
    throw new NotFound("No pending friend request from this user");
  }
  // The one place a friendship's *other* side is told something, and it is the
  // side that asked for it: they sent a request and are owed the answer. Only
  // sent after the UPDATE actually matched, so accepting a request that was
  // already cancelled 404s and nudges nobody.
  notifyFriendActivity(userId!, "accepted");
  return { ok: true };
});

/**
 * Decline, cancel, or unfriend — whatever stands between the caller and this
 * person, silently, in one route. The other side is never notified; their
 * view simply stops listing it, which is the entire social contract that
 * makes declining usable.
 */
router.delete("/api/friends/:userId", async ({ user }, { userId }) => {
  if (!(await removeFriendship(user.id, userId!))) {
    throw new NotFound("No friendship or request with this user");
  }
  return { ok: true };
});

// ============================================================== depoimentos
//
// Appended as a self-contained section, imports included (ESM hoists them; the
// routes register on the same module-level `router` the rest of the file uses)
// — the shape the friends section above established.
//
// The mechanic, the "Não aceita!" lesson and the delete-on-refusal rule are
// argued in packages/shared/src/depoimentos.ts and on the `depoimentos` table
// in schema.sql; enforcement is in services/depoimentos.ts. What lives here is
// the HTTP surface, and the two things a route owns: which refusals are told
// apart in a response body (none of them are) and who gets nudged.
import {
  depoimentoBodySchema,
  updateProfileVisibilitySchema,
  writeDepoimentoSchema,
} from "@pqp/shared";
import {
  approveDepoimento,
  deleteDepoimento,
  DepoimentoFloodError,
  DepoimentoRefusedError,
  listApprovedDepoimentos,
  listPendingDepoimentos,
  listProfileCommunities,
  setProfileVisibility,
  writeDepoimento,
} from "../services/depoimentos.js";

/**
 * The volatile half of the write budget; the durable half is
 * `DEPOIMENTOS_PER_DAY`, counted in Postgres.
 *
 * Shaped like `reportLimiter` rather than like the message limiter, because
 * writing a depoimento is the same kind of act filing a report is: rare,
 * considered, and worth nothing in bulk. Five in a burst covers the evening
 * somebody works down their friends list after remembering this feature exists;
 * the refill makes a sustained run take all night and hit the daily cap first.
 */
const depoimentoLimiter = createRateLimiter({
  capacity: 5,
  refillPerSecond: 0.05,
});

/**
 * Write one about somebody. 201, and it always lands PENDING.
 *
 * EVERY REFUSAL ANSWERS WITH ONE SENTENCE. "You are not friends", "they blocked
 * you", "that is a character" — telling those apart would make this route an
 * oracle for a relationship the caller is not entitled to read, the same probe
 * `POST /api/friends` and `POST /api/dms` both refuse to be. There is no new
 * discovery here either: the id in the path is one the caller could only have
 * from the existing budgeted lookup or from a surface they already share.
 *
 * The body is validated by `depoimentoBodySchema` HERE rather than through the
 * request schema, so an author who ran long reads "keep it to 500 characters"
 * instead of the generic "Invalid request" the ZodError handler produces — the
 * same split `communityTaglineSchema` uses one section up.
 */
router.post(
  "/api/users/:userId/depoimentos",
  async ({ req, user }, { userId }) => {
    const body = writeDepoimentoSchema.parse(await readJsonBody(req));
    const parsed = depoimentoBodySchema.safeParse(body.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Invalid text",
      );
    }
    if (!depoimentoLimiter.take(`user:${user.id}`)) {
      throw new HttpError(429, "Too many depoimentos — slow down");
    }
    if (!(await getUserById(userId!))) {
      throw new NotFound("User not found");
    }
    try {
      const depoimento = await writeDepoimento(user.id, userId!, parsed.data);
      // The subject's queue just grew, and that queue is the only place this
      // exists. Content-free, on the friends frame, for the reason that frame
      // gives: the recipient is by construction somebody entitled to
      // `GET /api/me/depoimentos/pending`, and that read is the payload.
      notifyFriendActivity(userId!, "depoimento");
      return created({ depoimento });
    } catch (error) {
      if (error instanceof DepoimentoRefusedError) {
        // One message for every reason — see the route comment.
        throw new Forbidden("You can only write depoimentos for your friends");
      }
      if (error instanceof DepoimentoFloodError) {
        throw new HttpError(429, error.message);
      }
      throw error;
    }
  },
);

/**
 * A profile's published depoimentos, newest published first.
 *
 * Answers an EMPTY LIST rather than 403 for somebody outside the audience. The
 * card hides the section when it is empty, so "this person has none" and "you
 * may not read this person's" render identically — and a status code that told
 * them apart would report on a relationship the caller cannot otherwise
 * observe.
 */
router.get("/api/users/:userId/depoimentos", async ({ user }, { userId }) => {
  return { depoimentos: await listApprovedDepoimentos(user.id, userId!) };
});

/**
 * Your own queue — the ONLY place a pending depoimento is readable by anybody,
 * its author after sending very much included.
 */
router.get("/api/me/depoimentos/pending", async ({ user }) => {
  return { depoimentos: await listPendingDepoimentos(user.id) };
});

/**
 * Publish one. Only the subject may, and the client makes it two deliberate
 * taps over a preview of exactly what becomes public — §05 calls that the most
 * important UI decision in the feature, and it is the half of the "Não aceita!"
 * mitigation the server cannot enforce on its own.
 */
router.post(
  "/api/depoimentos/:depoimentoId/approve",
  async ({ user }, { depoimentoId }) => {
    const authorId = await approveDepoimento(user.id, depoimentoId!);
    if (!authorId) {
      throw new NotFound("No depoimento waiting on you with that id");
    }
    // The one moment the author hears anything, and it is the warm one: their
    // words are public now, which they are plainly entitled to know.
    notifyFriendActivity(authorId, "depoimento");
    return { ok: true };
  },
);

/**
 * Refuse a pending one, take a published one down, or withdraw your own —
 * whichever of the three the caller is entitled to, silently, in one route.
 *
 * THE SILENCE IS THE MITIGATION, not politeness. A notification on refusal
 * would tell the author "they read it and said no", which is the single fact
 * deleting the row exists to withhold, and it would make refusing socially
 * expensive in a feature whose entire safety rests on refusing staying cheap.
 */
router.delete(
  "/api/depoimentos/:depoimentoId",
  async ({ user }, { depoimentoId }) => {
    if (!(await deleteDepoimento(user.id, depoimentoId!))) {
      throw new NotFound("No depoimento with that id");
    }
    return { ok: true };
  },
);

/**
 * The community chips on somebody's profile card.
 *
 * NOT gated on `isCommunitiesEnabled()`, and that is not an oversight. On a
 * deployment with the directory off, no server can be `is_community` — the only
 * route that sets the column is itself gated — so this answers an empty list by
 * construction. The flag is enforced by the data rather than by a 404 the card
 * would have to special-case, and a card that must know about a feature flag
 * before it can render is a card that renders late.
 */
router.get("/api/users/:userId/communities", async ({ user }, { userId }) => {
  return await listProfileCommunities(user.id, userId!);
});

/**
 * "Show this community on my profile", flipped by the member themselves.
 *
 * A separate route from the server PATCH, which is the OWNER's: this is a fact
 * about the caller's own membership row and no owner has any business setting
 * it for them. The mirror image of the separation `PATCH /api/servers/:id`
 * already keeps for `updateCommunitySchema`.
 */
router.patch(
  "/api/servers/:serverId/profile-visibility",
  async ({ req, user }, { serverId }) => {
    const body = updateProfileVisibilitySchema.parse(await readJsonBody(req));
    if (!(await setProfileVisibility(user.id, serverId!, body.showOnProfile))) {
      throw new NotFound("Server not found");
    }
    return { ok: true, showOnProfile: body.showOnProfile };
  },
);
