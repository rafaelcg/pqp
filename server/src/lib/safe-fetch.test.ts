import * as http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  fetchPinnedAddress,
  FetchTooLargeError,
  isBlockedAddress,
  safeFetch,
  safePost,
  UnsafeUrlError,
} from "./safe-fetch.js";

describe("isBlockedAddress", () => {
  it("blocks every RFC 1918 private range", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("blocks loopback, link-local, and the cloud metadata address specifically", () => {
    // 169.254.169.254 is not a random link-local address to call out by name —
    // it is the address every major cloud serves instance credentials from,
    // and the single most valuable target an SSRF bug can reach.
    for (const ip of ["127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("blocks CGNAT, 0.0.0.0/8, and multicast/reserved space", () => {
    for (const ip of ["100.64.0.1", "0.0.0.1", "224.0.0.1", "255.255.255.255"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("does not block ordinary public IPv4 addresses just outside those ranges", () => {
    // One below and one above each private range's boundary — the exact place
    // an off-by-one in a range check would show up.
    for (const ip of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "8.8.8.8", "1.1.1.1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it("blocks IPv6 loopback and unique-local space", () => {
    for (const ip of ["::1", "fc00::1", "fd12:3456:789a::1", "fe80::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("unwraps an IPv4-mapped IPv6 address and checks the wrapped address", () => {
    // The exact bypass this exists to close: `::ffff:169.254.169.254` reaches
    // the metadata endpoint through an address family the IPv4 list alone
    // would never recognise.
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("does not block a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks anything that fails to parse as an IP at all", () => {
    // resolveSafeAddress never hands this something that is not a literal
    // address, but the function must still fail closed if it ever did.
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("safeFetch: refuses before ever connecting", () => {
  it("refuses a literal loopback address even when something is listening there", async () => {
    const server = http.createServer((_req, res) => res.end("should never be reached"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { accept: "text/html" }),
    ).rejects.toThrow(UnsafeUrlError);

    server.close();
  });

  it("refuses a non-http(s) protocol", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
  });

  it("refuses a URL carrying embedded credentials", async () => {
    await expect(
      safeFetch("http://user:pass@example.com/"),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("refuses a hostname that only resolves to blocked addresses", async () => {
    await expect(safeFetch("http://localhost/")).rejects.toThrow(UnsafeUrlError);
  });
});

describe("fetchPinnedAddress: connection mechanics against a real server", () => {
  const servers: http.Server[] = [];

  afterAll(() => {
    for (const server of servers) {
      server.close();
    }
  });

  async function serve(
    handler: http.RequestListener,
  ): Promise<{ url: URL; resolved: { address: string; family: 4 } }> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: new URL(`http://127.0.0.1:${port}/`),
      resolved: { address: "127.0.0.1", family: 4 },
    };
  }

  it("returns the body and status for an ordinary response", async () => {
    const { url, resolved } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>hello</html>");
    });
    const result = await fetchPinnedAddress(url, resolved, { accept: "text/html" });
    expect(result.statusCode).toBe(200);
    expect(result.body.toString()).toBe("<html>hello</html>");
  });

  it("rejects once the body exceeds the size cap, even if Content-Length lied", async () => {
    const { url, resolved } = await serve((_req, res) => {
      // No Content-Length at all — the cap has to be enforced by counting
      // bytes actually received, not by trusting a header a hostile or
      // merely misconfigured server controls.
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, "a");
      for (let i = 0; i < 16; i++) {
        res.write(chunk);
      }
      res.end();
    });
    await expect(
      fetchPinnedAddress(url, resolved, { accept: "*/*" }),
    ).rejects.toThrow(FetchTooLargeError);
  });

  it("times out a connection that accepts but never responds", async () => {
    const { url, resolved } = await serve(() => {
      // Never call res.end() or res.write() — simulates a stalled upstream.
    });
    await expect(
      fetchPinnedAddress(url, resolved, { accept: "*/*", timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it("connects to the pinned address regardless of the URL's own hostname", async () => {
    // The whole point of pinning: the request targets 127.0.0.1 (`resolved`)
    // even though the URL says a hostname that was never looked up for this
    // call at all. A real DNS-rebinding attempt would look like this from the
    // caller's side — a URL whose name now points somewhere else — and the
    // fix is that nothing here ever asks the resolver a second time.
    const { url: realUrl, resolved } = await serve((_req, res) =>
      res.end("reached via pinned address"),
    );
    const spoofedUrl = new URL(realUrl.toString());
    spoofedUrl.hostname = "this-name-is-never-resolved.invalid";
    const result = await fetchPinnedAddress(spoofedUrl, resolved, {
      accept: "*/*",
    });
    expect(result.body.toString()).toBe("reached via pinned address");
  });
});

describe("safePost: outgoing webhook SSRF", () => {
  it("refuses loopback and never connects without allowPrivate", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end("should never be reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    await expect(
      safePost(`http://127.0.0.1:${port}/hook`, {
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(hits).toBe(0);

    server.close();
  });

  it("POSTs to loopback when allowPrivate is set and does not follow redirects", async () => {
    let posts = 0;
    const server = http.createServer((req, res) => {
      posts += 1;
      expect(req.method).toBe("POST");
      if (req.url === "/gone") {
        res.writeHead(302, { location: "/private" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const ok = await safePost(`http://127.0.0.1:${port}/hook`, {
      body: '{"hello":"world"}',
      allowPrivate: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.toString()).toBe("ok");

    const redirected = await safePost(`http://127.0.0.1:${port}/gone`, {
      body: "{}",
      allowPrivate: true,
    });
    expect(redirected.statusCode).toBe(302);
    expect(posts).toBe(2);

    server.close();
  });
});
