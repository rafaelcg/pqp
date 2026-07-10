#!/usr/bin/env node
/**
 * electron-builder fails if extraResources.from is missing.
 * Ensure client/dist exists (real build or a tiny placeholder for shell-only packs).
 */
const fs = require("node:fs");
const path = require("node:path");

const dist = path.resolve(__dirname, "../../client/dist");
const indexHtml = path.join(dist, "index.html");

if (fs.existsSync(indexHtml)) {
  process.exit(0);
}

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(
  indexHtml,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>pqp</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'"
    />
    <style>
      body {
        font-family: system-ui, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        margin: 0;
        background: #0f1115;
        color: #e8eaed;
      }
      code { color: #9ecbff; }
    </style>
  </head>
  <body>
    <main>
      <h1>pqp</h1>
      <p>
        Client build missing. Run
        <code>pnpm --filter @pqp/client build</code>
        before packaging, or set <code>PQP_APP_URL</code> to a remote app.
      </p>
    </main>
  </body>
</html>
`,
);

console.warn(
  "[pqp/electron] client/dist missing — wrote a placeholder. Prefer: pnpm --filter @pqp/client build",
);
