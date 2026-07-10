/// <reference types="vite/client" />

import type { PqpDesktop } from "./lib/desktop";

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
  }
}

export {};
