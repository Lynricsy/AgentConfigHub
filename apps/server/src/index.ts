import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { openDatabase } from "./db/database.js";
import { migrateDatabase } from "./db/migrate.js";
import { registerBlobRoutes } from "./routes/blobs.js";
import { registerApiRoutes, type ApiDependencies } from "./routes/api.js";
import { loadMasterKey } from "./security/master-key.js";
import { AuthService } from "./services/auth-service.js";
import { parseTrustedProxies, validatePublicUrl, verifyLocalDataVolume } from "./runtime.js";
import { BlobGcService } from "./services/blob-gc-service.js";
import { ConfigSetService } from "./services/config-set-service.js";
import { CredentialService } from "./services/credential-service.js";
import { DeviceTokenService } from "./services/device-token-service.js";
import { PublishService } from "./services/publish-service.js";
import { ReleaseViewService } from "./services/release-view-service.js";
import { ResourceService } from "./services/resource-service.js";
import { SecretBindingResolver } from "./services/secret-binding-resolver.js";
import { SecretSlotService } from "./services/secret-slot-service.js";
import { FileEncryptedBlobStore, type EncryptedBlobStore } from "./storage/encrypted-blob-store.js";

const defaultWebRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface ServerDependencies {
  readonly blobStore?: EncryptedBlobStore;
  readonly api?: ApiDependencies;
  readonly health?: () => boolean | Promise<boolean>;
}
export interface ServerOptions {
  readonly trustProxy?: false | string[];
}

export function buildServer(
  dependencies: ServerDependencies = {},
  options: ServerOptions = {},
) {
  const server = Fastify({ logger: true, trustProxy: options.trustProxy ?? false });
  const webRoot = process.env.AGENT_CONFIG_HUB_WEB_ROOT ?? defaultWebRoot;
  const serveWeb = process.env.NODE_ENV === "production";

  if (dependencies.api) registerApiRoutes(server, dependencies.api);
  else if (dependencies.blobStore) registerBlobRoutes(server, dependencies.blobStore);

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

  server.get("/api/v1/health", async (_request, reply) => {
    try {
      if (dependencies.health && !await dependencies.health()) throw new Error("Server is not ready.");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

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
  const publicUrl = validatePublicUrl(process.env.AGENT_CONFIG_HUB_PUBLIC_URL);
  const trustedProxies = parseTrustedProxies(process.env.AGENT_CONFIG_HUB_TRUST_PROXY);
  const dataDir = process.env.AGENT_CONFIG_HUB_DATA_DIR ?? resolve("data");
  const masterKey = await loadMasterKey();
  const database = openDatabase(dataDir);
  try {
    migrateDatabase(database);
    await verifyLocalDataVolume(dataDir, database);
  } catch (error) {
    database.native.close();
    throw error;
  }
  const blobStore = new FileEncryptedBlobStore(database, masterKey, dataDir);
  const gc = new BlobGcService(database, blobStore);
  const auth = new AuthService(database, {
    ...(process.env.AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN
      ? { bootstrapToken: process.env.AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN }
      : {}),
  });
  const devices = new DeviceTokenService(database, publicUrl);
  const configSets = new ConfigSetService(database);
  const credentials = new CredentialService(database, masterKey);
  const resources = new ResourceService(database);
  const slots = new SecretSlotService(database);
  const publish = new PublishService(database, blobStore, new SecretBindingResolver(database, masterKey));
  const releases = new ReleaseViewService(database, blobStore);
  const server = buildServer({
    blobStore,
    health: () => {
      database.native.exec("BEGIN IMMEDIATE; ROLLBACK;");
      return true;
    },
    api: {
      database,
      auth,
      devices,
      configSets,
      blobStore,
      publicUrl,
      admin: {
        database,
        configSets,
        credentials,
        resources,
        slots,
        publish,
        releases,
        gc,
        verifyPassword: (password) => auth.verifyPassword(password),
      },
    },
  }, { trustProxy: trustedProxies });
  if (auth.setupCode) server.log.warn({ setupCode: auth.setupCode }, "initial setup code");

  const gcTimer = setInterval(() => {
    void gc.run().then(
      (result) => server.log.info(result, "daily blob GC completed"),
      (error: unknown) => server.log.error({ err: error }, "daily blob GC failed"),
    );
  }, 24 * 60 * 60 * 1000);
  gcTimer.unref();
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    server.log.info({ signal }, "graceful shutdown started");
    void server.close().catch((error: unknown) => {
      server.log.error({ err: error }, "graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  server.addHook("onClose", async () => {
    clearInterval(gcTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    database.native.close();
  });

  try {
    await server.listen({
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? 3000),
    });
  } catch (error) {
    clearInterval(gcTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    database.native.close();
    throw error;
  }
}
