import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { openDatabase } from "./db/database.js";
import { migrateDatabase } from "./db/migrate.js";

const defaultWebRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function buildServer() {
  const server = Fastify({ logger: true });
  const webRoot = process.env.AGENT_CONFIG_HUB_WEB_ROOT ?? defaultWebRoot;
  const serveWeb = process.env.NODE_ENV === "production";

  if (serveWeb) {
    server.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: false,
    });

    server.addHook("onReady", async () => {
      await access(`${webRoot}/index.html`);
    });
  }

  server.get("/api/v1/health", async () => ({ status: "ok" }));

  server.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "The requested API route does not exist.",
          requestId: request.id,
        },
      });
    }

    if (serveWeb && request.method === "GET") {
      return reply.type("text/html").sendFile("index.html");
    }

    return reply.code(404).type("text/plain").send("Not found.");
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = openDatabase();
  migrateDatabase(database);
  const server = buildServer();
  server.addHook("onClose", async () => {
    database.native.close();
  });

  try {
    await server.listen({
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? 3000),
    });
  } catch (error) {
    database.native.close();
    throw error;
  }
}
