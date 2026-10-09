import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../db.js";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "./bus.js";
import { HttpError } from "./http.js";
import { logEvent } from "./log.js";

/**
 * RUNTIME FEATURE FLAGS. See `docs/FEATURE_FLAGS.md`.
 *
 * A switch that used to be an environment variable, and so needed an env edit
 * plus a container recreate to move, is now answered here, in this order:
 *
 *   1. a per-server override (`feature_flag_overrides`), for flags that allow one;
 *   2. the global row (`feature_flags.enabled`, when not NULL);
 *   3. the environment variable, parsed exactly the way its old reader did;
 *   4. the code default.
 *
 * With no row at all, 3 and 4 are the whole answer, which is byte for byte
 * what the old reader returned. That is the self-host story: an instance that
 * never opens the dashboard keeps configuring these by environment and never
 * notices this file exists.
 *
 * READS ARE SYNCHRONOUS. Every converted switch was a plain `boolean` function
 * read on hot paths (a room pin, a monitor tick, a config request), and making
 * each caller async to consult Postgres would have been a rewrite of half of
 * `voice/` for no gain. So the whole table (it is tiny: a row per flag the
 * operator touched, plus the per-server overrides) lives in one in-process
 * snapshot, and `isEnabled` is a Map lookup.
 *
 * FRESHNESS, in three layers:
 *   - The instance that takes a write reloads before it answers the request.
 *   - It then publishes `flags.changed` on the cluster bus, and every sibling
 *     reloads the moment the frame lands: one query, a few milliseconds.
 *   - Independently of the bus, a read that finds the snapshot older than the
 *     TTL (`FEATURE_FLAGS_TTL_MS`, 10 s) starts a reload in the background and
 *     answers from the snapshot it has. So with the bus off (a self-host, the
 *     worker, which publishes but never listens) or a frame dropped while the
 *     bus was reconnecting, a flip is still seen, just up to a TTL late.
 *
 * FAIL SAFE. A reload that fails keeps the last snapshot it had and waits a
 * TTL before trying again, so an outage does not turn every read into a
 * query. Before any snapshot has ever loaded, the answer is the environment
 * default. There is no state in which a flag answers something nobody set.
 *
 * NOT STARTED, NOT CONSULTED. Until `startFeatureFlags()` runs (boot does it,
 * right after `initDb`), reads never touch the database and answer from the
 * environment alone. That is what keeps every unit test that sets
 * `process.env.X` and calls a reader exactly as it was.
 */

// ----------------------------------------------------------------- registry

type EnvParser = (raw: string | undefined) => boolean | null;

/**
 * Words, not a generic "truthy": each flag keeps its old reader's exact
 * vocabulary, including its quirks (`VOICE_MESH_RESUME_REQUIRES_CAP` was
 * `=== "true"`, case sensitive and untrimmed, and still is).
 */
function words({
  on,
  off,
  otherwise = null,
  normalise = true,
}: {
  on: string[];
  off: string[];
  /** What a SET value outside both lists meant to the old reader. */
  otherwise?: boolean | null;
  normalise?: boolean;
}): EnvParser {
  return (raw) => {
    if (raw === undefined) {
      return null;
    }
    const value = normalise ? raw.trim().toLowerCase() : raw;
    if (value === "") {
      return null;
    }
    if (on.includes(value)) {
      return true;
    }
    if (off.includes(value)) {
      return false;
    }
    return otherwise;
  };
}

/** `=== "true"`: only the exact lowercase word turned it on. */
const exactTrue = words({ on: ["true"], off: ["false"], normalise: false });
/** On unless `false` / `0` / `off` (trimmed, any case). Any other value was on. */
const onUnlessOff = words({ on: [], off: ["false", "0", "off"], otherwise: true });

export interface FlagDefinition {
  /** One line, shown on the dashboard. */
  description: string;
  /** The environment variable that was the switch, and is now the default. */
  env: string;
  parseEnv: EnvParser;
  /**
   * With no row and no usable environment value. A function when the answer
   * depends on something else the process knows (see `bindFlagDefault`).
   */
  codeDefault: boolean | "bound";
  /** What `codeDefault` means, for the dashboard, when it is not a constant. */
  codeDefaultLabel?: string;
  /**
   * Whether a per-server override means anything. Only where every reader of
   * the flag knows the server it is answering for; a flag half of whose
   * readers cannot see a server would answer two things at once.
   */
  perServer: boolean;
  /** Reaches clients through a config endpoint (named here for the dashboard). */
  clientVia?: string;
}

/**
 * EVERY FLAG, IN ONE PLACE. Adding one is an entry here and a call to
 * `isEnabled` where the old env read was. The key is the environment variable
 * in lower case, so the two can always be found from each other.
 */
