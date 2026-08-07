import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Radix Select 不是原生 <select>:先点开 trigger,再点 role=option。
 * 用 role=combobox + exact 而非 getByLabel:getByLabel 是子串匹配,
 * "Agent" 会同时命中 "By Agent" 那个 tabpanel。
 */
async function chooseOption(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/config-sets$/);
}

interface MonacoModel {
  uri: { toString(): string };
  getValue(): string;
  setValue(value: string): void;
}

declare global {
  /** 未加载时返回 undefined —— 绝不能抛,expect.poll 遇到异常会直接失败而不是重试。 */
  function settingsModel(): MonacoModel | undefined;
}

/**
 * 在页面里装一个按 URI 取 Monaco 模型的助手。编辑器用 keepCurrentModel,
 * 先前打开的 rules/e2e.md 模型会继续存活,所以 getModels()[0] 的下标假设
 * 会随创建顺序漂移。
 */
async function installModelHelper(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      settingsModel: () => MonacoModel | undefined;
      monaco?: { editor: { getModels(): MonacoModel[] } };
    };
    target.settingsModel = () => target.monaco?.editor.getModels()
      .find((candidate) => candidate.uri.toString().includes("/settings.json"));
  });
}

test("administers a configuration through release without retaining one-time secrets", async ({ page }) => {
  await installModelHelper(page);
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
  await chooseOption(page, "Configuration group", "New configuration group…");
  await chooseOption(page, "Agent", "claude-code");
  await page.getByLabel("Group name").fill("E2E workstation");
  await page.getByLabel("Group slug").fill("e2e-workstation");
  await page.getByRole("button", { name: "Create config" }).click();

  await page.getByRole("button", { name: "New config" }).click();
  await chooseOption(page, "Configuration group", "E2E workstation · e2e-workstation");
  await chooseOption(page, "Agent", "omp");
  await page.getByRole("button", { name: "Create config" }).click();

  await expect(page.getByRole("tab", { name: "By group" })).toHaveAttribute("aria-selected", "true");
  const groupSection = page.getByRole("region", { name: "E2E workstation" });
  await expect(groupSection.locator('a[href$="/configs/claude-code"]')).toBeVisible();
  await expect(groupSection.locator('a[href$="/configs/omp"]')).toBeVisible();
  await page.getByRole("tab", { name: "By Agent" }).click();
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
  let releaseFirstCreate!: () => void;
  const firstCreateGate = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  let reportFirstCreate!: () => void;
  const firstCreatePaused = new Promise<void>((resolve) => {
    reportFirstCreate = resolve;
  });
  let createRequestCount = 0;
  const createRoute = "**/configs/claude-code/files";
  await page.route(createRoute, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequestCount += 1;
    if (createRequestCount === 1) {
      reportFirstCreate();
      await firstCreateGate;
    }
    await route.continue();
  });
  const createFileResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    response.url().endsWith("/configs/claude-code/files")
  ));
  const createButton = page.getByRole("button", { name: "Create", exact: true });
  const newButton = page.getByRole("button", { name: "New", exact: true });
  const uploadInput = page.getByLabel("Upload file");
  const deleteButton = page.getByRole("button", { name: "Delete", exact: true });
  const createClick = createButton.click();
  await firstCreatePaused;
  await expect(newButton).toBeDisabled();
  await expect(uploadInput).toBeDisabled();
  await expect(createButton).toBeDisabled();
  await expect(deleteButton).toBeDisabled();
  await page.locator("form.add-file-bar").evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
  });
  await page.waitForTimeout(100);
  expect(createRequestCount).toBe(1);
  releaseFirstCreate();
  await createClick;
  expect((await createFileResponse).status()).toBe(201);
  await expect(createButton).toHaveCount(0);
  await expect(newButton).toBeEnabled();
  await expect(uploadInput).toBeEnabled();
  await expect(deleteButton).toBeEnabled();
  await page.unroute(createRoute);

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
  // 按 URI 取模型:keepCurrentModel 让 rules/e2e.md 的模型继续存活,
  // getModels()[0] 的下标假设会随创建顺序漂移。
  await expect.poll(async () => await page.evaluate(() => settingsModel()?.getValue() ?? null))
    .toBe('{"model":"uploaded"}');
  const saveResponse = page.waitForResponse((response) => (
    response.request().method() === "PUT" && response.url().includes("/files") && response.status() === 200
  ));
  await page.evaluate(() => { settingsModel()!.setValue('{"model":"e2e"}'); });
  await saveResponse;
  await expect(page.locator(".save-state")).toHaveText("saved");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __e2eEditorElement?: Element | null;
      __e2eInput?: Element | null;
      __e2eModel?: unknown;
    };
    browserWindow.__e2eEditorElement = document.querySelector(".monaco-editor");
    browserWindow.__e2eInput = document.activeElement;
    browserWindow.__e2eModel = settingsModel();
  });
  const firstContinuousSave = page.waitForResponse((response) => (
    response.request().method() === "PUT" && response.url().includes("/files") && response.status() === 200
  ));
  await page.keyboard.insertText(" ");
  await firstContinuousSave;
  await expect(page.locator(".save-state")).toHaveText("saved");
  expect(await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __e2eEditorElement?: Element | null;
      __e2eInput?: Element | null;
      __e2eModel?: unknown;
    };
    return browserWindow.__e2eModel !== undefined &&
      browserWindow.__e2eEditorElement === document.querySelector(".monaco-editor") &&
      browserWindow.__e2eModel === settingsModel() &&
      document.activeElement === browserWindow.__e2eInput;
  })).toBe(true);
  const secondContinuousSave = page.waitForResponse((response) => (
    response.request().method() === "PUT" && response.url().includes("/files") && response.status() === 200
  ));
  await page.keyboard.insertText(" ");
  await secondContinuousSave;
  await expect(page.locator(".save-state")).toHaveText("saved");
  await expect.poll(async () => await page.evaluate(() => settingsModel()?.getValue() ?? null))
    .toBe('{"model":"e2e"}  ');
  await page.reload();
  await page.getByRole("button", { name: /settings\.json/ }).click();
  await page.waitForFunction(() => "monaco" in window);
  await expect.poll(async () => await page.evaluate(() => settingsModel()?.getValue().trim() ?? null))
    .toBe('{"model":"e2e"}');

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
  await page.getByRole("button", { name: "Reload server version" }).click();
  await expect(page.getByRole("button", { name: /E2E instructions e2e-instructions · r3/ })).toBeVisible();
  await page.waitForFunction(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string } }[] } };
    };
    return browserWindow.monaco.editor.getModels()
      .some((model) => model.uri.toString().includes("/instruction.md"));
  });
  await expect.poll(async () => await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string }; getValue(): string }[] } };
    };
    return browserWindow.monaco.editor.getModels()
      .find((model) => model.uri.toString().includes("/instruction.md"))!
      .getValue();
  })).toBe("Concurrent E2E server edit.");
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      monaco: { editor: { getModels(): { uri: { toString(): string }; setValue(value: string): void }[] } };
    };
    browserWindow.monaco.editor.getModels()
      .find((model) => model.uri.toString().includes("/instruction.md"))!
      .setValue("Saved after reloading the server revision.");
  });
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByRole("button", { name: /E2E instructions e2e-instructions · r4/ })).toBeVisible();
  await expect(conflictPanel).toHaveCount(0);

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
  await chooseOption(page, "Configuration group", /E2E workstation/);
  await expect(page.getByRole("combobox", { name: "Configuration group", exact: true }))
    .toContainText("E2E workstation");
  await expect(page.getByLabel("Release notes")).toBeVisible();
  await page.getByLabel("Release notes").fill("E2E release");
  await page.getByRole("button", { name: "Validate & publish immutable release" }).click();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByText("The release was published after the complete freeze pipeline passed.")).toBeVisible();

  await page.getByRole("link", { name: /Devices/ }).click();
  await page.getByLabel("Label").fill("E2E automation");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByTestId("one-time-token").textContent();
  expect(token).toMatch(/^agch_auto_/);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText(token!, { exact: true })).toHaveCount(0);
});

