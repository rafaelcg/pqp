import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Re-records the Baú demo reel that the owner's empty-state guide plays
 * (`client/src/assets/bau/bau-demo.<lang>.{webm,mp4,jpg}`).
 *
 * NOT A TEST. It is skipped unless `BAU_DEMO_DIR` names an output directory,
 * so the suite never runs it. It lives here because it needs the suite's
 * webServer pair (API on 3101 with the flags on, Vite on 5174) and the
 * dev-bypass identities. Run it whenever the card or feed design changes,
 * so the reel never shows last month's chrome:
 *
 *   cd client
 *   set -a; source ../.env; set +a                   # S3_* for the uploads
 *   BAU_DEMO_DIR=/tmp/bau-demo E2E_DATABASE_URL=... \
 *     npx playwright test e2e/bau-demo-record.spec.ts
 *
 * Then, per language (crop drops the rail + channel list, 328 px wide):
 *
 *   ffmpeg -ss 0.6 -i raw.pt-BR.webm -vf "crop=952:800:328:0,scale=760:-2" \
 *     -c:v libvpx-vp9 -crf 34 -b:v 0 -an src/assets/bau/bau-demo.pt-BR.webm
 *   ffmpeg -ss 0.6 -i raw.pt-BR.webm -vf "crop=952:800:328:0,scale=760:-2" \
 *     -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart \
 *     -an src/assets/bau/bau-demo.pt-BR.mp4
 *   ffmpeg -ss 1.2 -i raw.pt-BR.webm -vf "crop=952:800:328:0,scale=760:-2" \
 *     -frames:v 1 -q:v 4 src/assets/bau/bau-demo.pt-BR.jpg
 *
 * Needs MinIO up (`docker compose --profile storage up -d`) for the image
 * and PDF posts, and an e2e database with no other "Mesa da Tues" in it
 * (the community slug must be unique or the server lands on #general).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const OUT = process.env.BAU_DEMO_DIR;
const FIXTURES = path.join(__dirname, "fixtures", "bau");

test.skip(!OUT, "Set BAU_DEMO_DIR to record the Baú demo reel");

const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function json(response: Response) {
  if (!response.ok) {
    throw new Error(`${response.url} ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function person(suffix: string, displayName: string) {
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName }),
  });
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({
      onboardedAt: now,
      firstRunDismissedAt: now,
      communityHomeIntroDismissedAt: now,
    }),
  });
}

async function upload(serverId: string, file: string, contentType: string) {
  const bytes = fs.readFileSync(path.join(FIXTURES, file));
  const minted = await json(
    await fetch(`${API}/api/servers/${serverId}/home/media`, {
      method: "POST",
      headers: headers("rec-owner"),
      body: JSON.stringify({ contentType, byteSize: bytes.length, filename: file }),
    }),
  );
  const put = await fetch(minted.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`PUT ${put.status} ${await put.text()}`);
  }
  await json(
    await fetch(`${API}/api/servers/${serverId}/home/media/claim`, {
      method: "POST",
      headers: headers("rec-owner"),
      body: JSON.stringify({ uploadId: minted.uploadId }),
    }),
  );
  return minted.uploadId as string;
}

async function seed(): Promise<string> {
  await person("rec-owner", "Tues");
  await person("rec-ana", "Ana");
  await person("rec-leo", "Leo");
  await person("rec-bia", "Bia");
  const { server } = await json(
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers("rec-owner"),
      body: JSON.stringify({ name: "Mesa da Tues" }),
    }),
  );
  const { invite } = await json(
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers("rec-owner"),
      body: JSON.stringify({}),
    }),
  );
  for (const suffix of ["rec-ana", "rec-leo", "rec-bia"]) {
    await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headers(suffix),
    });
  }
  await json(
    await fetch(`${API}/api/servers/${server.id}/community`, {
      method: "PATCH",
      headers: headers("rec-owner"),
      body: JSON.stringify({ isCommunity: true, category: "games", tagline: "RPG às terças." }),
    }),
  );
  const post = async (body: object) =>
    (
      await json(
        await fetch(`${API}/api/servers/${server.id}/home/posts`, {
          method: "POST",
          headers: headers("rec-owner"),
          body: JSON.stringify({ status: "published", ...body }),
        }),
      )
    ).post as { id: string };
  const comment = (id: string, suffix: string, body: string) =>
    fetch(`${API}/api/servers/${server.id}/home/posts/${id}/comments`, {
      method: "POST",
      headers: headers(suffix),
      body: JSON.stringify({ body }),
    });
  const like = (id: string, suffix: string) =>
    fetch(`${API}/api/servers/${server.id}/home/posts/${id}/likes`, {
      method: "POST",
      headers: headers(suffix),
    });

  const rules = await post({
    title: "Regras da mesa, v3",
    body: "Atualizei a regra de descanso curto. Página 4. Lê antes de terça.",
    mediaUploadId: await upload(server.id, "regras.pdf", "application/pdf"),
  });
  await like(rules.id, "rec-ana");
  await post({
    title: "O crítico do Leo, em câmera lenta",
    body: "O clip inteiro, 40 segundos de glória.",
    visibility: "members",
    teaser: "Só o inner vê o clip. Vale muito.",
  });
  const map = await post({
    title: "Mapa do porão",
    body: "O porão da Taverna do Corvo, do jeito que ficou depois da sessão 10. O X no Tesouro é onde o Tobias caiu.",
    mediaUploadId: await upload(server.id, "mapa-porao.png", "image/png"),
  });
  await comment(map.id, "rec-ana", "hahaha o Tobias");
  await comment(map.id, "rec-leo", "eu faltei, valeu por postar");
  await comment(map.id, "rec-ana", "melhor sessão do ano");
  await like(map.id, "rec-ana");
  await like(map.id, "rec-leo");
  const poster = await post({
    title: "Sessão 11: terça, 20h",
    body: "Quem faltou lê o resumo do porão antes de entrar na call.",
    mediaUploadId: await upload(server.id, "sessao-11.png", "image/png"),
  });
  await comment(poster.id, "rec-ana", "presente!");
  await like(poster.id, "rec-ana");
  await like(poster.id, "rec-leo");
  await like(poster.id, "rec-bia");
  return server.id;
}

test("record the Baú demo reel", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const serverId = await seed();
  for (const lang of ["pt-BR", "en"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: OUT!, size: { width: 1280, height: 800 } },
      locale: lang,
    });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("pqp:dev-user-suffix", "rec-bia"));
    await page.goto(`${baseURL}/app/server/${serverId}?lang=${lang}&communityHome=1`);
    await page.locator("[data-community-home-feed]").waitFor({ timeout: 20_000 });
    // The dev-bypass banner is not part of the product.
    await page.addStyleTag({ content: "main > div.bg-warning\\/10 { display: none !important }" });
    await page.waitForTimeout(2200);
    const pane = page.locator("[data-community-home-feed] .overflow-y-auto");
    const scroll = async (dy: number, ms: number) => {
      await pane.evaluate((el, d) => el.scrollBy({ top: d, behavior: "smooth" }), dy);
      await page.waitForTimeout(ms);
    };
    await scroll(420, 1100);
    await scroll(420, 1100);
    const map = page.locator("[data-home-post]").filter({ hasText: "Mapa do porão" });
    await map.locator("[data-home-like]").hover();
    await page.waitForTimeout(400);
    await map.locator("[data-home-like]").click();
    await page.waitForTimeout(1100);
    await map.locator("[data-home-comments-toggle]").click();
    await page.waitForTimeout(1600);
    await scroll(520, 1200);
    await scroll(520, 1300);
    await scroll(600, 1800);
    const video = page.video()!;
    await context.close();
    fs.renameSync(await video.path(), path.join(OUT!, `raw.${lang}.webm`));
  }
});