export const FEATURE_FLAGS = {
  watch_party_waitlist: {
    description:
      "Teaser e lista de espera de watch party onde a watch party está desligada.",
    env: "WATCH_PARTY_WAITLIST",
    parseEnv: words({ on: ["on", "true", "1"], off: ["off", "false", "0"] }),
    codeDefault: "bound",
    codeDefaultLabel: "segue LIVE_HLS_ENABLED (+ LiveKit e bucket)",
    perServer: true,
    clientVia: "GET /api/watch-party/waitlist (campaign)",
  },
  live_hls_camera: {
    description: "Transcode da câmera do apresentador (a PiP sobre o filme).",
    env: "LIVE_HLS_CAMERA",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
  },
  live_hls_camera_480: {
    description: "Câmera do apresentador em 480p (desligado: 360p).",
    env: "LIVE_HLS_CAMERA_480",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
    clientVia: "GET /api/live-hls/config (cameraHeight)",
  },
  live_hls_voice_track: {
    description: "Opção de voz separada do filme para o apresentador.",
    env: "LIVE_HLS_VOICE_TRACK",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/live-hls/config (voiceTrack)",
  },
  live_hls_mic_archive: {
    description: "Gravar o microfone do apresentador numa faixa à parte.",
    env: "LIVE_HLS_MIC_ARCHIVE",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/live-hls/config (micArchive)",
  },
  live_hls_reap_orphans: {
    description: "Parar egresses órfãos nas salas que este processo apresenta.",
    env: "LIVE_HLS_REAP_ORPHANS",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
  },
  hls_sharer_resume_hold: {
    description:
      "Segurar a transmissão enquanto o apresentador reconecta (desligado: 5 s de tolerância).",
    env: "HLS_SHARER_RESUME_HOLD",
    parseEnv: words({ on: [], off: ["off", "false", "0"], otherwise: true }),
    codeDefault: true,
    perServer: false,
  },
  livekit_region_require_cap: {
    description:
      "Só abrir sala fora de casa para quem declarou sfu-region (reversão).",
    env: "LIVEKIT_REGION_REQUIRE_CAP",
    parseEnv: words({ on: ["true", "1", "on"], off: ["false", "0", "off"] }),
    codeDefault: false,
    perServer: false,
  },
  sfu_region_scoped_calls: {
    description:
      "Moderação do SFU pergunta só à região da sala, com limite de tempo e disjuntor por região (desligado: pergunta a todas e espera 5 s).",
    env: "SFU_REGION_SCOPED_CALLS",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
  },
  voice_mesh_resume_requires_cap: {
    description:
      "Só segurar assento mesh por 90 s para quem declarou mesh-resume.",
    env: "VOICE_MESH_RESUME_REQUIRES_CAP",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
  },
  turn_prefer_static: {
    description: "Preferir o TURN estático ao Cloudflare/Metered (reversão).",
    env: "TURN_PREFER_STATIC",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/ice-servers",
  },
  read_cache: {
    description:
      "Cache curto de leituras repetidas no Postgres (desligado: toda leitura vai ao banco).",
    env: "READ_CACHE",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
  },
  ws_auth_admission: {
    description:
      "Fila na chegada dos sockets: uma rajada de reconexão (deploy) espera na porta do WebSocket, não no pool do Postgres (desligado: todos de uma vez).",
    env: "WS_AUTH_ADMISSION",
    parseEnv: onUnlessOff,
    codeDefault: true,
    perServer: false,
  },
  community_home: {
    description: "Baú (Community Home).",
    env: "COMMUNITY_HOME_ENABLED",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/community-home/config (enabled)",
  },
  party_newcomer_experience: {
    description:
      "Festa para quem chegou agora: chat garantido no celular, faixa que explica a sala, sem convite de app.",
    env: "PARTY_NEWCOMER_EXPERIENCE",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: true,
    clientVia: "GET /api/live-hls/config?serverId= (newcomerExperience)",
  },
  watch_party_server_audience: {
    description:
      "Contagem da festa feita pelo servidor: quem está assistindo agora, sem repetir conta, igual ao painel.",
    env: "WATCH_PARTY_SERVER_AUDIENCE",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: true,
    clientVia: "channel-live and GET /api/channels/:id/live (viewers)",
  },
  community_home_vip: {
    description: "Posts VIP do Baú (só vale com o Baú ligado).",
    env: "COMMUNITY_HOME_VIP_ENABLED",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/community-home/config (vipEnabled)",
  },
  community_home_translation: {
    description:
      "Tradução automática dos posts do Baú para quem lê em outro idioma.",
    env: "COMMUNITY_HOME_TRANSLATION",
    parseEnv: exactTrue,
    codeDefault: false,
    // Every reader knows the server: the feed read, the single-post read and
    // the background job all work from a post, and a post has a server.
    perServer: true,
    clientVia: "GET /api/servers/:id/home/posts (translationEnabled)",
  },
  desktop_share_audio_native: {
    description:
      "Som do compartilhamento de tela no app desktop do Windows por processo (Windows 10 incluso, sem a chamada).",
    env: "DESKTOP_SHARE_AUDIO_NATIVE",
    parseEnv: exactTrue,
    codeDefault: false,
    // The one reader is `GET /api/share/config`, which is asked with the
    // server the call is in; a DM call asks with none and gets the global.
    perServer: true,
    clientVia: "GET /api/share/config (desktopShareAudioNative)",
  },
  share_high_motion_guard: {
    description:
      "Compartilhamento de tela que aguenta jogo em taxa de quadros alta: o cliente mede o encoder e, se travar, baixa um degrau de resolução, depois a taxa de quadros; o app desktop sobe a prioridade dos processos enquanto compartilha.",
    env: "SHARE_HIGH_MOTION_GUARD",
    parseEnv: exactTrue,
    codeDefault: false,
    // Read by `GET /api/share/config`, which the client asks with the server
    // the call is in (a DM call asks with none and gets the global answer).
    perServer: true,
    clientVia: "GET /api/share/config (shareHighMotionGuard)",
  },
  share_fast_start_quality: {
    description:
      "Compartilhamento de tela nítido desde o começo: quem entra na call pede a camada do palco antes da assinatura (sem os primeiros segundos em 360p), e o compartilhamento não é republicado quando a sala passa de 20 pessoas (só o teto da camada de cima muda, sem a imagem sumir pra todo mundo).",
    env: "SHARE_FAST_START_QUALITY",
    parseEnv: exactTrue,
    codeDefault: false,
    // Read by `GET /api/share/config` with the call's server, like the guard:
    // the viewer's and the presenter's clients both ask with it.
    perServer: true,
    clientVia: "GET /api/share/config (shareFastStartQuality)",
  },
  share_game_capture_hint: {
    description:
      "Aviso de jogo em tela cheia exclusiva: no app desktop do Windows, se o compartilhamento chega preto, sem quadros ou cai sozinho enquanto o Windows diz que um jogo ocupa a tela, quem compartilha vê como trocar pra tela cheia em janela.",
    env: "SHARE_GAME_CAPTURE_HINT",
    parseEnv: exactTrue,
    codeDefault: false,
    // Read by `GET /api/share/config` with the call's server, like the guard.
    perServer: true,
    clientVia: "GET /api/share/config (shareGameCaptureHint)",
  },
  linux_desktop_system_audio: {
    description:
      "Som do computador no compartilhamento de tela do app desktop no Linux (sem a chamada; precisa de PulseAudio ou PipeWire).",
    env: "LINUX_DESKTOP_SYSTEM_AUDIO",
    parseEnv: exactTrue,
    codeDefault: false,
    // Global on purpose. The client's three readers
    // (`lib/linux-shell-share-audio.ts`, the call-stage hint, `use-voice`) ask
    // `GET /api/share/config` without a server and keep one answer for the
    // whole page, so a per-server override would be accepted by the dashboard
    // and never read: a switch that looks on and does nothing. Make it
    // per-server together with a client that asks with the call's server.
    perServer: false,
    clientVia: "GET /api/share/config (linuxDesktopSystemAudio)",
  },
  party_fast_start: {
    description:
      "Primeiro quadro mais rápido no watch party (só cliente: pré-carrega o player, adia a animação de espera e mostra o andamento).",
    env: "PARTY_FAST_START",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: true,
    clientVia: "GET /api/live-hls/config (fastStart)",
  },
  watch_camera_sync: {
    description:
      "Câmera de quem apresenta no compasso do filme (só cliente: o player da câmera acompanha o relógio do filme, com até 5 % de velocidade ou um salto; o filme nunca é mexido).",
    env: "WATCH_CAMERA_SYNC",
    parseEnv: exactTrue,
    // Off until it has been checked by hand on a real party: measured on the
    // real player (the PR that added it has the numbers), but turned on one
    // server at a time from the dashboard, then globally.
    codeDefault: false,
    // The only reader is `GET /api/live-hls/config?serverId=`, which knows
    // the server; the deployment-wide answer is the global value.
    perServer: true,
    clientVia: "GET /api/live-hls/config (cameraSync)",
  },
  audience_mode: {
    description:
      "Modo plateia nas calls: quem modera liga com um toque e só a staff e quem ela liberar falam; o resto vê o motivo no microfone e pede a palavra levantando a mão.",
    env: "AUDIENCE_MODE",
    parseEnv: exactTrue,
    // Off until it has been run on a real call: one server first (its
    // override), then everybody. See docs/plans/AUDIENCE_MODE.md.
    codeDefault: false,
    // Every reader knows the server: the client asks
    // `GET /api/voice/config?serverId=` with the call's server, and the
    // server side reads it per room with the channel's server in hand. Off
    // for a server also switches off a session already running there (the
    // sweep in ws/voice.ts), so this is the kill switch as well.
    perServer: true,
    clientVia: "GET /api/voice/config?serverId= (audienceMode)",
  },
  watch_now_banner: {
    description:
      "Faixa \"Assistir\" (só cliente: quem está num canal de texto vê que alguém compartilha a tela ou que uma watch party está no ar, e entra com um toque, sem microfone).",
    env: "WATCH_NOW_BANNER",
    parseEnv: exactTrue,
    // Off so it can go on for one server first, then globally. The banner is
    // derived on the client from frames it already holds, so there is nothing
    // else to switch.
    codeDefault: false,
    // The only reader is `GET /api/live-hls/config?serverId=`, which knows the
    // server; the deployment-wide answer (what a DM reads) is the global value.
    perServer: true,
    clientVia: "GET /api/live-hls/config?serverId= (watchNowBanner)",
  },
  stream_start_notifications: {
    description:
      "Aviso de início de transmissão (quando alguém começa a compartilhar a tela ou uma watch party entra no ar, avisa quem pediu, com limites: servidor pequeno por padrão, 20 s de estabilidade, 1 aviso por canal a cada 30 min).",
    env: "STREAM_START_NOTIFICATIONS",
    parseEnv: exactTrue,
    // Off: this is the one that can interrupt people, so it is separate from
    // the banner and turned on one server at a time. Large servers and
    // communities notify nobody by default even with it on.
    codeDefault: false,
    // The decision runs where the share starts and knows the channel, so the
    // server is always in hand; the client reads it per server too.
    perServer: true,
    clientVia: "GET /api/live-hls/config?serverId= (streamStartNotifications)",
  },
  desktop_notify_default_on: {
    description:
      "Notificações padrão (só cliente: no app desktop o banner do sistema já vem ligado, DMs e servidores têm níveis padrão separados, e o servidor fica em só menções; no navegador, depois da primeira DM ou menção com a aba escondida, aparece um cartão único pra ativar).",
    env: "DESKTOP_NOTIFY_DEFAULT_ON",
    parseEnv: exactTrue,
    // Off until it has been checked on a real desktop build: turning it on
    // changes what banners an account that never opened the settings gets.
    codeDefault: false,
    // `GET /api/push/config` has no server in hand and the client keeps one
    // answer per page: a per-server override would never be read.
    perServer: false,
    clientVia: "GET /api/push/config (desktopNotifyDefaultOn)",
  },
  voice_notes: {
    description:
      "Mensagens de voz: segurar o microfone no chat grava e manda um áudio com a duração e a onda, como no WhatsApp.",
    env: "VOICE_NOTES",
    parseEnv: exactTrue,
    // Off until the recorder has been used on a real server: one server
    // first (its override), then everybody. See the voice notes plan.
    codeDefault: false,
    // Every reader knows the server: the mint checks the channel's server
    // (a conversation reads the global value), and the client asks
    // `GET /api/attachments/config?serverId=` with the server it is in.
    // Off also stops new notes being minted, so it is the kill switch; notes
    // already sent stay readable.
    perServer: true,
    clientVia: "GET /api/attachments/config?serverId= (voiceNotes)",
  },
  voice_note_transcription: {
    description:
      "Transcrição de mensagens de voz: o texto aparece embaixo do áudio. Em conversa sai na hora; em canal de servidor só quando alguém pede.",
    env: "VOICE_NOTE_TRANSCRIPTION",
    parseEnv: exactTrue,
    // Off: it sends audio to a third party (Cloudflare Workers AI) and costs
    // money per minute. One server first, then everybody.
    codeDefault: false,
    // Every reader knows the note, and so its channel's server: the enqueue at
    // send, the worker before it calls the provider (a flip mid-queue costs
    // nothing), the lazy request route and every read. A conversation reads
    // the global value. Off also HIDES stored transcripts on read, so it is a
    // real kill switch and not just "stop making new ones".
    perServer: true,
    // Served as `voiceTranscription` on `GET /api/attachments/config?serverId=`,
    // but no client reads it yet, so no `clientVia`: the contract test
    // (`flag-client-contract.test.ts`) would rightly fail a field nobody
    // reads. The client PR that reads it adds the line back.
  },
  push_attention_gate: {
    description:
      "Push pelo que a pessoa está olhando: o celular recebe a notificação a menos que um app ou aba esteja na frente dela e ativo. Desligado, qualquer conexão aberta em qualquer lugar (uma aba esquecida, o desktop minimizado) cala o celular.",
    env: "PUSH_ATTENTION_GATE",
    parseEnv: exactTrue,
    // Off until the clients that report attention are out (web and desktop
    // first) and `pushSkipped` / `pushAttentionPassed` have been read on a
    // real day. A socket that never reports it counts as foreground unless
    // idle, so turning this on cannot double-notify an old build.
    codeDefault: false,
    // Global: the decision is about a person's sockets, not about a server,
    // and the call and DM paths have no server at all.
    perServer: false,
  },
  client_force_update: {
    description:
      "Forçar atualização: todo cliente web ou desktop fora do último build vê a tela \"atualização necessária\" (não aparece durante uma chamada). Ligue só enquanto o build bom estiver no ar.",
    env: "CLIENT_FORCE_UPDATE",
    parseEnv: exactTrue,
    codeDefault: false,
    perServer: false,
    clientVia: "GET /api/client-update/config (forceUpdate)",
  },
  mention_ids_from_db: {
    description:
      "Menção de cargo (@cargo) avisa de verdade: o selo ao vivo e o push usam as pessoas que a mensagem registrou, não só o @usuário digitado (desligado: só quem foi citado pelo nome recebe).",
    env: "MENTION_IDS_FROM_DB",
    parseEnv: exactTrue,
    // Off until a role mention has been seen to notify on a real server.
    codeDefault: false,
    // Read once per send, on the instance that took it, where the server is
    // known but a conversation has no roles: global on purpose.
    perServer: false,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as [
  FlagKey,
  ...FlagKey[],
];

function definitionOf(key: FlagKey): FlagDefinition {
  return FEATURE_FLAGS[key];
}

/**
 * A default that depends on another part of the process. Bound by the module
 * that owns that part, at import, so this file imports nothing heavy (the
 * waitlist's default is "whatever `isLiveHlsEnabled` says", and `voice/`
 * importing this file must not make this file import `voice/`). Unbound, the
 * default is off, which is the safe answer for anything that advertises.
 */
const boundDefaults = new Map<FlagKey, () => boolean>();

export function bindFlagDefault(key: FlagKey, resolve: () => boolean): void {
  boundDefaults.set(key, resolve);
}

function codeDefaultOf(key: FlagKey): boolean {
  const def = definitionOf(key);
  if (def.codeDefault === "bound") {
    return boundDefaults.get(key)?.() ?? false;
  }
  return def.codeDefault;
}

/** What the environment says, or null when it says nothing usable. */
function envDecision(key: FlagKey): boolean | null {
  const def = definitionOf(key);
  return def.parseEnv(process.env[def.env]);
}

// ----------------------------------------------------------------- snapshot

interface Snapshot {
  global: Map<string, boolean>;
  /** key -> serverId -> enabled */
  servers: Map<string, Map<string, boolean>>;
}

export const FLAGS_BUS_TOPIC = "flags.changed";
const DEFAULT_TTL_MS = 10_000;

function ttlMs(): number {
  const raw = Number(process.env.FEATURE_FLAGS_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

let started = false;
let snapshot: Snapshot | null = null;
/** Bumped by every invalidation. A load is fresh only if it began after it. */
let wantedGeneration = 0;
let loadedGeneration = -1;
let loadedAt = 0;
/** After a failed load, reads leave the database alone until this time. */
let retryAfter = 0;
let inflight: Promise<boolean> | null = null;
let lastFailureLoggedAt = 0;
/**
 * The newest `feature_flag_audit.id` the snapshot reflects. Every write this
 * module makes adds an audit row in the same transaction, so a TTL check is
 * one index-only `MAX(id)` and the full reload (every override row) only
 * happens when that number moved, when a sibling said so on the bus, or once
 * per `FULL_RELOAD_MS` as a backstop for rows written by hand in SQL.
 */
let loadedVersion: string | null = null;
let fullLoadedAt = 0;
const FULL_RELOAD_MS = 5 * 60_000;

const stats = {
  loads: 0,
  /** TTL checks that found nothing new and skipped the full reload. */
  unchangedChecks: 0,
  loadFailures: 0,
  busInvalidations: 0,
  /** Writes this process took that changed something. */
  flips: 0,
  lastLoadError: null as string | null,
};

async function currentVersion(): Promise<string> {
  const { rows } = await getPool().query<{ version: string }>(
    `SELECT COALESCE(MAX(id), 0)::text AS version FROM feature_flag_audit`,
  );
  return rows[0]?.version ?? "0";
}

async function loadSnapshot(): Promise<Snapshot> {
  const { rows } = await getPool().query<{
    key: string;
    server_id: string | null;
    enabled: boolean;
  }>(
    `SELECT key, NULL::uuid AS server_id, enabled
       FROM feature_flags WHERE enabled IS NOT NULL
     UNION ALL
     SELECT key, server_id, enabled FROM feature_flag_overrides`,
  );
  const next: Snapshot = { global: new Map(), servers: new Map() };
  for (const row of rows) {
    // A row for a flag this build does not know is ignored, not an error: a
    // flag removed from the registry leaves its row behind harmlessly.
    if (!(row.key in FEATURE_FLAGS)) {
      continue;
    }
    if (row.server_id === null) {
      next.global.set(row.key, row.enabled);
      continue;
    }
    let perServer = next.servers.get(row.key);
    if (!perServer) {
      perServer = new Map();
      next.servers.set(row.key, perServer);
    }
    perServer.set(row.server_id, row.enabled);
  }
  return next;
}

/**
 * One load at a time. A load that began before an invalidation cannot count
 * as fresh (it may have read before the write committed), so when it lands
 * behind one, another is started straight away.
 */
function refresh(): Promise<boolean> {
  if (inflight) {
    return inflight;
  }
  const generation = wantedGeneration;
  // An invalidation (a write here, a frame from a sibling) always reloads in
  // full. A plain TTL expiry asks for the version first.
  const invalidated = loadedGeneration < generation || snapshot === null;
  const attempt = (async () => {
    const version = await currentVersion();
    const backstopDue = Date.now() - fullLoadedAt >= FULL_RELOAD_MS;
    if (!invalidated && !backstopDue && version === loadedVersion) {
      stats.unchangedChecks += 1;
      return null;
    }
    // Version read BEFORE the rows: a write landing in between leaves the
    // version behind the rows, which costs one extra reload, never a miss.
    return { version, next: await loadSnapshot() };
  })().then(
    (loaded) => {
      if (loaded) {
        snapshot = loaded.next;
        loadedVersion = loaded.version;
        fullLoadedAt = Date.now();
        stats.loads += 1;
      }
      loadedGeneration = generation;
      loadedAt = Date.now();
      retryAfter = 0;
      stats.lastLoadError = null;
      return true;
    },
    (error: unknown) => {
      stats.loadFailures += 1;
      stats.lastLoadError = error instanceof Error ? error.message : String(error);
      retryAfter = Date.now() + Math.max(ttlMs(), 1_000);
      // One line per minute at most: during an outage every read would
      // otherwise log, and the outage is already loud elsewhere.
      if (Date.now() - lastFailureLoggedAt > 60_000) {
        lastFailureLoggedAt = Date.now();
        logEvent("flags.loadFailed", {
          error: stats.lastLoadError,
          keepingSnapshot: snapshot !== null,
        });
      }
      return false;
    },
  );
  inflight = attempt.finally(() => {
    inflight = null;
  });
  return inflight.then((ok) => {
    if (ok && loadedGeneration < wantedGeneration && started) {
      void refresh();
    }
    return ok;
  });
}

function maybeRefresh(): void {
  if (!started || inflight) {
    return;
  }
  const now = Date.now();
  if (now < retryAfter) {
    return;
  }
  if (loadedGeneration >= wantedGeneration && now - loadedAt < ttlMs()) {
    return;
  }
  void refresh();
}

/**
 * Forget the snapshot's freshness and reload until a load that began after
 * this call has landed. Resolves false when the database would not answer
 * (the old snapshot stays in place).
 */
export async function reloadFeatureFlags(): Promise<boolean> {
  wantedGeneration += 1;
  const target = wantedGeneration;
  retryAfter = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ok = await refresh();
    if (!ok) {
      return false;
    }
    if (loadedGeneration >= target) {
      return true;
    }
  }
  return loadedGeneration >= target;
}

// A sibling wrote. Subscribed at import, like chat.ts: subscriptions outlive
// the transport being installed later at boot.
subscribeToCluster(FLAGS_BUS_TOPIC, () => {
  stats.busInvalidations += 1;
  wantedGeneration += 1;
  retryAfter = 0;
  if (started) {
    void refresh();
  }
});

/**
 * Boot: load once and start consulting the database. Called after `initDb`
 * by the API and by the worker. A failed first load is not fatal: the
 * process answers from the environment until a later read gets through.
 */
export async function startFeatureFlags(): Promise<void> {
  started = true;
  const ok = await refresh();
  logEvent("flags.started", {
    loaded: ok,
    ttlMs: ttlMs(),
    bus: isBusEnabled(),
  });
}

/** Test seam: back to "never started", nothing cached, counters at zero. */
export function resetFeatureFlagsForTests(): void {
  started = false;
  snapshot = null;
  wantedGeneration = 0;
  loadedGeneration = -1;
  loadedAt = 0;
  retryAfter = 0;
  inflight = null;
  loadedVersion = null;
  fullLoadedAt = 0;
  stats.loads = 0;
  stats.unchangedChecks = 0;
  stats.loadFailures = 0;
  stats.busInvalidations = 0;
  stats.flips = 0;
  stats.lastLoadError = null;
}

// -------------------------------------------------------------------- reads

export type FlagSource = "server" | "global" | "env" | "default";

export interface FlagResolution {
  value: boolean;
  source: FlagSource;
}

export function resolveFlag(
  key: FlagKey,
  options: { serverId?: string | null } = {},
): FlagResolution {
  maybeRefresh();
  const current = snapshot;
  if (current) {
    if (options.serverId && definitionOf(key).perServer) {
      const override = current.servers.get(key)?.get(options.serverId);
      if (override !== undefined) {
        return { value: override, source: "server" };
      }
    }
    const global = current.global.get(key);
    if (global !== undefined) {
      return { value: global, source: "global" };
    }
  }
  const fromEnv = envDecision(key);
  if (fromEnv !== null) {
    return { value: fromEnv, source: "env" };
  }
  return { value: codeDefaultOf(key), source: "default" };
}

/**
 * THE read. Synchronous, and cheap enough for a hot path. `serverId` only
 * matters for a flag whose registry entry allows per-server overrides.
 */
export function isEnabled(
  key: FlagKey,
  options: { serverId?: string | null } = {},
): boolean {
  return resolveFlag(key, options).value;
}

/**
 * The servers that carry a per-server decision for `key`, from the snapshot
 * (empty before it loads). For a background job that has to find the work for
 * a per-server flag without asking `isEnabled` once per candidate: with the
 * global answer off it only needs the servers overridden ON, and with it on, all
 * but the servers overridden OFF.
 */
export function flagServerOverrides(key: FlagKey): Map<string, boolean> {
  maybeRefresh();
  return new Map(snapshot?.servers.get(key) ?? []);
}

// ------------------------------------------------------------------- writes

export type FlagActor =
  | { kind: "dashboard" }
  | { kind: "moderator"; userId: string };

export const ADMIN_FLAGS_PATH = "/api/admin/flags";
export const ADMIN_FLAG_OVERRIDE_PATH = "/api/admin/flag-overrides";

export const setFeatureFlagSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
  /** `true` / `false` decide; `null` hands the answer back to the environment. */
  enabled: z.boolean().nullable(),
});

export const setFeatureFlagOverrideSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
  serverId: z.string().uuid(),
  /** `null` removes the override, so the global answer applies again. */
  enabled: z.boolean().nullable(),
});

