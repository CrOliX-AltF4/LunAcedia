import * as crypto from "crypto";
import * as fs from "fs";

// Ports LunAnima's source/module/secret_crypto.ts pattern (AES-256-GCM, same versioned
// prefix/format) — no shared package between the two repos (bridge pattern,
// docs/standards/02-architecture-ecosystem.md on the LunAnima side), so this is a deliberate
// copy, not an import, kept small enough that drift is easy to notice.

const ALGO    = "aes-256-gcm";
const KEY_LEN = 32; // AES-256
const IV_LEN  = 12; // recommended for GCM
const TAG_LEN = 16;
const PREFIX  = "enc:v1:";

/** Whether a raw stored value is one produced by encryptValue() (vs. still plaintext). */
export function isEncryptedValue(value: string): boolean {
    return value.startsWith(PREFIX);
}

export function encryptValue(plaintext: string, key: Buffer): string {
    const iv     = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptValue(encoded: string, key: Buffer): string {
    if (!isEncryptedValue(encoded)) {
        throw new Error(`decryptValue: value does not start with "${PREFIX}"`);
    }
    const raw        = Buffer.from(encoded.slice(PREFIX.length), "base64");
    const iv         = raw.subarray(0, IV_LEN);
    const tag        = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Reads the master key used by encryptValue()/decryptValue() — a 32-byte key, hex-encoded.
 * ACEDIA_MASTER_KEY_FILE (a path, e.g. mounted from a location outside the app's own data
 * volume) takes priority over ACEDIA_MASTER_KEY (the raw value), so the key can be kept out of
 * the same .env/volume as what it protects. Returns null when neither is configured (no
 * encryption in use — not an error on its own, see google_token_store.ts for the fail-closed
 * check that only applies once ACEDIA_TOKEN_ENCRYPTION_ENABLED=true).
 */
export function loadMasterKey(): Buffer | null {
    let hex: string | undefined;
    const keyFile = process.env["ACEDIA_MASTER_KEY_FILE"];
    if (keyFile) {
        try { hex = fs.readFileSync(keyFile, "utf8").trim(); } catch { hex = undefined; }
    }
    hex ??= process.env["ACEDIA_MASTER_KEY"];
    if (!hex) return null;

    const key = Buffer.from(hex, "hex");
    if (key.length !== KEY_LEN) {
        throw new Error(
            `ACEDIA_MASTER_KEY must be a ${KEY_LEN * 2}-character hex string (${KEY_LEN} bytes) — ` +
            `got ${key.length} bytes. Generate one with: openssl rand -hex ${KEY_LEN}`
        );
    }
    return key;
}
