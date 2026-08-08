/**
 * A pqp client that speaks the real protocol.
 *
 * Not a mock and not a shortcut: HTTP with a Bearer token for everything that
 * has a route, and the `/ws` socket for everything that does not — messages,
 * typing, reactions. That matters more than it sounds. A runner that inserted
 * rows into Postgres directly would produce servers that look alive in the
 * database and dead in every open client, because none of the fan-out that
 * makes a channel feel live happens below `ws/chat.ts`. Going through the wire
 * also means this runner is an end-to-end exercise of the protocol every real
 * client uses — bugs it hits are bugs users would have hit.
 *
 * The identity story here is DEV_AUTH_BYPASS, which is local-only by design
 * (`server/src/auth/clerk.ts` refuses it under NODE_ENV=production). See §1 of
 * the design doc for the three production options and which one to build.
 */

const AUTH_TIMEOUT_MS = 15_000;

export class PqpApi {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  /**
   * One API call, waiting out a 429 rather than failing on it.
   *
   * The server rate-limits *writes* per user (`writeLimiter` in
   * `api/index.ts`), and the seed script legitimately makes twenty-five channel
   * writes in a row — so a run that creates the launch communities hits the
   * ceiling every time and used to die halfway through a server, leaving it
   * with three of its five channels. That is a script problem, not a server
   * problem: the limit is correct and the fix is to respect it.
   *
   * `Retry-After` is what the server actually sends, so it is what is honoured;
   * the fallback exists only for a proxy that strips it. Bounded, because an
   * operator script that hangs forever on a misconfigured deploy is worse than
   * one that reports the 429.
   */
  async call(path, { method = "GET", body, retries = 4 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (response.ok) {
        return text ? JSON.parse(text) : null;
      }
      if (response.status === 429 && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep((Number.isFinite(after) && after > 0 ? after : 2) * 1000);
        continue;
      }
      throw new Error(`${method} ${path} → ${response.status} ${text}`);
    }
  }

  /**
   * Clear the 18+ gate for this account.
   *
   * Not optional and not skippable: `resolveAuthUser` refuses a pending
   * account, so the WebSocket handshake closes 4401 and every API call 403s
   * until this has run once. A brand-new dev-bypass account is pending, which
   * is why this is the first thing a persona does and not an afterthought.
   * The gate allows exactly one answer per account — a second call 409s, which
   * is treated as success because it means the account already answered.
   */
  async ensureAgeGate(dateOfBirth = "1994-03-11") {
    const me = await this.call("/api/me");
    if (me.ageGate === "passed") {
      return me;
    }
    if (me.ageGate === "blocked") {
      throw new Error(
        "This account is age-blocked and cannot be used for a persona.",
      );
    }
    try {
      await this.call("/api/me/age-check", {
        method: "POST",
        body: { dateOfBirth },
      });
    } catch (error) {
      if (!String(error.message).includes("409")) {
        throw error;
      }
    }
    return this.call("/api/me");
  }

  async setProfile({ displayName }) {
    return this.call("/api/me", { method: "PATCH", body: { displayName } });
  }

  async createServer(name) {
    return this.call("/api/servers", { method: "POST", body: { name } });
  }

  async listServers() {
    return (await this.call("/api/servers")).servers;
  }

  async listChannels(serverId) {
    return (await this.call(`/api/servers/${serverId}/channels`)).channels;
  }

  async createChannel(serverId, name, type = "text") {
    const result = await this.call(`/api/servers/${serverId}/channels`, {
      method: "POST",
      body: { name, type },
    });
    return result.channel ?? result;
  }

  async updateChannel(channelId, patch) {
    const result = await this.call(`/api/channels/${channelId}`, {
      method: "PATCH",
      body: patch,
    });
    return result.channel ?? result;
  }

  async listInvites(serverId) {
    return (await this.call(`/api/servers/${serverId}/invites`)).invites ?? [];
  }

  async createInvite(serverId) {
    const result = await this.call(`/api/servers/${serverId}/invites`, {
      method: "POST",
      body: {},
    });
    return (result.invite ?? result).code;
  }

  /**
   * A permanent invite for this server, reusing one if it already has a
   * never-expiring, never-exhausted code.
   *
   * Minting a fresh invite on every seed run would leave a pile of live codes
   * behind, each of which is a working door into a public-facing server that
   * nobody is tracking.
   */
  async ensureInvite(serverId) {
    const existing = (await this.listInvites(serverId)).find(
      (invite) => !invite.expiresAt && !invite.maxUses,
    );
    return existing?.code ?? (await this.createInvite(serverId));
  }

  async pinMessage(messageId) {
    return this.call(`/api/messages/${messageId}/pin`, { method: "POST" });
  }

  async listPins(channelId) {
    return (await this.call(`/api/channels/${channelId}/pins`)).messages ?? [];
  }

  async joinInvite(code) {
    return this.call(`/api/invites/${code}/join`, { method: "POST" });
  }
}

/**
 * One persona's live socket.
 *
 * Deliberately thin — auth, join, typing, send, react, and a listener for
 * inbound broadcasts. The reconnect-with-backoff that `client/src/lib/realtime.ts`
 * grew (see pitfall #9 in CLAUDE.md) is *not* here: a persona whose socket drops
 * should go quiet and be re-cast on the next scene, which is both simpler and a
 * better imitation of a person who closed the tab.
 */
export class PqpSocket {
  #socket = null;
  #handlers = new Set();

  constructor({ wsUrl, token, label }) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.label = label;
    this.channelId = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.#socket = socket;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error(`${this.label}: socket never became ready`));
        }
      }, AUTH_TIMEOUT_MS);

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "auth", token: this.token }));
      };

      socket.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === "ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
          return;
        }
        for (const handler of this.#handlers) {
          handler(frame);
        }
      };

      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // 4401 here means the age gate, not a bad token — the handshake
          // resolves identity and the gate in the same call.
          reject(
            new Error(
              `${this.label}: socket closed before ready (${event.code})`,
            ),
          );
        }
      };

      socket.onerror = () => {};
    });
  }

  onFrame(handler) {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #send(frame) {
    if (this.#socket?.readyState !== 1) {
      throw new Error(`${this.label}: socket is not open`);
    }
    this.#socket.send(JSON.stringify(frame));
  }

  joinChannel(channelId) {
    this.channelId = channelId;
    this.#send({ type: "join-channel", channelId });
  }

  /**
   * The typing indicator. Rate-limited server-side to ~1/s sustained
   * (`typingLimiter` in ws/chat.ts), so the runner re-sends every 2.5s during a
   * long "typing" pause rather than spamming and being silently dropped.
   */
  typing() {
    this.#send({ type: "typing", channelId: this.channelId });
  }

  send(body) {
    this.#send({ type: "message-create", channelId: this.channelId, body });
  }

  react(messageId, emoji) {
    this.#send({
      type: "reaction-toggle",
      channelId: this.channelId,
      messageId,
      emoji,
    });
  }

  close() {
    this.#socket?.close();
    this.#socket = null;
  }
}

/**
 * Hold a typing indicator for `durationMs`, then resolve.
 *
 * The indicator is a heartbeat, not a state — one `typing` frame produces a
 * blip that expires. Re-sending inside the limiter's sustained rate is what
 * makes "Cacau is typing…" stay on screen for the four seconds a 90-character
 * message would actually take to write.
 */
export async function typeFor(socket, durationMs) {
  const deadline = Date.now() + durationMs;
  socket.typing();
  while (Date.now() < deadline) {
    const wait = Math.min(2500, deadline - Date.now());
    await sleep(wait);
    if (Date.now() < deadline) {
      socket.typing();
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
