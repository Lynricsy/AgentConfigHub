import { rm } from "node:fs/promises";
import { resolve } from "node:path";

export default async function globalSetup() {
  await rm(resolve(import.meta.dirname, "../../../../.tmp/e2e-data"), { force: true, recursive: true });
}
