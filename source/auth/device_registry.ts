/**
 * Paired devices (ADR-020 M3, D3): each phone gets its OWN token, limited to the mobile routes, revocable — the master
 * secret (ACEDIA_SECRET) never leaves the server again.
 *
 *   - Pairing: an admin asks for a code (8 characters, one use, 10 minutes); the app sends it with a name and receives
 *     its token once. Five wrong codes invalidate every open code (brute force costs the attacker the codes).
 *   - A token is 256 random bits; only its SHA-256 is kept (like MyBrain's app keys — a random secret needs no slow
 *     hash). It is shown once, never logged.
 *   - Revoking a device refuses its token at once. A device silent for 90 days is revoked on the next sweep.
 *
 * Kept in STORAGE_DIR/devices.json (atomic rewrite); without a file, in memory (tests).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_FAILED_PAIRINGS = 5;
export const INACTIVE_REVOKE_MS = 90 * 24 * 60 * 60 * 1000;
/** Last-seen is written at most this often per device — a busy phone must not rewrite the file on every request. */
const SEEN_WRITE_EVERY_MS = 60 * 60 * 1000;
/** No 0/O, 1/I/L: a code read on one screen and typed on another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_PREFIX = "acd_dev_";

export interface Device {
    id: string;
    name: string;
    createdAt: string;
    lastSeenAt: string;
    /** The FCM token this device registered, if any. */
    pushToken?: string;
}

interface StoredDevice extends Device {
    tokenHash: string;
}

export interface DeviceJournalLine {
    at: string;
    op: "pair" | "revoke" | "expire" | "pair_refused";
    deviceId?: string;
    name?: string;
    reason?: string;
}

interface PairingCode {
    code: string;
    expiresAt: number;
}

export type PairResult =
    | { ok: true; device: Device; token: string }
    | { ok: false; reason: "invalid_or_expired" | "name_required" };

export function defaultDevicesPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "devices.json");
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A device as it may be shown — never its token hash. */
function publicOf(d: StoredDevice): Device {
    return {
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        ...(d.pushToken !== undefined && { pushToken: d.pushToken }),
    };
}

function sameHex(a: string, b: string): boolean {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && timingSafeEqual(x, y);
}

function newCode(): string {
    const bytes = randomBytes(PAIRING_CODE_LENGTH);
    let code = "";
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return code;
}

export function normalizeCode(raw: string): string {
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const JOURNAL_CAP = 500;

export class DeviceRegistry {
    private devices: StoredDevice[] = [];
    private journalLines: DeviceJournalLine[] = [];
    private codes: PairingCode[] = [];
    private failedPairings = 0;
    private readonly seenWritten = new Map<string, number>();
    private saving: Promise<void> = Promise.resolve();

    constructor(
        private readonly filePath?: string,
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as {
                devices?: StoredDevice[];
                journal?: DeviceJournalLine[];
            };
            this.devices = Array.isArray(raw.devices) ? raw.devices : [];
            this.journalLines = Array.isArray(raw.journal) ? raw.journal : [];
        } catch {
            // Missing or unreadable: no paired device (the admin secret still works).
        }
    }

    /** Paired devices, without anything secret. */
    list(): Device[] {
        return this.devices.map(publicOf);
    }

    journal(): DeviceJournalLine[] {
        return [...this.journalLines].reverse();
    }

    /** A fresh pairing code. Earlier open codes stay valid until they expire. */
    createPairingCode(): PairingCode {
        this.dropExpiredCodes();
        const code: PairingCode = { code: newCode(), expiresAt: this.now() + PAIRING_CODE_TTL_MS };
        this.codes.push(code);
        this.failedPairings = 0;
        return { ...code };
    }

    async pair(rawCode: string, rawName: string): Promise<PairResult> {
        this.dropExpiredCodes();
        const name = rawName.trim().slice(0, 60);
        if (!name) return { ok: false, reason: "name_required" };
        const code = normalizeCode(rawCode);
        const i = this.codes.findIndex((c) => c.code === code);
        if (i < 0) {
            this.failedPairings += 1;
            if (this.failedPairings >= MAX_FAILED_PAIRINGS) {
                this.codes = [];
                this.failedPairings = 0;
                this.record({
                    op: "pair_refused",
                    reason: "too many wrong codes — every open code revoked",
                });
                await this.save();
            }
            return { ok: false, reason: "invalid_or_expired" };
        }
        this.codes.splice(i, 1);
        const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        const at = new Date(this.now()).toISOString();
        const stored: StoredDevice = {
            id: randomUUID(),
            name,
            createdAt: at,
            lastSeenAt: at,
            tokenHash: hashToken(token),
        };
        this.devices.push(stored);
        this.record({ op: "pair", deviceId: stored.id, name });
        await this.save();
        return { ok: true, device: publicOf(stored), token };
    }

    /** The device a bearer token belongs to, or null. Notes the device as seen. */
    authenticate(bearer: string | undefined): Device | null {
        if (!bearer || !bearer.startsWith(TOKEN_PREFIX)) return null;
        const hash = hashToken(bearer);
        const found = this.devices.find((d) => sameHex(d.tokenHash, hash));
        if (!found) return null;
        const t = this.now();
        found.lastSeenAt = new Date(t).toISOString();
        if (t - (this.seenWritten.get(found.id) ?? 0) >= SEEN_WRITE_EVERY_MS) {
            this.seenWritten.set(found.id, t);
            void this.save();
        }
        return publicOf(found);
    }

    async revoke(id: string, reason: "revoke" | "expire" = "revoke"): Promise<Device | null> {
        const i = this.devices.findIndex((d) => d.id === id);
        if (i < 0) return null;
        const [removed] = this.devices.splice(i, 1);
        this.seenWritten.delete(id);
        this.record({ op: reason, deviceId: removed!.id, name: removed!.name });
        await this.save();
        return publicOf(removed!);
    }

    async setPushToken(id: string, pushToken: string | null): Promise<void> {
        const d = this.devices.find((x) => x.id === id);
        if (!d) return;
        if (pushToken) d.pushToken = pushToken;
        else delete d.pushToken;
        await this.save();
    }

    /** Revokes the devices silent for 90 days. Returns them. */
    async sweepInactive(): Promise<Device[]> {
        const limit = this.now() - INACTIVE_REVOKE_MS;
        const stale = this.devices.filter((d) => Date.parse(d.lastSeenAt) < limit).map((d) => d.id);
        const out: Device[] = [];
        for (const id of stale) {
            const d = await this.revoke(id, "expire");
            if (d) out.push(d);
        }
        return out;
    }

    flush(): Promise<void> {
        return this.saving;
    }

    private dropExpiredCodes(): void {
        const t = this.now();
        this.codes = this.codes.filter((c) => c.expiresAt > t);
    }

    private record(line: Omit<DeviceJournalLine, "at">): void {
        this.journalLines.push({ at: new Date(this.now()).toISOString(), ...line });
        if (this.journalLines.length > JOURNAL_CAP)
            this.journalLines.splice(0, this.journalLines.length - JOURNAL_CAP);
    }

    private save(): Promise<void> {
        if (!this.filePath) return Promise.resolve();
        const file = this.filePath;
        this.saving = this.saving.then(async () => {
            try {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const content = JSON.stringify(
                    { devices: this.devices, journal: this.journalLines },
                    null,
                    2,
                );
                await fs.writeFile(`${file}.tmp`, content, { encoding: "utf-8", mode: 0o600 });
                await fs.rename(`${file}.tmp`, file);
            } catch (err) {
                console.warn("[Devices] could not persist the devices:", (err as Error).message);
            }
        });
        return this.saving;
    }
}
