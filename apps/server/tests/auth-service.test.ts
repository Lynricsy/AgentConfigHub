import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { AuthService } from "../src/services/auth-service.js";

describe("AuthService", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("allows exactly one concurrent setup and stores the required Argon2id parameters", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-auth-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const auth = new AuthService(database, { bootstrapToken: "bootstrap-code" });
    const results = await Promise.allSettled([
      auth.setup("bootstrap-code", "long-password-one"),
      auth.setup("bootstrap-code", "long-password-two"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM admin_account").get()).toEqual({ count: 1 });
    const row = database.native.prepare("SELECT password_hash AS passwordHash FROM admin_account")
      .get() as { passwordHash: string };
    expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(auth.setupCode).toBeNull();
    database.native.close();
  });

  it("rate-limits repeated invalid passwords without distinguishing account state", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-login-limit-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const auth = new AuthService(database, {
      bootstrapToken: "bootstrap-code",
      clock: () => 1_000_000,
      sleep: async () => {},
    });
    await auth.setup("bootstrap-code", "correct-password");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login("wrong-password", "192.0.2.1")).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
      });
    }
    await expect(auth.login("wrong-password", "192.0.2.1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    database.native.close();
  });
});
