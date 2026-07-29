import { createHash, randomBytes } from "node:crypto";

import { ulid } from "ulid";

import type { DatabaseContext } from "../db/database.js";
import { AuthenticationError } from "./auth-service.js";

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomUserCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

export class DeviceTokenService {
  readonly #database: DatabaseContext;
  readonly #pollRequests = new Map<string, number[]>();
  readonly #pendingPolls = new Map<string, number>();
  readonly #publicUrl: string;
  readonly #clock: () => number;
  readonly #requests = new Map<string, number[]>();
  #lastRatePrune = 0;

  constructor(database: DatabaseContext, publicUrl: string, clock: () => number = Date.now) {
    this.#database = database;
    this.#publicUrl = publicUrl.replace(/\/$/, "");
    this.#clock = clock;
  }

  createAuthorization(input: { deviceName: string; cliVersion: string; ip: string }) {
    const now = this.#clock();
    this.#pruneRateLimits(now);
    const attempts = (this.#requests.get(input.ip) ?? []).filter((attempt) => attempt >= now - 60_000);
    if (attempts.length >= 10) throw new AuthenticationError("RATE_LIMITED", "Too many device authorization requests.");
    const pending = this.#database.native.prepare(`
      SELECT COUNT(*) AS count FROM device_authorizations
      WHERE requester_ip = ? AND status = 'pending' AND expires_at > ?
    `).get(input.ip, now) as { count: number };
    if (pending.count >= 5) throw new AuthenticationError("RATE_LIMITED", "Too many pending device authorizations.");
    attempts.push(now);
    this.#requests.set(input.ip, attempts);
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode = randomUserCode();
    while (this.#database.native.prepare("SELECT 1 FROM device_authorizations WHERE user_code = ?").get(userCode)) {
      userCode = randomUserCode();
    }
    this.#database.native.prepare(`
      INSERT INTO device_authorizations (
        id, device_code_hash, user_code, device_name, cli_version,
        requester_ip, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      ulid(), sha256(deviceCode), userCode, input.deviceName, input.cliVersion,
      input.ip, now, now + DEVICE_CODE_TTL_MS,
    );
    return {
      deviceCode,
      userCode,
      verificationUri: `${this.#publicUrl}/devices/approve?code=${userCode}`,
      expiresIn: 600,
      interval: 5,
    };
  }

  approve(userCode: string): void {
    const now = this.#clock();
    const update = this.#database.native.prepare(`
      UPDATE device_authorizations SET status = 'approved', approved_at = ?
      WHERE user_code = ? AND status = 'pending' AND expires_at > ?
    `).run(now, userCode.toUpperCase(), now);
    if (update.changes !== 1) throw new AuthenticationError("DEVICE_CODE_INVALID", "Device code is invalid or expired.");
    this.#audit("DEVICE_APPROVED", null, userCode.toUpperCase());
  }

  poll(deviceCode: string, ip: string): string {
    const now = this.#clock();
    const attempts = (this.#pollRequests.get(ip) ?? []).filter((attempt) => attempt >= now - 60_000);
    this.#pruneRateLimits(now);
    if (attempts.length >= 120) throw new AuthenticationError("RATE_LIMITED", "Too many device token polls.");
    attempts.push(now);
    this.#pollRequests.set(ip, attempts);
    const deviceCodeHash = sha256(deviceCode);
    return this.#database.native.transaction(() => {
      const transactionNow = this.#clock();
      const authorization = this.#database.native.prepare(`
        SELECT id, device_name AS deviceName, status, expires_at AS expiresAt
        FROM device_authorizations WHERE device_code_hash = ?
      `).get(deviceCodeHash) as {
        id: string;
        deviceName: string;
        status: "pending" | "approved" | "consumed";
        expiresAt: number;
      } | undefined;
      if (!authorization) throw new AuthenticationError("DEVICE_CODE_INVALID", "Device code is invalid.");
      if (authorization.expiresAt <= transactionNow) {
        throw new AuthenticationError("DEVICE_CODE_EXPIRED", "Device code has expired.");
      }
      if (authorization.status === "pending") {
        const previous = this.#pendingPolls.get(deviceCodeHash);
        if (previous !== undefined && transactionNow - previous < 4_500) {
          throw new AuthenticationError("SLOW_DOWN", "Device token polling is too frequent.");
        }
        this.#pendingPolls.set(deviceCodeHash, transactionNow);
        throw new AuthenticationError("AUTHORIZATION_PENDING", "Authorization is pending.");
      }
      if (authorization.status === "consumed") {
        throw new AuthenticationError("DEVICE_CODE_CONSUMED", "Device code has already been consumed.");
      }
      this.#pendingPolls.delete(deviceCodeHash);
      const token = `agch_dev_${randomBytes(32).toString("base64url")}`;
      const tokenId = ulid();
      this.#database.native.prepare(`
        INSERT INTO pull_tokens (id, kind, label, token_prefix, token_hash, created_at)
        VALUES (?, 'device', ?, ?, ?, ?)
      `).run(tokenId, authorization.deviceName, token.slice(0, 17), sha256(token), transactionNow);
      this.#database.native.prepare(
        "UPDATE device_authorizations SET status = 'consumed', consumed_at = ? WHERE id = ?",
      ).run(transactionNow, authorization.id);
      return token;
    })();
  }

  createAutomationToken(label: string): { id: string; token: string; prefix: string } {
    const token = `agch_auto_${randomBytes(32).toString("base64url")}`;
    const id = ulid();
    const prefix = token.slice(0, 18);
    this.#database.native.prepare(`
      INSERT INTO pull_tokens (id, kind, label, token_prefix, token_hash, created_at)
      VALUES (?, 'automation', ?, ?, ?, ?)
    `).run(id, label, prefix, sha256(token), this.#clock());
    this.#audit("AUTOMATION_TOKEN_CREATED", id, label);
    return { id, token, prefix };
  }

  authenticate(token: string | undefined): { id: string; kind: "device" | "automation" } | null {
    if (!token || (!token.startsWith("agch_dev_") && !token.startsWith("agch_auto_"))) return null;
    const row = this.#database.native.prepare(
      "SELECT id, kind FROM pull_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    ).get(sha256(token)) as { id: string; kind: "device" | "automation" } | undefined;
    if (!row) return null;
    this.#database.native.prepare("UPDATE pull_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.#clock(), row.id);
    return row;
  }

  revoke(tokenId: string): void {
    this.#database.native.transaction(() => {
      const update = this.#database.native.prepare(
        "UPDATE pull_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).run(this.#clock(), tokenId);
      if (update.changes !== 1) throw new Error(`Token ${tokenId} is already revoked or missing.`);
      this.#audit("PULL_TOKEN_REVOKED", tokenId);
    })();
  }

  rateLimitEntryCounts(): { authorizationIps: number; pollIps: number; pendingCodes: number } {
    return {
      authorizationIps: this.#requests.size,
      pollIps: this.#pollRequests.size,
      pendingCodes: this.#pendingPolls.size,
    };
  }

  list() {
    return this.#database.native.prepare(`
      SELECT id, kind, label, token_prefix AS prefix, created_at AS createdAt,
        last_used_at AS lastUsedAt, revoked_at AS revokedAt
      FROM pull_tokens ORDER BY created_at DESC
    `).all();
  }

  #pruneRateLimits(now: number): void {
    if (now - this.#lastRatePrune < 60_000) return;
    this.#lastRatePrune = now;
    for (const [ip, attempts] of this.#requests) {
      const current = attempts.filter((attempt) => attempt >= now - 60_000);
      if (current.length === 0) this.#requests.delete(ip);
      else this.#requests.set(ip, current);
    }
    for (const [ip, attempts] of this.#pollRequests) {
      const current = attempts.filter((attempt) => attempt >= now - 60_000);
      if (current.length === 0) this.#pollRequests.delete(ip);
      else this.#pollRequests.set(ip, current);
    }
    for (const [deviceCodeHash, lastPoll] of this.#pendingPolls) {
      if (lastPoll < now - DEVICE_CODE_TTL_MS) this.#pendingPolls.delete(deviceCodeHash);
    }
  }

  #audit(kind: string, subjectId: string | null, label: string | null = null): void {
    this.#database.native.prepare(
      "INSERT INTO audit_events (id, kind, subject_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ulid(), kind, subjectId, label, this.#clock());
  }
}
