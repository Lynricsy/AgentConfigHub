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
  await page.getByRole("button", { name: "New instruction" }).click();
  await page.getByLabel("Name").fill("E2E instructions");
  await page.getByLabel("Slug").fill("e2e-instructions");
  await page.getByRole("button", { name: "Create instruction" }).click();
  await page.waitForFunction(() => "monaco" in window);
  await page.waitForFunction(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string } }[] } };
    };
    return browserWindow.monaco.editor.getModels()
      .some((model) => model.uri.toString().includes("/instruction.md"));
  });
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string }; setValue(value: string): void }[] } };
    };
    browserWindow.monaco.editor.getModels()
      .find((model) => model.uri.toString().includes("/instruction.md"))!
      .setValue("Always verify E2E changes.");
  });
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByRole("button", { name: /E2E instructions e2e-instructions · r2/ })).toBeVisible();
  await page.waitForFunction(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string } }[] } };
    };
    return browserWindow.monaco.editor.getModels()
      .some((model) => model.uri.toString().includes("/instruction.md"));
  });
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string }; setValue(value: string): void }[] } };
    };
    browserWindow.monaco.editor.getModels()
      .find((model) => model.uri.toString().includes("/instruction.md"))!
      .setValue("Keep this local E2E draft.");
  });
  const concurrentStatus = await page.evaluate(async () => {
    const data = await (await fetch("/api/v1/resources")).json() as {
      resources: { id: string; slug: string; revisionId: string }[];
      files: {
        resourceId: string;
        relativePath: string;
        blobSha256: string;
        mediaType: string;
        executable: boolean;
      }[];
    };
    const resource = data.resources.find(({ slug }) => slug === "e2e-instructions")!;
    const descriptor = await (await fetch("/api/v1/blobs", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "Concurrent E2E server edit.",
    })).json() as { sha256: string };
    const files = data.files
      .filter(({ resourceId }) => resourceId === resource.id)
      .map((file) => ({
        relativePath: file.relativePath,
        blobSha256: descriptor.sha256,
        mediaType: file.mediaType,
        executable: file.executable,
      }));
    return (await fetch(`/api/v1/resources/${resource.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${resource.revisionId}"`,
      },
      body: JSON.stringify({ files }),
    })).status;
  });
  expect(concurrentStatus).toBe(200);
  await page.getByRole("button", { name: "Save revision" }).click();
  const conflictPanel = page.locator(".conflict-panel");
  await expect(conflictPanel.getByRole("heading", { name: "Resource revision changed" })).toBeVisible();
  await expect(conflictPanel.getByText("Keep this local E2E draft.", { exact: true })).toBeVisible();
  await expect(conflictPanel.getByText("Concurrent E2E server edit.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep mine as new revision" }).click();
  await expect(page.getByRole("button", { name: /E2E instructions e2e-instructions · r4/ })).toBeVisible();

  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Name").fill("E2E skill");
  await page.getByLabel("Slug").fill("e2e-skill");
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByRole("button", { name: "SKILL.md" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).click();
  await page.getByLabel("Relative path").fill("assets/info.txt");
  await page.getByRole("button", { name: "Create file" }).click();
  await page.waitForFunction(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string } }[] } };
    };
    return browserWindow.monaco.editor.getModels()
      .some((model) => model.uri.toString().includes("/assets/info.txt"));
  });
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string }; setValue(value: string): void }[] } };
    };
    browserWindow.monaco.editor.getModels()
      .find((model) => model.uri.toString().includes("/assets/info.txt"))!
      .setValue("portable skill asset");
  });
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByRole("button", { name: /E2E skill e2e-skill · r3/ })).toBeVisible();

  await page.getByRole("link", { name: /Configuration/ }).click();
  await page.getByRole("link", { name: /E2E workstation Agent · claude-code/ }).click();
  await page.getByRole("checkbox", { name: /E2E instructions/ }).click();
  await expect(page.getByRole("checkbox", { name: /E2E instructions/ })).toBeChecked();
  await page.getByRole("checkbox", { name: /E2E skill/ }).click();
  await expect(page.getByRole("checkbox", { name: /E2E skill/ })).toBeChecked();

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