test("keeps the theme and cleanliness invariants", async ({ page }) => {
  await signIn(page);

  // six nav links each have visible text + one aria-hidden svg
  for (const label of ["Configuration", "Resources", "Credentials", "Releases", "Devices", "Settings"]) {
    const link = page.getByRole("link", { name: new RegExp(label) });
    await expect(link).toBeVisible();
    await expect(link.locator("svg[aria-hidden='true']")).toHaveCount(1);
  }

  // the decorative FX canvas layers are gone for good
  await expect(page.locator("canvas.fx-flow")).toHaveCount(0);
  await expect(page.locator("canvas.fx-grain")).toHaveCount(0);

  // zero emoji in page body
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);

  // Monaco follows the app theme; the toggle cycles system -> light -> dark
  await page.locator('a[href$="/configs/claude-code"]').first().click();
  await page.waitForFunction(() => "monaco" in window);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const editorBackground = async () => await page.evaluate(() => {
    const editor = document.querySelector(".monaco-editor");
    return editor ? getComputedStyle(editor).backgroundColor : "";
  });
  const toggle = page.getByRole("button", { name: "Toggle theme" });

  await toggle.click();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem("agch-theme"))).toBe("light");
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
  const lightBackground = await editorBackground();

  await toggle.click();
  await expect.poll(async () => await page.evaluate(() => localStorage.getItem("agch-theme"))).toBe("dark");
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await expect.poll(editorBackground).not.toBe(lightBackground);
});

