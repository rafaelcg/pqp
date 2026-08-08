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

  async call(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
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

  async createInvite(serverId) {
    const result = await this.call(`/api/servers/${serverId}/invites`, {
      method: "POST",
      body: {},
    });
    return (result.invite ?? result).code;
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
