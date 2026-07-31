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

  await page.getByRole("button", { name: "New config" }).click();
  await page.getByLabel("Configuration group").selectOption({ label: "New configuration group…" });
  await page.getByLabel("Agent").selectOption("claude-code");
  await page.getByLabel("Group name").fill("E2E workstation");
  await page.getByLabel("Group slug").fill("e2e-workstation");
  await page.getByRole("button", { name: "Create config" }).click();

  await page.getByRole("button", { name: "New config" }).click();
  await page.getByLabel("Configuration group").selectOption({ label: "E2E workstation · e2e-workstation" });
  await page.getByLabel("Agent").selectOption("omp");
  await page.getByRole("button", { name: "Create config" }).click();

  await expect(page.getByRole("button", { name: "By group" })).toHaveAttribute("aria-pressed", "true");
  const groupSection = page.getByRole("region", { name: "E2E workstation" });
  await expect(groupSection.locator('a[href$="/configs/claude-code"]')).toBeVisible();
  await expect(groupSection.locator('a[href$="/configs/omp"]')).toBeVisible();
  await page.getByRole("button", { name: "By Agent" }).click();
  const claudeSection = page.getByRole("region", { name: "claude-code" });
  const ompSection = page.getByRole("region", { name: "omp" });
  await expect(claudeSection.getByRole("link", { name: /E2E workstation/ })).toBeVisible();
  await expect(ompSection.getByRole("link", { name: /E2E workstation/ })).toBeVisible();
  await claudeSection.getByRole("link", { name: /E2E workstation/ }).click();
  await expect(page).toHaveURL(/\/config-sets\/[^/]+\/configs\/claude-code$/);

  await expect(page.getByLabel("Agent")).toHaveCount(0);
  await expect(page.getByLabel("Managed surface")).toHaveCount(0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Relative path").fill("rules/e2e.md");
  const createFileResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    response.url().endsWith("/configs/claude-code/files")
  ));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  expect((await createFileResponse).status()).toBe(201);

  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    response.url().endsWith("/configs/claude-code/files")
  ));
  await page.getByLabel("Upload file").setInputFiles({
    name: "settings.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"model":"uploaded"}'),
  });
  expect((await uploadResponse).status()).toBe(201);
  await page.waitForFunction(() => "monaco" in window);
  await expect.poll(async () => await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { getValue(): string }[] } };
    };
    return browserWindow.monaco.editor.getModels()[0]!.getValue();
  })).toBe('{"model":"uploaded"}');
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
  await page.getByRole("button", { name: /settings\.json/ }).click();
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
  await expect(page.getByRole("heading", { name: "Releases", exact: true })).toBeVisible();
  const configuration = page.getByLabel("Configuration group");
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

test("redesign visual invariants", async ({ page }) => {
  // server already initialized by first test; navigate to login
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/config-sets$/);

  // six nav links each have visible text + one aria-hidden svg
  for (const label of ["Configuration", "Resources", "Credentials", "Releases", "Devices", "Settings"]) {
    const link = page.getByRole("link", { name: new RegExp(label) });
    await expect(link).toBeVisible();
    await expect(link.locator("svg[aria-hidden='true']")).toHaveCount(1);
  }

  // three FX canvas layers are mounted
  await expect(page.locator("canvas.fx-flow")).toHaveCount(1);
  await expect(page.locator("canvas.fx-grain")).toHaveCount(1);

  // Monaco switched to ach-void theme (background #080b0e)
  await page.locator('a[href$="/configs/claude-code"]').first().click();
  await page.waitForFunction(() => "monaco" in window);
  await expect.poll(async () => await page.evaluate(
    () => getComputedStyle(document.querySelector(".monaco-editor")!).backgroundColor,
  )).toBe("rgb(8, 11, 14)");
  // if rule lands on child: ".monaco-editor .monaco-editor-background"

  // zero emoji in page body
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
});
