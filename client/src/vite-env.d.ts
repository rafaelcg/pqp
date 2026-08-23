/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { PqpDesktop } from "./lib/desktop";
import type { VoiceStatsConsole } from "./lib/voice-stats-probe";

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_TURN_URL?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly VITE_VOICE_BACKEND?: "mesh" | "cloudflare-sfu" | "livekit";
  readonly VITE_DEV_AUTH_BYPASS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    pqpDesktop?: PqpDesktop;
    /**
     * Attached only once a mesh call has opened its first connection — see
     * `lib/voice-stats-probe.ts`. Nothing in the app reads it; it exists so a
     * live call can be measured from the console instead of described.
     */
    pqpVoiceStats?: VoiceStatsConsole;
  }
}

export {};
