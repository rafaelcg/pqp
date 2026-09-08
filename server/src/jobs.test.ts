import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every service is mocked: this file is about *scheduling*, not about what a
// sweep does. Each mock resolves immediately so the tick handlers settle.
vi.mock("./services/attachments.js", () => ({
  isAttachmentsConfigured: vi.fn(() => true),
  sweepOrphanedAttachments: vi.fn(async () => 0),
  sweepQuarantinedAttachments: vi.fn(async () => 0),
}));
vi.mock("./services/community-home.js", () => ({
  sweepOrphanedCommunityHomeMedia: vi.fn(async () => 0),
}));
vi.mock("./services/account.js", () => ({
  sweepPendingAccountDeletions: vi.fn(async () => 0),
}));
vi.mock("./services/audit.js", () => ({ pruneAuditLog: vi.fn(async () => 0) }));
vi.mock("./services/reports.js", () => ({
  pruneResolvedReports: vi.fn(async () => 0),
}));
vi.mock("./services/sanctions.js", () => ({
  pruneExpiredTimeouts: vi.fn(async () => 0),
}));
vi.mock("./services/retention.js", () => ({
  sweepMessageRetention: vi.fn(async () => 0),
}));
vi.mock("./services/slow-mode.js", () => ({
  sweepSlowModeClocks: vi.fn(async () => 0),
}));
vi.mock("./services/connections.js", () => ({
  sweepExpiredConnectionStates: vi.fn(async () => 0),
}));
vi.mock("./services/outgoing-webhooks.js", () => ({
  deliverDueOutgoingWebhooks: vi.fn(async () => 0),
  pruneDeliveredOutgoingWebhooks: vi.fn(async () => 0),
}));
vi.mock("./services/channel-sessions.js", () => ({
  sendDueChannelSessionReminders: vi.fn(async () => undefined),
}));
vi.mock("./services/voice-occupancy.js", () => ({
  OCCUPANCY_SAMPLE_INTERVAL_MS: 60_000,
  recordVoiceOccupancySample: vi.fn(async () => ({
    source: "local" as const,
    written: true,
  })),
  rollUpAndPruneVoiceOccupancy: vi.fn(async () => ({
    daysRolledUp: 0,
    minutesPruned: 0,
  })),
}));

import {
  sweepOrphanedAttachments,
  sweepQuarantinedAttachments,
} from "./services/attachments.js";
import { sweepOrphanedCommunityHomeMedia } from "./services/community-home.js";
import { sweepPendingAccountDeletions } from "./services/account.js";
import { pruneAuditLog } from "./services/audit.js";
import { sweepMessageRetention } from "./services/retention.js";
import { sweepSlowModeClocks } from "./services/slow-mode.js";
import { deliverDueOutgoingWebhooks } from "./services/outgoing-webhooks.js";
import { sendDueChannelSessionReminders } from "./services/channel-sessions.js";
import {
  OCCUPANCY_SAMPLE_INTERVAL_MS,
  recordVoiceOccupancySample,
} from "./services/voice-occupancy.js";
import {
  ATTACHMENT_SWEEP_INTERVAL_MS,
  CHANNEL_SESSION_REMINDER_INTERVAL_MS,
  DAILY_MS,
  OUTGOING_WEBHOOK_TICK_MS,
  PENDING_DELETION_SWEEP_INTERVAL_MS,
  startColdJobs,
  type ColdJobs,
} from "./jobs.js";
import { processRole, runsColdJobs } from "./lib/process-role.js";

/**
 * The guard under test is "each job runs in exactly one place". That is two
 * halves: `runsColdJobs(role)` decides whether this process schedules them at
 * all, and `startColdJobs` is what it schedules. The wiring in index.ts and
 * worker.ts is one `if` each.
 */
describe("cold jobs", () => {
  let jobs: ColdJobs | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    jobs?.stop();
    jobs = null;
    vi.useRealTimers();
  });

  it("runs the boot sweeps once, immediately", async () => {
    jobs = startColdJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepQuarantinedAttachments).toHaveBeenCalledTimes(1);
    expect(sweepOrphanedAttachments).toHaveBeenCalledTimes(1);
    expect(sweepOrphanedCommunityHomeMedia).toHaveBeenCalledTimes(1);
    // Nothing else fires at t=0.
    expect(deliverDueOutgoingWebhooks).not.toHaveBeenCalled();
    expect(pruneAuditLog).not.toHaveBeenCalled();
  });

  it("fires each job on its own cadence", async () => {
    jobs = startColdJobs();
    expect(jobs.count).toBe(15);

    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_TICK_MS);
    expect(deliverDueOutgoingWebhooks).toHaveBeenCalledTimes(1);

    // One occupancy row a minute, and not one at boot: an extra sample at t=0
    // would land in the same minute bucket as the first tick anyway, so the
    // boot sweeps deliberately do not include it.
    expect(recordVoiceOccupancySample).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SAMPLE_INTERVAL_MS);
    expect(recordVoiceOccupancySample).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SAMPLE_INTERVAL_MS * 3);
    expect(recordVoiceOccupancySample).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(PENDING_DELETION_SWEEP_INTERVAL_MS);
    expect(sweepPendingAccountDeletions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ATTACHMENT_SWEEP_INTERVAL_MS);
    // Boot sweep plus the first hourly tick.
    expect(sweepOrphanedAttachments).toHaveBeenCalledTimes(2);
    expect(pruneAuditLog).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DAILY_MS);
    expect(pruneAuditLog).toHaveBeenCalledTimes(1);
    expect(sweepMessageRetention).toHaveBeenCalledTimes(1);
    expect(sweepSlowModeClocks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHANNEL_SESSION_REMINDER_INTERVAL_MS);
    expect(sendDueChannelSessionReminders).toHaveBeenCalled();
  });

  it("a failing sweep is logged and the timer survives", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(deliverDueOutgoingWebhooks).mockRejectedValueOnce(
      new Error("boom"),
    );
    jobs = startColdJobs();
    await vi.advanceTimersByTimeAsync(OUTGOING_WEBHOOK_TICK_MS * 2);
    expect(deliverDueOutgoingWebhooks).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "[outgoing-webhooks] failed:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("stop() clears every timer and is idempotent", async () => {
    jobs = startColdJobs();
    jobs.stop();
    jobs.stop();
    expect(jobs.count).toBe(0);
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(DAILY_MS * 2);
    expect(deliverDueOutgoingWebhooks).not.toHaveBeenCalled();
    expect(pruneAuditLog).not.toHaveBeenCalled();
  });

  it("the role decides who schedules: unset means the API, split means the worker", () => {
    // Self-host / local dev: the API keeps running them, as today.
    expect(runsColdJobs(processRole({}))).toBe(true);
    // Split deploy: exactly one of the two says yes.
    const api = runsColdJobs(processRole({ WORKER_MODE: "api" }));
    const worker = runsColdJobs(processRole({ WORKER_MODE: "1" }));
    expect(api).toBe(false);
    expect(worker).toBe(true);
    expect(Number(api) + Number(worker)).toBe(1);
  });
});
