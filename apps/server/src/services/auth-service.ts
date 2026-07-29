import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { hash, verify, argon2id } from "argon2";
import { ulid } from "ulid";

import type { DatabaseContext } from "../db/database.js";

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class AuthenticationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export class AuthService {
  readonly #database: DatabaseContext;
  readonly #setupCode: string;
  readonly #clock: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #ipFailures = new Map<string, number[]>();
  readonly #globalAttempts: number[] = [];

  constructor(
    database: DatabaseContext,
    options: {
      bootstrapToken?: string;
      clock?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.#database = database;
    this.#setupCode = options.bootstrapToken ?? randomBytes(20).toString("base64url");
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? (async (milliseconds) => {
      await delay(milliseconds);
    });
  }

  get setupCode(): string | null {
    const account = this.#database.native.prepare("SELECT id FROM admin_account LIMIT 1").get();
    return account ? null : this.#setupCode;

  }

  async setup(code: string, password: string): Promise<void> {
    if (password.length < 12) throw new AuthenticationError("PASSWORD_TOO_SHORT", "Password must contain at least 12 characters.");
    const expected = Buffer.from(this.#setupCode);
    const received = Buffer.from(code);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new AuthenticationError("SETUP_CODE_INVALID", "Setup code is invalid.");
    }
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
      salt: randomBytes(16),
    });
    const now = this.#clock();
    try {
      this.#database.native.transaction(() => {
        if (this.#database.native.prepare("SELECT 1 FROM admin_account LIMIT 1").get()) {
          throw new Error("setup complete");
        }
        this.#database.native.prepare(
          "INSERT INTO admin_account (id, password_hash, created_at, updated_at) VALUES ('singleton', ?, ?, ?)",
        ).run(passwordHash, now, now);
      })();
    } catch {
      throw new AuthenticationError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.");
    }
  }

  async login(password: string, ip: string): Promise<string> {
    const now = this.#clock();
    this.#pruneAttempts(now);
    if (this.#globalAttempts.length >= 20 || (this.#ipFailures.get(ip)?.length ?? 0) >= 5) {
      throw new AuthenticationError("RATE_LIMITED", "Too many login attempts.");
    }
    this.#globalAttempts.push(now);
    const account = this.#database.native.prepare("SELECT password_hash AS passwordHash FROM admin_account LIMIT 1")
      .get() as { passwordHash: string } | undefined;
    const valid = account ? await verify(account.passwordHash, password) : false;
    if (!valid) {
      const failures = this.#ipFailures.get(ip) ?? [];
      failures.push(now);
      this.#ipFailures.set(ip, failures);
      const delay = Math.min(2 ** Math.max(0, failures.length - 1) * 100, 2_000);
      await this.#sleep(delay);
      this.#audit("LOGIN_FAILED", null, ip);
      throw new AuthenticationError("INVALID_CREDENTIALS", "Invalid credentials.");
    }
    this.#ipFailures.delete(ip);
    const token = randomBytes(32).toString("base64url");
    this.#database.native.prepare(`
      INSERT INTO web_sessions (id, token_hash, created_at, last_used_at, expires_at, idle_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ulid(), sha256(token), now, now, now + SESSION_MAX_MS, now + SESSION_IDLE_MS);
    return token;
  }

  authenticateSession(token: string | undefined): boolean {
    if (!token) return false;
    const now = this.#clock();
    const session = this.#database.native.prepare(`
      SELECT id, expires_at AS expiresAt, idle_expires_at AS idleExpiresAt
      FROM web_sessions WHERE token_hash = ?
    `).get(sha256(token)) as { id: string; expiresAt: number; idleExpiresAt: number } | undefined;
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      if (session) this.#database.native.prepare("DELETE FROM web_sessions WHERE id = ?").run(session.id);
      return false;
    }
    this.#database.native.prepare(
      "UPDATE web_sessions SET last_used_at = ?, idle_expires_at = ? WHERE id = ?",
    ).run(now, Math.min(now + SESSION_IDLE_MS, session.expiresAt), session.id);
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.#database.native.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(token));
  }

  async verifyPassword(password: string): Promise<boolean> {
    const account = this.#database.native.prepare("SELECT password_hash AS passwordHash FROM admin_account LIMIT 1")
      .get() as { passwordHash: string } | undefined;
    return account ? await verify(account.passwordHash, password) : false;
  }

  async changePassword(currentPassword: string, newPassword: string, revokePullTokens: boolean): Promise<void> {
    if (!await this.verifyPassword(currentPassword)) throw new AuthenticationError("INVALID_CREDENTIALS", "Invalid credentials.");
    if (newPassword.length < 12) throw new AuthenticationError("PASSWORD_TOO_SHORT", "Password must contain at least 12 characters.");
    const passwordHash = await hash(newPassword, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
      salt: randomBytes(16),
    });
    this.#database.native.transaction(() => {
      this.#database.native.prepare("UPDATE admin_account SET password_hash = ?, updated_at = ?")
        .run(passwordHash, this.#clock());
      this.#database.native.prepare("DELETE FROM web_sessions").run();
      if (revokePullTokens) this.#database.native.prepare(
        "UPDATE pull_tokens SET revoked_at = ? WHERE revoked_at IS NULL",
      ).run(this.#clock());
      this.#audit("PASSWORD_CHANGED");
    })();
  }

  #pruneAttempts(now: number): void {
    const globalCutoff = now - 60_000;
    while ((this.#globalAttempts[0] ?? Number.POSITIVE_INFINITY) < globalCutoff) this.#globalAttempts.shift();
    const ipCutoff = now - 15 * 60_000;
    for (const [ip, attempts] of this.#ipFailures) {
      const current = attempts.filter((attempt) => attempt >= ipCutoff);
      if (current.length === 0) this.#ipFailures.delete(ip);
      else this.#ipFailures.set(ip, current);
    }
  }

  #audit(kind: string, subjectId: string | null = null, label: string | null = null): void {
    this.#database.native.prepare(
      "INSERT INTO audit_events (id, kind, subject_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ulid(), kind, subjectId, label, this.#clock());
  }
}
