import { expect, test } from "@playwright/test";
import { ensureServer, resetPreferences } from "./fixtures";

test("es paints the chat chrome from the Spanish catalogue", async ({ page }) => {
  await ensureServer();
  await resetPreferences();
  await page.goto("/app?lang=es");
  await expect(page.getByText("Bypass de auth de desarrollo")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Buscar mensajes")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
});

test("a Spanish browser gets Spanish with no ?lang=", async ({ browser }) => {
  const context = await browser.newContext({ locale: "es-MX" });
  const page = await context.newPage();
  await page.goto("/vem");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Casa nueva",
    { timeout: 20_000 },
  );
  await context.close();
});

test("/ven opens the campaign page in Spanish", async ({ page }) => {
  await page.goto("/ven");
  await expect(page).toHaveURL(/\/vem\?lang=es/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "La misma banda",
    { timeout: 20_000 },
  );
});