function actorId(actor: FlagActor): string | null {
  return actor.kind === "moderator" ? actor.userId : null;
}

/**
 * After a write commits: this process reloads before the request answers, and
 * then tells its siblings. Publishing AFTER the commit is the ordering that
 * matters: a sibling that reloads on the frame must read the new row. The
 * frame goes out even when the local reload failed: the siblings' databases
 * connections are their own. Returns whether THIS process now answers with
 * the new row.
 */
async function afterWrite(key: FlagKey, serverId: string | null): Promise<boolean> {
  stats.flips += 1;
  const applied = await reloadFeatureFlags();
  publishToCluster(FLAGS_BUS_TOPIC, { key, serverId });
  return applied;
}

/**
 * ONE FLAG WRITER AT A TIME, for the whole table, held until COMMIT.
 *
 * Two reasons, and the second is why it is not per key. `SELECT ... FOR
 * UPDATE` locks nothing when the row does not exist yet, so two first writes
 * to one key would both read "no decision" and audit the wrong `previous`.
 * And the TTL check trusts `MAX(feature_flag_audit.id)` as a version: with
 * two writers overlapping, the one holding the LOWER id could commit after a
 * sibling had already read the higher one, and that change would be missed
 * until the backstop. With every flag transaction serialised, ids commit in
 * order and the version only ever moves forward. Operator writes are a few a
 * day; the lock costs nothing that matters.
 */
