/**
 * A TCP proxy in front of Postgres that can be turned into a black hole.
 *
 * What a network partition looks like from the API box, which is what the
 * 2026-09-23 blip was (Vultr managed Postgres unreachable, not refusing):
 *  - bytes on connections that are already open go nowhere, and no error
 *    arrives either, so a query in flight hangs until a client timer fires;
 *  - a new connection attempt gets no answer at all.
 *
 * So while the hole is open this proxy accepts sockets and says nothing, and
 * drops every byte in both directions. When it closes, every connection that
 * lived through the hole is destroyed (their streams have lost bytes and can
 * never be trusted again, the same as a TCP connection that timed out), and
 * new ones are proxied normally.
 */
import net from "node:net";

export function startBlackholeProxy({ listenPort, targetHost, targetPort }) {
  let holeOpen = false;
  const live = new Set();
  const tainted = new Set();

  const server = net.createServer((client) => {
    const entry = { client, upstream: null };
    live.add(entry);
    const cleanup = () => {
      live.delete(entry);
      tainted.delete(entry);
      client.destroy();
      entry.upstream?.destroy();
    };
    client.on("error", cleanup);
    client.on("close", cleanup);
    if (holeOpen) {
      // Accepted, never answered: a SYN into the void, as far as pg can tell.
      tainted.add(entry);
      client.on("data", () => {});
      return;
    }
    const upstream = net.connect(targetPort, targetHost);
    entry.upstream = upstream;
    upstream.on("error", cleanup);
    upstream.on("close", cleanup);
    client.on("data", (chunk) => {
      if (!holeOpen) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!holeOpen) client.write(chunk);
    });
  });

  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      resolve({
        open() {
          holeOpen = true;
          for (const entry of live) tainted.add(entry);
        },
        close() {
          holeOpen = false;
          for (const entry of tainted) {
            entry.client.destroy();
            entry.upstream?.destroy();
          }
          tainted.clear();
        },
        isOpen: () => holeOpen,
        stop: () =>
          new Promise((done) => {
            for (const entry of live) {
              entry.client.destroy();
              entry.upstream?.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}
