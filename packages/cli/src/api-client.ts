import { z } from "zod";

import { ApiError, ReleaseManifestV1, type AgentId, type ReleaseManifestV1 as Manifest } from "@agent-config-hub/protocol";

const DeviceAuthorization = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const DeviceToken = z.object({ token: z.string().min(1) });
const ConfigSetList = z.array(z.object({ name: z.string(), slug: z.string() }));

export class CliApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "CliApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new Error("Server URL must use http or https.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Server URL cannot contain credentials, query, or fragment.");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

async function checked(
  response: Response,
  accepted: (response: Response) => boolean = (candidate) => candidate.ok,
): Promise<Response> {
  if (accepted(response)) return response;
  let parsed: z.infer<typeof ApiError> | undefined;
  try { parsed = ApiError.parse(await response.json()); } catch { /* Preserve the HTTP fallback. */ }
  throw new CliApiError(
    response.status,
    parsed?.error.code ?? "HTTP_ERROR",
    parsed?.error.message ?? `Server returned HTTP ${response.status}.`,
    parsed?.error.requestId,
  );
}

export class ApiClient {
  readonly #server: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(server: string, token?: string, request: typeof fetch = fetch) {
    this.#server = normalizeServerUrl(server);
    this.#token = token;
    this.#fetch = request;
  }

  async createDeviceAuthorization(deviceName: string, cliVersion: string) {
    const response = await checked(await this.#fetch(`${this.#server}/api/v1/device-authorizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName, cliVersion }),
    }));
    return DeviceAuthorization.parse(await response.json());
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<string> {
    const response = await checked(await this.#fetch(`${this.#server}/api/v1/device-authorizations/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    }), (candidate) => candidate.status === 200);
    return DeviceToken.parse(await response.json()).token;
  }

  async configSets(): Promise<readonly { name: string; slug: string }[]> {
    return ConfigSetList.parse(await (await this.#authorized("/api/v1/cli/config-sets")).json());
  }

  async manifest(slug: string, agents: readonly AgentId[]): Promise<Manifest> {
    const query = agents.length > 0 ? `?agents=${encodeURIComponent(agents.join(","))}` : "";
    return ReleaseManifestV1.parse(await (
      await this.#authorized(`/api/v1/cli/config-sets/${encodeURIComponent(slug)}/releases/latest${query}`)
    ).json());
  }

  async releaseFile(releaseId: string, fileId: string): Promise<Response> {
    return await this.#authorized(
      `/api/v1/cli/releases/${encodeURIComponent(releaseId)}/files/${encodeURIComponent(fileId)}`,
    );
  }

  async #authorized(path: string): Promise<Response> {
    if (!this.#token) throw new Error("No pull token is configured. Run login first.");
    return await checked(await this.#fetch(`${this.#server}${path}`, {
      headers: { Authorization: `Bearer ${this.#token}` },
    }));
  }
}