async function lockFlagWrites(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('feature_flags'))`);
}

/**
 * What a write answers. The row is already committed when this runs, so a
 * failed follow-up read must not turn the answer into an error: it falls back
 * to the snapshot (server names and the audit are what go missing). `applied`
 * is false when this process could not reload, which the dashboard says out
 * loud rather than showing the old value as if the click had not taken.
 */
export type FeatureFlagWriteResult = FeatureFlagView & {
  applied: boolean;
  changed: boolean;
};

async function writeResult(
  key: FlagKey,
  applied: boolean,
  changed: boolean,
): Promise<FeatureFlagWriteResult> {
  let view: FeatureFlagView | undefined;
  try {
    view = (await listFeatureFlags({ reload: false })).flags.find(
      (flag) => flag.key === key,
    );
  } catch (error) {
    logEvent("flags.writeViewFailed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...(view ?? snapshotView(key)), applied, changed };
}

/** A view built from this process's snapshot alone, for when the DB is not answering. */
function snapshotView(key: FlagKey): FeatureFlagView {
  const def = definitionOf(key);
  const envValue = envDecision(key);
  const codeDefault = codeDefaultOf(key);
  const resolved = resolveFlag(key);
  const global = snapshot?.global.get(key);
  return {
    key,
    description: def.description,
    env: def.env,
    envSet: envValue !== null,
    envValue,
    codeDefault,
    codeDefaultLabel: def.codeDefaultLabel ?? null,
    envDefault: envValue ?? codeDefault,
    perServer: def.perServer,
    clientVia: def.clientVia ?? null,
    stored:
      global === undefined ? null : { enabled: global, updatedAt: "", updatedBy: null },
    effective: resolved.value,
    source: resolved.source === "server" ? "global" : resolved.source,
    overrides: [...(snapshot?.servers.get(key) ?? new Map<string, boolean>())].map(
      ([serverId, enabled]) => ({
        serverId,
        serverName: null,
        enabled,
        updatedAt: "",
        updatedBy: null,
      }),
    ),
  };
}

export async function setGlobalFlag(
  key: FlagKey,
  enabled: boolean | null,
  actor: FlagActor,
): Promise<FeatureFlagWriteResult> {
  const client = await getPool().connect();
  let changed = false;
  try {
    await client.query("BEGIN");
    await lockFlagWrites(client);
    const previous = await client.query<{ enabled: boolean | null }>(
      `SELECT enabled FROM feature_flags WHERE key = $1 FOR UPDATE`,
      [key],
    );
    const before = previous.rows[0]?.enabled ?? null;
    changed = before !== enabled;
    if (changed) {
      await client.query(
        `INSERT INTO feature_flags (key, enabled, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by`,
        [key, enabled, actorId(actor)],
      );
      await client.query(
        `INSERT INTO feature_flag_audit
           (key, server_id, previous, next, actor_kind, actor_id)
         VALUES ($1, NULL, $2, $3, $4, $5)`,
        [key, before, enabled, actor.kind, actorId(actor)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  let applied = true;
  if (changed) {
    logEvent("flags.set", { key, enabled, actor: actor.kind });
    applied = await afterWrite(key, null);
  }
  return writeResult(key, applied, changed);
}

export async function setServerFlagOverride(
  key: FlagKey,
  serverId: string,
  enabled: boolean | null,
  actor: FlagActor,
): Promise<FeatureFlagWriteResult> {
  if (!definitionOf(key).perServer) {
    throw new HttpError(400, `${key} has no per-server overrides`);
  }
  const client = await getPool().connect();
  let changed = false;
  try {
    await client.query("BEGIN");
    await lockFlagWrites(client);
    const server = await client.query(`SELECT 1 FROM servers WHERE id = $1`, [
      serverId,
    ]);
    if (server.rowCount === 0) {
      throw new HttpError(404, "Server not found");
    }
    const previous = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flag_overrides
        WHERE key = $1 AND server_id = $2 FOR UPDATE`,
      [key, serverId],
    );
    const before = previous.rows[0]?.enabled ?? null;
    changed = before !== enabled;
    if (changed) {
      if (enabled === null) {
        await client.query(
          `DELETE FROM feature_flag_overrides WHERE key = $1 AND server_id = $2`,
          [key, serverId],
        );
      } else {
        await client.query(
          `INSERT INTO feature_flag_overrides
             (key, server_id, enabled, updated_at, updated_by)
           VALUES ($1, $2, $3, NOW(), $4)
           ON CONFLICT (key, server_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 updated_at = EXCLUDED.updated_at,
                 updated_by = EXCLUDED.updated_by`,
          [key, serverId, enabled, actorId(actor)],
        );
      }
      await client.query(
        `INSERT INTO feature_flag_audit
           (key, server_id, previous, next, actor_kind, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [key, serverId, before, enabled, actor.kind, actorId(actor)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  let applied = true;
  if (changed) {
    logEvent("flags.override", { key, serverId, enabled, actor: actor.kind });
    applied = await afterWrite(key, serverId);
  }
  return writeResult(key, applied, changed);
}

// ------------------------------------------------------------ operator view

export interface FeatureFlagOverrideView {
  serverId: string;
  serverName: string | null;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FeatureFlagView {
  key: FlagKey;
  description: string;
  env: string;
  /** Whether the variable is set to something its reader understands. */
  envSet: boolean;
  /** What the variable says, or null when it says nothing. */
  envValue: boolean | null;
  /** The answer with no row and no variable. */
  codeDefault: boolean;
  codeDefaultLabel: string | null;
  /** What the environment alone would answer: `envValue ?? codeDefault`. */
  envDefault: boolean;
  perServer: boolean;
  clientVia: string | null;
  /** The global row, when one exists with a decision in it. */
  stored: { enabled: boolean; updatedAt: string; updatedBy: string | null } | null;
  /** What this process answers for a caller with no server override. */
  effective: boolean;
  source: Exclude<FlagSource, "server">;
  overrides: FeatureFlagOverrideView[];
}

export interface FeatureFlagAuditEntry {
  key: string;
  serverId: string | null;
  serverName: string | null;
  previous: boolean | null;
  next: boolean | null;
  actorKind: "dashboard" | "moderator";
  actorName: string | null;
  at: string;
}

export interface FeatureFlagList {
  flags: FeatureFlagView[];
  audit: FeatureFlagAuditEntry[];
  cache: FeatureFlagCacheStats;
}

export interface FeatureFlagCacheStats {
  started: boolean;
  ttlMs: number;
  bus: boolean;
  /** Milliseconds since the snapshot was last confirmed current; null when it never loaded. */
  ageMs: number | null;
  /** Full reloads (every row). */
  loads: number;
  /** TTL checks where the audit version had not moved, so nothing was reloaded. */
  unchangedChecks: number;
  loadFailures: number;
  busInvalidations: number;
  lastLoadError: string | null;
}

export function featureFlagCacheStats(): FeatureFlagCacheStats {
  return {
    started,
    ttlMs: ttlMs(),
    bus: isBusEnabled(),
    ageMs: snapshot ? Date.now() - loadedAt : null,
    loads: stats.loads,
    unchangedChecks: stats.unchangedChecks,
    loadFailures: stats.loadFailures,
    busInvalidations: stats.busInvalidations,
    lastLoadError: stats.lastLoadError,
  };
}

const AUDIT_LIMIT = 50;

/**
 * Everything the dashboard's "flags" section draws. Reads the rows straight
 * from Postgres (the operator must see the truth, not this replica's cache)
 * and reloads the snapshot on the way, so `effective` agrees with them.
 */
export async function listFeatureFlags(
  { reload = true }: { reload?: boolean } = {},
): Promise<FeatureFlagList> {
  if (reload) {
    await reloadFeatureFlags();
  }
  const pool = getPool();
  const [globals, overrides, audit] = await Promise.all([
    pool.query<{
      key: string;
      enabled: boolean | null;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT f.key, f.enabled, f.updated_at, u.display_name AS updated_by
         FROM feature_flags f LEFT JOIN users u ON u.id = f.updated_by`,
    ),
    pool.query<{
      key: string;
      server_id: string;
      server_name: string | null;
      enabled: boolean;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT o.key, o.server_id, s.name AS server_name, o.enabled, o.updated_at,
              u.display_name AS updated_by
         FROM feature_flag_overrides o
         LEFT JOIN servers s ON s.id = o.server_id
         LEFT JOIN users u ON u.id = o.updated_by
        ORDER BY o.updated_at DESC`,
    ),
    pool.query<{
      key: string;
      server_id: string | null;
      server_name: string | null;
      previous: boolean | null;
      next: boolean | null;
      actor_kind: "dashboard" | "moderator";
      actor_name: string | null;
      created_at: Date;
    }>(
      `SELECT a.key, a.server_id, s.name AS server_name, a.previous, a.next,
              a.actor_kind, u.display_name AS actor_name, a.created_at
         FROM feature_flag_audit a
         LEFT JOIN servers s ON s.id = a.server_id
         LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${AUDIT_LIMIT}`,
    ),
  ]);
  const globalByKey = new Map(globals.rows.map((row) => [row.key, row]));
  const flags = FEATURE_FLAG_KEYS.map((key): FeatureFlagView => {
    const def = definitionOf(key);
    const envValue = envDecision(key);
    const codeDefault = codeDefaultOf(key);
    const row = globalByKey.get(key);
    const resolved = resolveFlag(key);
    return {
      key,
      description: def.description,
      env: def.env,
      envSet: envValue !== null,
      envValue,
      codeDefault,
      codeDefaultLabel: def.codeDefaultLabel ?? null,
      envDefault: envValue ?? codeDefault,
      perServer: def.perServer,
      clientVia: def.clientVia ?? null,
      stored:
        row && row.enabled !== null
          ? {
              enabled: row.enabled,
              updatedAt: row.updated_at.toISOString(),
              updatedBy: row.updated_by,
            }
          : null,
      effective: resolved.value,
      source: resolved.source === "server" ? "global" : resolved.source,
      overrides: overrides.rows
        .filter((override) => override.key === key)
        .map((override) => ({
          serverId: override.server_id,
          serverName: override.server_name,
          enabled: override.enabled,
          updatedAt: override.updated_at.toISOString(),
          updatedBy: override.updated_by,
        })),
    };
  });
  return {
    flags,
    audit: audit.rows.map((row) => ({
      key: row.key,
      serverId: row.server_id,
      serverName: row.server_name,
      previous: row.previous,
      next: row.next,
      actorKind: row.actor_kind,
      actorName: row.actor_name,
      at: row.created_at.toISOString(),
    })),
    cache: featureFlagCacheStats(),
  };
}

// ------------------------------------------------------------------ metrics

export interface FeatureFlagMetrics {
  /** Every flag's answer on this process, for a caller with no server. */
  values: Record<
    string,
    { effective: boolean; source: Exclude<FlagSource, "server">; serverOverrides: number }
  >;
  /** Writes that changed something, taken by THIS process since it booted. */
  flipsSinceBoot: number;
  /** Cluster-wide, from the audit trail. Null when that read failed. */
  flips24h: number | null;
  flips24hByKey: Record<string, number> | null;
  lastFlipAt: string | null;
  cache: FeatureFlagCacheStats;
}

/**
 * For `GET /api/admin/metrics`. Answers from the snapshot without forcing a
 * reload, and never throws: a metrics endpoint must not 500 over decoration.
 */
export async function featureFlagMetrics(): Promise<FeatureFlagMetrics> {
  const values: FeatureFlagMetrics["values"] = {};
  for (const key of FEATURE_FLAG_KEYS) {
    const resolved = resolveFlag(key);
    values[key] = {
      effective: resolved.value,
      source: resolved.source === "server" ? "global" : resolved.source,
      serverOverrides: snapshot?.servers.get(key)?.size ?? 0,
    };
  }
  let flips24h: number | null = null;
  let flips24hByKey: Record<string, number> | null = null;
  let lastFlipAt: string | null = null;
  try {
    // Both bounded by `idx_feature_flag_audit_created`: the window scan
    // touches one day of rows, and the newest flip is one index probe.
    const pool = getPool();
    const [window, last] = await Promise.all([
      pool.query<{ key: string; flips: string }>(
        `SELECT key, COUNT(*)::text AS flips
           FROM feature_flag_audit
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY key`,
      ),
      pool.query<{ created_at: Date }>(
        `SELECT created_at FROM feature_flag_audit ORDER BY created_at DESC LIMIT 1`,
      ),
    ]);
    flips24h = 0;
    flips24hByKey = {};
    for (const row of window.rows) {
      const count = Number(row.flips);
      flips24h += count;
      flips24hByKey[row.key] = count;
    }
    lastFlipAt = last.rows[0]?.created_at.toISOString() ?? null;
  } catch {
    // Decoration. The values above are still right.
  }
  return {
    values,
    flipsSinceBoot: stats.flips,
    flips24h,
    flips24hByKey,
    lastFlipAt,
    cache: featureFlagCacheStats(),
  };
}
