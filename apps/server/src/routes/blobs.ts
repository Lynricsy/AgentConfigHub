import type { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";

import type { EncryptedBlobStore } from "../storage/encrypted-blob-store.js";

const MONACO_LIMIT = 2 * 1024 * 1024;

export function registerBlobRoutes(server: FastifyInstance, blobStore: EncryptedBlobStore): void {
  server.addContentTypeParser("*", (_request, payload, done) => {
    done(null, payload);
  });

  server.put("/api/v1/blobs", {
    bodyLimit: Number.MAX_SAFE_INTEGER,
  }, async (request, reply) => {
    const mediaType = request.headers["content-type"]?.split(";", 1)[0];
    const descriptor = await blobStore.put(request.body as Readable, mediaType);
    return reply.code(201).send({
      ...descriptor,
      monacoEligible: descriptor.size <= MONACO_LIMIT && (
        descriptor.mediaType?.startsWith("text/") === true ||
        descriptor.mediaType === "application/json" ||
        descriptor.mediaType === "application/yaml" ||
        descriptor.mediaType === "application/toml"
      ),
    });
  });

  server.get<{ Params: { sha256: string } }>("/api/v1/blobs/:sha256", async (request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .type("application/octet-stream")
      .send(await blobStore.open(request.params.sha256));
  });
}
