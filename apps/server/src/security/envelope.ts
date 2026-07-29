import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { MasterKey } from "./master-key.js";

const FORMAT_VERSION = 1;

export interface EnvelopeIdentity {
  readonly recordType: "blob" | "credential";
  readonly recordId: string;
}

export interface WrappedDek {
  readonly keyId: string;
  readonly wrappedDek: string;
  readonly wrapNonce: string;
  readonly wrapTag: string;
}

export interface ContentEncryption {
  readonly contentNonce: string;
  readonly contentTag: string;
}

export function contentAad(identity: EnvelopeIdentity): Buffer {
  return Buffer.from(JSON.stringify({ version: FORMAT_VERSION, ...identity }), "utf8");
}

function wrapAad(identity: EnvelopeIdentity, sha256: string, size: number): Buffer {
  return Buffer.from(JSON.stringify({ version: FORMAT_VERSION, ...identity, sha256, size }), "utf8");
}

export function wrapDek(
  masterKey: MasterKey,
  dek: Buffer,
  identity: EnvelopeIdentity,
  sha256: string,
  size: number,
): WrappedDek {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey.bytes, nonce);
  cipher.setAAD(wrapAad(identity, sha256, size));
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    keyId: masterKey.keyId,
    wrappedDek: encrypted.toString("base64"),
    wrapNonce: nonce.toString("base64"),
    wrapTag: cipher.getAuthTag().toString("base64"),
  };
}

export function unwrapDek(
  masterKey: MasterKey,
  wrapped: WrappedDek,
  identity: EnvelopeIdentity,
  sha256: string,
  size: number,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", masterKey.bytes, Buffer.from(wrapped.wrapNonce, "base64"));
  decipher.setAAD(wrapAad(identity, sha256, size));
  decipher.setAuthTag(Buffer.from(wrapped.wrapTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(wrapped.wrappedDek, "base64")), decipher.final()]);
}

export function encryptBuffer(
  plaintext: Buffer,
  masterKey: MasterKey,
  identity: EnvelopeIdentity,
  sha256: string,
): { ciphertext: Buffer; content: ContentEncryption; wrapped: WrappedDek } {
  const dek = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(contentAad(identity));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    content: {
      contentNonce: nonce.toString("base64"),
      contentTag: cipher.getAuthTag().toString("base64"),
    },
    wrapped: wrapDek(masterKey, dek, identity, sha256, plaintext.length),
  };
}

export function decryptBuffer(
  ciphertext: Buffer,
  masterKey: MasterKey,
  identity: EnvelopeIdentity,
  sha256: string,
  size: number,
  content: ContentEncryption,
  wrapped: WrappedDek,
): Buffer {
  const dek = unwrapDek(masterKey, wrapped, identity, sha256, size);
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(content.contentNonce, "base64"));
  decipher.setAAD(contentAad(identity));
  decipher.setAuthTag(Buffer.from(content.contentTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length !== size) throw new Error("Envelope plaintext size mismatch.");
  return plaintext;
}
