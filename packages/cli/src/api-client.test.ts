import { describe, expect, it } from "vitest";

import { ApiClient } from "./api-client.js";

describe("ApiClient device polling", () => {
  it("treats HTTP 202 as authorization pending instead of a token response", async () => {
    const request = async () => new Response(JSON.stringify({
      error: {
        code: "AUTHORIZATION_PENDING",
        message: "Authorization is pending.",
        requestId: "request-1",
      },
    }), { status: 202, headers: { "Content-Type": "application/json" } });
    const client = new ApiClient("https://hub.example", undefined, request as typeof fetch);
    await expect(client.pollDeviceAuthorization("device-code")).rejects.toMatchObject({
      code: "AUTHORIZATION_PENDING",
      status: 202,
    });
  });
});
