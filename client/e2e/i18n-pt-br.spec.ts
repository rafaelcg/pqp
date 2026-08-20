import { expect, test } from "@playwright/test";
import { ensureServer, resetPreferences } from "./fixtures";

test("pt-BR paints the chat chrome from the catalogue", async ({ page }) => {
  await ensureServer();
  await resetPreferences();
  await page.goto("/app?lang=pt-BR");
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Fixadas" })).toBeVisible();
  await expect(page.getByText("Buscar mensagens")).toBeVisible();
});
