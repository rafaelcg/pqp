import { deferredDialog, deferredPanel } from "@/components/deferred";
import { AppLoadingShell } from "@/components/layout/app-loading-shell";

/**
 * The app's second-screen surfaces, each one the component it names with the
 * chunk behind it. `App.tsx` imports these instead of the modules themselves;
 * the types still come from the real modules (a type import is erased, it never
 * pulls the chunk in). Why and how: `./deferred.tsx`.
 *
 * Adding one here is only worth it when NOTHING on the first screen imports the
 * same module statically, or the build folds the chunk back into the shell and
 * the split does nothing. `client/src/lib/startup-chunks.test.ts` fails when
 * that happens to the ones listed there.
 */

// ---- always-mounted dialogs, fetched the first time they are asked to open ----

export const SettingsModal = deferredDialog(() =>
  import("@/components/layout/settings-modal").then((m) => ({
    default: m.SettingsModal,
  })),
);
export const ServerSettingsDialog = deferredDialog(() =>
  import("@/components/layout/server-settings-dialog").then((m) => ({
    default: m.ServerSettingsDialog,
  })),
);
export const BotWizard = deferredDialog(() =>
  import("@/components/bots/bot-wizard").then((m) => ({
    default: m.BotWizard,
  })),
);
export const ChannelSettingsDialog = deferredDialog(() =>
  import("@/components/layout/channel-settings-dialog").then((m) => ({
    default: m.ChannelSettingsDialog,
  })),
);
export const CreateServerDialog = deferredDialog(() =>
  import("@/components/layout/create-server-dialog").then((m) => ({
    default: m.CreateServerDialog,
  })),
);
export const ConnectionDoctorDialog = deferredDialog(() =>
  import("@/components/layout/connection-doctor-dialog").then((m) => ({
    default: m.ConnectionDoctorDialog,
  })),
);
export const WatchPartyHistoryDialog = deferredDialog(() =>
  import("@/components/watch-party/watch-party-history-dialog").then((m) => ({
    default: m.WatchPartyHistoryDialog,
  })),
);
export const WatchPartyWaitlistDialog = deferredDialog(() =>
  import("@/components/watch-party/waitlist/watch-party-waitlist-dialog").then(
    (m) => ({ default: m.WatchPartyWaitlistDialog }),
  ),
);
export const CreateWatchPartyDialog = deferredDialog(() =>
  import("@/components/watch-party/create-watch-party-dialog").then((m) => ({
    default: m.CreateWatchPartyDialog,
  })),
);
export const ScheduleSessionSheet = deferredDialog(() =>
  import("@/components/voice/schedule-session-sheet").then((m) => ({
    default: m.ScheduleSessionSheet,
  })),
);
export const ForwardPicker = deferredDialog(() =>
  import("@/components/forward/forward-picker").then((m) => ({
    default: m.ForwardPicker,
  })),
);
export const ForwardDialog = deferredDialog(() =>
  import("@/components/chat/forward-dialog").then((m) => ({
    default: m.ForwardDialog,
  })),
);
export const BulkPurgeDialog = deferredDialog(() =>
  import("@/components/chat/bulk-purge-dialog").then((m) => ({
    default: m.BulkPurgeDialog,
  })),
);
export const InvitePanel = deferredDialog(() =>
  import("@/components/layout/invite-panel").then((m) => ({
    default: m.InvitePanel,
  })),
);
export const MembersPanel = deferredDialog(() =>
  import("@/components/layout/members-panel").then((m) => ({
    default: m.MembersPanel,
  })),
);
export const PinnedMessagesPanel = deferredDialog(() =>
  import("@/components/chat/pinned-messages-panel").then((m) => ({
    default: m.PinnedMessagesPanel,
  })),
);
// typeAhead: Ctrl/Cmd+K and then a word, straight after load, must not lose the
// word to the moment the chunk is still arriving (`lib/type-ahead.ts`).
export const QuickSwitcher = deferredDialog(
  () =>
    import("@/components/conversations/quick-switcher").then((m) => ({
      default: m.QuickSwitcher,
    })),
  undefined,
  { typeAhead: true },
);
export const ShortcutOverlay = deferredDialog(() =>
  import("@/components/layout/shortcut-overlay").then((m) => ({
    default: m.ShortcutOverlay,
  })),
);
export const NewDmDialog = deferredDialog(() =>
  import("@/components/user/new-dm-dialog").then((m) => ({
    default: m.NewDmDialog,
  })),
);
export const ReportDialog = deferredDialog(
  () =>
    import("@/components/chat/report-dialog").then((m) => ({
      default: m.ReportDialog,
    })),
  (props) => props.target != null,
);

// ---- panels drawn only while they are on screen ----

export const CommunityHomeFeed = deferredPanel(() =>
  import("@/components/community-home/community-home-feed").then((m) => ({
    default: m.CommunityHomeFeed,
  })),
);
export const ForumPane = deferredPanel(() =>
  import("@/components/forum").then((m) => ({ default: m.ForumPane })),
);
export const WatchPartyPanel = deferredPanel(() =>
  import("@/components/watch-party/watch-party-panel").then((m) => ({
    default: m.WatchPartyPanel,
  })),
);
export const WhatsNewView = deferredPanel(() =>
  import("@/components/layout/whats-new-view").then((m) => ({
    default: m.WhatsNewView,
  })),
);
export const ThreadPanel = deferredPanel(() =>
  import("@/components/chat/thread-panel").then((m) => ({
    default: m.ThreadPanel,
  })),
);
export const CommunitiesView = deferredPanel(() =>
  import("@/components/communities/communities-view").then((m) => ({
    default: m.CommunitiesView,
  })),
);

// First run only: the sign-up flow is a full screen, so it shows the same
// loading shell the app boots behind while its chunk arrives.
export const OnboardingFlow = deferredPanel(
  () =>
    import("@/components/onboarding/onboarding-flow").then((m) => ({
      default: m.OnboardingFlow,
    })),
  <AppLoadingShell />,
);

// The call stages carry the call screen, the watch player and the music
// player (about 400 KB). They are drawn for a voice channel or a conversation,
// and the chunk is already fetched by the time anybody joins.
export const VoiceChannelStage = deferredPanel(() =>
  import("@/components/voice/voice-channel-stage").then((m) => ({
    default: m.VoiceChannelStage,
  })),
);
export const DmCallStage = deferredPanel(() =>
  import("@/components/dm/dm-call-stage").then((m) => ({
    default: m.DmCallStage,
  })),
);
