import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

test("administers a configuration through release without retaining one-time secrets", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Setup code").fill("playwright-setup-code");
  await page.getByLabel("Administrator password").fill("correct-password");
  await page.getByRole("button", { name: "Initialize" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/config-sets$/);

  await page.getByRole("button", { name: "New configuration" }).click();
  await page.getByLabel("Name").fill("E2E workstation");
  await page.getByLabel("Slug").fill("e2e-workstation");
  await page.getByRole("button", { name: "Create set" }).click();
  await page.getByRole("link", { name: /E2E workstation/ }).click();
  await page.getByRole("button", { name: "Add file" }).click();
  await page.locator('select[name="agentId"]').selectOption("claude-code");
  const settingsSurface = page.locator('select[name="surface"] option').filter({ hasText: "settings.json" }).first();
  await page.locator('select[name="surface"]').selectOption((await settingsSurface.getAttribute("value"))!);
  await page.getByLabel("Relative path").fill("settings.json");
  const createFileResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT" && response.url().endsWith("/files")
  ));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  expect((await createFileResponse).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: /settings\.json/ })).toBeVisible();
  await page.waitForFunction(() => "monaco" in window);
  const saveResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT" && response.url().includes("/files") && response.status() === 200
  ));
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { setValue(value: string): void }[] } };
    };
    browserWindow.monaco.editor.getModels()[0]!.setValue('{"model":"e2e"}');
  });
  await saveResponse;
  await expect(page.locator(".save-state")).toHaveText("saved");
  await page.reload();
  await page.waitForFunction(() => "monaco" in window);
  await expect.poll(async () => await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { getValue(): string }[] } };
    };
    return browserWindow.monaco.editor.getModels()[0]!.getValue();
  })).toBe('{"model":"e2e"}');

  await page.getByRole("link", { name: /Resources/ }).click();
  await page.getByRole("button", { name: "New resource" }).click();
  await page.getByLabel("Name").fill("E2E instructions");
  await page.getByLabel("Slug").fill("e2e-instructions");
  await page.getByLabel("Instruction Markdown").fill("Always verify E2E changes.");
  await page.getByRole("button", { name: "Create revision" }).click();
  await expect(page.getByText("E2E instructions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New resource" }).click();
  await page.getByLabel("Kind").selectOption("skill");
  await page.getByLabel("Name").fill("E2E skill");
  await page.getByLabel("Slug").fill("e2e-skill");
  await page.locator('input[name="files"]').setInputFiles(resolve(import.meta.dirname, "fixtures/portable-skill"));
  await page.getByRole("button", { name: "Create revision" }).click();
  await page.getByText("E2E skill", { exact: true }).click();
  await expect(page.getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect(page.getByText("assets/info.txt", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Releases/ }).click();
  const configuration = page.getByLabel("Configuration");
  const configurationId = await configuration.locator("option").filter({ hasText: "E2E workstation" }).getAttribute("value");
  expect(configurationId).toBeTruthy();
  await configuration.selectOption(configurationId!);
  await expect(configuration).toHaveValue(configurationId!);
  await expect(page.getByLabel("Release notes")).toBeVisible();
  await page.getByLabel("Release notes").fill("E2E release");
  await page.getByRole("button", { name: "Validate & publish immutable release" }).click();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByText("The release was published after the complete freeze pipeline passed.")).toBeVisible();

  await page.getByRole("link", { name: /Devices/ }).click();
  await page.getByLabel("Label").fill("E2E automation");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.locator(".one-time-token code").textContent();
  expect(token).toMatch(/^agch_auto_/);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText(token!, { exact: true })).toHaveCount(0);
});
