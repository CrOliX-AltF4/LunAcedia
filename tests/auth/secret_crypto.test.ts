import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { encryptValue, decryptValue, isEncryptedValue, loadMasterKey } from "../../source/auth/secret_crypto.js";

const KEY = randomBytes(32);

describe("encryptValue / decryptValue", () => {
    it("round-trips a plaintext string", () => {
        const encrypted = encryptValue("a-refresh-token", KEY);
        expect(decryptValue(encrypted, KEY)).toBe("a-refresh-token");
    });

    it("produces a value isEncryptedValue() recognizes", () => {
        expect(isEncryptedValue(encryptValue("x", KEY))).toBe(true);
        expect(isEncryptedValue("plain text")).toBe(false);
        expect(isEncryptedValue(JSON.stringify({ gmail: "rt" }))).toBe(false);
    });

    it("produces a different ciphertext each time (random IV)", () => {
        const a = encryptValue("same input", KEY);
        const b = encryptValue("same input", KEY);
        expect(a).not.toBe(b);
    });

    it("fails to decrypt with the wrong key", () => {
        const encrypted = encryptValue("secret", KEY);
        expect(() => decryptValue(encrypted, randomBytes(32))).toThrow();
    });

    it("decryptValue() rejects a value without the version prefix", () => {
        expect(() => decryptValue("not-encrypted", KEY)).toThrow(/does not start with/);
    });
});

describe("loadMasterKey", () => {
    const ORIGINAL_KEY = process.env["ACEDIA_MASTER_KEY"];
    const ORIGINAL_KEY_FILE = process.env["ACEDIA_MASTER_KEY_FILE"];

    beforeEach(() => {
        delete process.env["ACEDIA_MASTER_KEY"];
        delete process.env["ACEDIA_MASTER_KEY_FILE"];
    });

    afterEach(() => {
        if (ORIGINAL_KEY === undefined) delete process.env["ACEDIA_MASTER_KEY"]; else process.env["ACEDIA_MASTER_KEY"] = ORIGINAL_KEY;
        if (ORIGINAL_KEY_FILE === undefined) delete process.env["ACEDIA_MASTER_KEY_FILE"]; else process.env["ACEDIA_MASTER_KEY_FILE"] = ORIGINAL_KEY_FILE;
    });

    it("returns null when neither var is set", () => {
        expect(loadMasterKey()).toBeNull();
    });

    it("reads a valid 32-byte hex key from ACEDIA_MASTER_KEY", () => {
        process.env["ACEDIA_MASTER_KEY"] = randomBytes(32).toString("hex");
        const key = loadMasterKey();
        expect(key).not.toBeNull();
        expect(key!.length).toBe(32);
    });

    it("throws for a key of the wrong length", () => {
        process.env["ACEDIA_MASTER_KEY"] = randomBytes(16).toString("hex");
        expect(() => loadMasterKey()).toThrow(/32 bytes/);
    });
});