test("approves a device through the CLI deep link", async ({ page, request }) => {
  const created = await request.post("/api/v1/device-authorizations", {
    data: { deviceName: "e2e-cli", cliVersion: "0.0.0" },
  });
  expect(created.status()).toBe(201);
  const { userCode, deviceCode } = await created.json() as { userCode: string; deviceCode: string };
  expect(userCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

  // 未登录深链必须落到 /login,并在登录后带着 ?code= 回到审批页
  await page.goto(`/devices/approve?code=${userCode}`);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/devices/approve\\?code=${userCode}$`));
  await expect(page.getByLabel("Device code")).toHaveValue(userCode);

  await page.getByRole("button", { name: "Approve device" }).click();
  await expect(page.getByText(/Return to your terminal/)).toBeVisible();

  const polled = await request.post("/api/v1/device-authorizations/token", { data: { deviceCode } });
  expect(polled.status()).toBe(200);
  const { token } = await polled.json() as { token: string };
  expect(token).toMatch(/^agch_dev_/);
});

test("scrolls the workspace with the native wheel", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await signIn(page);
  await page.getByRole("link", { name: /Settings/ }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    return {
      overflowY: getComputedStyle(main).overflowY,
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
    };
  });
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  await page.mouse.move(600, 250);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => await page.evaluate(() => document.querySelector("main")!.scrollTop))
    .toBeGreaterThan(0);
  // 外层文档不参与滚动 —— 证明没有第二个滚动所有者
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("falls back to a new group when the selected group disappears", async ({ page }) => {
  await signIn(page);

  // 打开创建表单并明确选中一个已存在的配置组
  await page.getByRole("button", { name: "New config" }).click();
  await chooseOption(page, "Configuration group", "E2E workstation · e2e-workstation");
  const group = page.getByRole("combobox", { name: "Configuration group", exact: true });
  await expect(group).toContainText("E2E workstation");
  await expect(page.getByLabel("Group name")).toHaveCount(0);

  // 让下一次 config-sets 刷新不再包含该组(等价于并发 DELETE /api/v1/config-sets/:id),
  // 并让创建请求返回 REVISION_CONFLICT —— 那是组件唯一会在表单敞开时触发 refetch 的路径。
  await page.route("**/api/v1/config-sets", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const sets = await response.json() as { name: string }[];
    await route.fulfill({
      response,
      json: sets.filter(({ name }) => name !== "E2E workstation"),
    });
  });
  await page.route("**/api/v1/config-sets/*/configs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      json: { error: { code: "REVISION_CONFLICT", message: "Draft revision changed.", requestId: "req-stale" } },
    });
  });

  const createRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/config-sets")) {
      createRequests.push(request.postData() ?? "");
    }
  });

  await page.getByRole("button", { name: "Create config" }).click();

  // 归一到 NEW_GROUP:Trigger 不能是空白,且 name/slug 字段必须回到可见状态,
  // 否则 required 失效、submit 会把缺失字段读成字符串 "null" 提交上去
  await expect(group).toContainText("New configuration group…");
  await expect(page.getByLabel("Group name")).toBeVisible();
  await expect(page.getByLabel("Group slug")).toBeVisible();

  // 字段空着再点一次:必须被 required 挡住,一个创建请求都不许发出
  await page.getByRole("button", { name: "Create config" }).click();
  await page.waitForTimeout(300);
  expect(createRequests).toEqual([]);

  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("drops the diff when the compare selection changes", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Releases/ }).click();
  await chooseOption(page, "Configuration group", /E2E workstation/);

  // 需要第二个 release 才能测切换(publish 没有"无变更"守卫,可重复发布)
  await page.getByRole("button", { name: "Validate & publish immutable release" }).click();
  // 新发布的这一版没有 notes,时间线里渲染成 "Release without notes",不与外壳的 r2 徽标撞
  await expect(page.getByRole("listitem").filter({ hasText: "Release without notes" })).toHaveCount(1);

  await chooseOption(page, "After", "r1");
  await page.getByRole("button", { name: "Compare" }).click();
  const diffEntry = page.getByText("claude-code/claude-home/settings.json", { exact: true });
  await expect(diffEntry).toBeVisible();

  // 只切换选择、不重新对比:展示的 diff 是为 r1 算的,与当前选择不再一致,必须消失
  await chooseOption(page, "After", "r2");
  await expect(diffEntry).toHaveCount(0);

  // 改 Before 同理
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(diffEntry).toBeVisible();
  await chooseOption(page, "Before", "r1");
  await expect(diffEntry).toHaveCount(0);
});

test("ignores a slow diff response superseded by a newer compare", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Releases/ }).click();
  await chooseOption(page, "Configuration group", /E2E workstation/);

  // 只延迟"没有 before= 参数"的那次请求,也就是下面的第一次比较
  await page.route("**/api/v1/releases/*/diff**", async (route) => {
    if (!route.request().url().includes("before=")) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 2500);
      await promise;
    }
    await route.continue();
  });

  // 第一次:Empty baseline → r1,响应很慢,结果非空
  await chooseOption(page, "After", "r1");
  await page.getByRole("button", { name: "Compare" }).click();

  // 第二次:r2 → r2,响应立刻返回且结果必然为空(同一个 release 自比)
  await chooseOption(page, "Before", "r2");
  await chooseOption(page, "After", "r2");
  await page.getByRole("button", { name: "Compare" }).click();

  // 等慢响应落地后再断言:它属于已被取代的请求,既不能回写也不能渲染
  await page.waitForTimeout(3500);
  await expect(page.getByText("claude-code/claude-home/settings.json", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "After", exact: true })).toContainText("r2");

  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("does not surface an error from a compare abandoned by a selection change", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Releases/ }).click();
  await chooseOption(page, "Configuration group", /E2E workstation/);

  // 第一次比较慢慢地失败;注意这里用户**不会**再点 Compare,只是改选择,
  // 所以请求序号不会前进 —— 错误必须靠"错误自带的选择"被过滤掉
  await page.route("**/api/v1/releases/*/diff**", async (route) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2000);
    await promise;
    await route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL", message: "Diff failed for the old selection.", requestId: "req-stale-diff" } },
    });
  });

  await chooseOption(page, "After", "r1");
  await page.getByRole("button", { name: "Compare" }).click();

  // 仅切换选择,不重新比较
  await chooseOption(page, "After", "r2");

  // 旧请求随后失败:它属于已被放弃的选择,不能把错误显示在当前选择上
  await page.waitForTimeout(3000);
  await expect(page.getByText(/Diff failed for the old selection/)).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("keeps a publish error visible when an in-flight compare fails afterwards", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Releases/ }).click();
  await chooseOption(page, "Configuration group", /E2E workstation/);

  // 比较请求慢慢失败;发布请求立刻失败
  await page.route("**/api/v1/releases/*/diff**", async (route) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2000);
    await promise;
    await route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL", message: "Compare blew up late.", requestId: "req-late-diff" } },
    });
  });
  await page.route("**/api/v1/config-sets/*/releases", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      json: { error: { code: "REVISION_CONFLICT", message: "Publish blocked by e2e.", requestId: "req-publish" } },
    });
  });

  // Compare 在途 → Publish 失败 → 旧 Compare 随后失败。
  // 断言只看内联 ErrorNotice(role=alert),避免与 sonner toast 的同文案撞上
  const publishNotice = page.getByRole("alert").filter({ hasText: "Publish blocked by e2e" });
  const compareNotice = page.getByRole("alert").filter({ hasText: "Compare blew up late" });
  await chooseOption(page, "After", "r1");
  const compareFailed = page.waitForResponse((response) => response.url().includes("/diff"));
  await page.getByRole("button", { name: "Compare" }).click();
  await page.getByRole("button", { name: "Validate & publish immutable release" }).click();
  await expect(publishNotice).toBeVisible();

  // 比较的失败不能顶掉发布的失败 —— 两者属于不同动作,各自独立
  await compareFailed;
  await expect(compareNotice).toBeVisible();
  await expect(publishNotice).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("hides a stale diff when the compared release disappears", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Releases/ }).click();
  await chooseOption(page, "Configuration group", /E2E workstation/);

  // 先再发一版:r1 不再是 current release,它的 Delete 才会解禁(disabled={current})。
  // r1 是带 notes "E2E release" 的那条,新发布的一版没有 notes。
  await page.getByRole("button", { name: "Validate & publish immutable release" }).click();
  const r1Row = page.getByRole("listitem").filter({ hasText: "E2E release" });
  const deleteR1 = r1Row.getByRole("button", { name: "Delete", exact: true });
  await expect(deleteR1).toBeEnabled();

  // 对比出一份属于 r1 的 diff
  await chooseOption(page, "After", "r1");
  await page.getByRole("button", { name: "Compare" }).click();
  const diffEntry = page.getByText("claude-code/claude-home/settings.json", { exact: true });
  await expect(diffEntry).toBeVisible();

  // 真删 r1(走真实端点:DELETE → invalidate ["releases"] → refetch)
  await deleteR1.click();

  // After 选择器归空,残留的 diff 必须一起消失 —— 否则会在 Choose… 之下
  // 继续渲染一个已不存在的 release 的对比结果
  await expect(page.getByRole("combobox", { name: "After", exact: true })).toContainText("Choose…");
  await expect(diffEntry).toHaveCount(0);
});

test("never shows one credential's plaintext in another's reveal dialog", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /Credentials/ }).click();

  for (const [label, provider, value] of [
    ["Alpha key", "alpha", "sk-alpha-plaintext"],
    ["Beta key", "beta", "sk-beta-plaintext"],
  ]) {
    await page.getByRole("button", { name: "New credential" }).click();
    await page.getByLabel("Label").fill(label);
    await page.getByLabel("Provider").fill(provider);
    await page.getByLabel("Value").fill(value);
    await page.getByRole("button", { name: "Encrypt & save" }).click();
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // 揭示请求慢慢返回,给"关掉再打开另一条"留出窗口
  await page.route("**/api/v1/credentials/*/reveal", async (route) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2000);
    await promise;
    await route.continue();
  });

  await page.getByRole("button", { name: "Reveal Alpha key" }).click();
  // 必须真的填密码,否则原生 required 会挡住提交,请求根本不会发出,竞态也就不存在
  await page.getByLabel("Administrator password").fill("correct-password");
  const revealResponse = page.waitForResponse((response) =>
    response.url().includes("/reveal") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Reveal once" }).click();

  // 请求在途:关掉 Alpha 的弹窗,改开 Beta 的
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reveal Beta key" }).click();
  await expect(page.getByLabel("Administrator password")).toBeVisible();

  // 等 Alpha 的响应真正落地(而不是靠固定睡眠):它的明文绝不能出现在 Beta 的弹窗里
  expect((await revealResponse).status()).toBe(200);
  await expect(page.getByText("sk-alpha-plaintext")).toHaveCount(0);
  await expect(page.getByLabel("Administrator password")).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
});
