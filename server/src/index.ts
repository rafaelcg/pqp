import "./env.js";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { handleApi } from "./api/index.js";
import { initDb } from "./db.js";
import { sendError } from "./lib/http.js";
import { handleWsConnection } from "./ws/index.js";

const PORT = Number(process.env.PORT ?? 3001);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(__dirname, "../../client/dist");

async function serveStatic(
  pathname: string,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  if (!existsSync(CLIENT_DIST)) {
    return false;
  }

  let filePath = join(CLIENT_DIST, pathname === "/" ? "index.html" : pathname);
  if (!existsSync(filePath) && !pathname.includes(".")) {
    filePath = join(CLIENT_DIST, "index.html");
  }

  if (!existsSync(filePath)) {
    return false;
  }

  const ext = filePath.split(".").pop();
  const types: Record<string, string> = {
    html: "text/html",
    js: "application/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    ico: "image/x-icon",
    xml: "application/xml",
    txt: "text/plain",
  };

  res.writeHead(200, { "Content-Type": types[ext ?? ""] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
  return true;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname);
    } catch (error) {
      console.error(error);
      sendError(res, 500, "Internal server error");
    }
    return;
  }

  if (await serveStatic(pathname, res)) {
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("pqp server");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket) => {
  handleWsConnection(socket);
});

async function main() {
  await initDb();
  httpServer.listen(PORT, () => {
    console.log(`pqp server listening on http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
