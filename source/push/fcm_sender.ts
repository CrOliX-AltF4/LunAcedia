import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AcediaEvent, AcediaEventPriority } from "../types/acedia_event.js";

const FILTER_DEFAULT: AcediaEventPriority[] = ["urgent"];

function resolveTokenPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "fcm_token");
}

/**
 * Firebase Cloud Messaging sender for LunAcedia events.
 * Opt-in: returns null from fromEnv() when FIREBASE_* vars are absent.
 * Mono-user: stores a single device token in memory, persisted to disk across restarts.
 */
export class FcmSender {
    private token: string | null = null;
    private readonly filter: AcediaEventPriority[];
    private readonly tokenPath: string;

    constructor(filter?: AcediaEventPriority[], tokenPath?: string) {
        this.filter = filter ?? FILTER_DEFAULT;
        this.tokenPath = tokenPath ?? resolveTokenPath();
    }

    static fromEnv(): FcmSender | null {
        const projectId = process.env["FIREBASE_PROJECT_ID"];
        const keyB64 = process.env["FIREBASE_SERVICE_ACCOUNT_KEY"];
        if (!projectId || !keyB64) return null;

        let key: object;
        try {
            key = JSON.parse(Buffer.from(keyB64, "base64").toString("utf-8")) as object;
        } catch {
            console.error(
                "[FCM] FIREBASE_SERVICE_ACCOUNT_KEY is not valid base64 JSON — FCM disabled",
            );
            return null;
        }

        try {
            if (getApps().length === 0)
                initializeApp({ credential: cert(key as Parameters<typeof cert>[0]) });
        } catch (e) {
            console.error("[FCM] Firebase init error:", (e as Error).message);
            return null;
        }

        const rawFilter = process.env["ACEDIA_FCM_FILTER"] ?? "urgent";
        const filter = rawFilter
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is AcediaEventPriority => ["urgent", "normal", "info"].includes(s));

        return new FcmSender(filter.length > 0 ? filter : FILTER_DEFAULT);
    }

    /**
     * Load the persisted FCM token from disk (if any).
     * Call once at startup after fromEnv().
     */
    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.tokenPath, "utf-8");
            const token = raw.trim();
            if (token.length > 0) {
                this.token = token;
                console.warn("[FCM] Restored device token from disk");
            }
        } catch {
            // File absent or unreadable — no token, that's fine
        }
    }

    async setToken(token: string | null): Promise<void> {
        this.token = token;
        if (token === null) {
            try {
                await fs.unlink(this.tokenPath);
            } catch {
                // File may not exist — ignore
            }
        } else {
            try {
                await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
                await fs.writeFile(this.tokenPath, token, "utf-8");
            } catch (e) {
                console.error("[FCM] Failed to persist token:", (e as Error).message);
            }
        }
    }
    getToken(): string | null {
        return this.token;
    }

    async send(event: AcediaEvent): Promise<void> {
        if (!this.token) return;
        if (!this.filter.includes(event.priority)) return;

        try {
            await getMessaging().send({
                token: this.token,
                notification: {
                    title: `[${event.source}] ${event.title}`,
                    body: event.body ?? event.title,
                },
                data: {
                    type: event.type,
                    source: event.source,
                    dedupeKey: event.dedupeKey,
                    priority: event.priority,
                },
                // The item's key as the notification's tag: the phone takes it down once the item is read,
                // gone or (for "action-<id>") decided — wherever that happened.
                android: { priority: "high", notification: { tag: event.dedupeKey } },
            });
        } catch (e) {
            console.error("[FCM] send error:", (e as Error).message);
        }
    }

    private readonly toSettle = new Set<string>();
    private settleTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * An object a notification was about is settled (read, gone, decided, expired): the phone takes that notification
     * down, even closed — a data-only message, nothing shown (lot S). Gathered for 2 s, so a sync that settles a hundred
     * items sends one message; split so each stays far below FCM's 4 KB.
     */
    settle(tag: string): void {
        if (!this.token) return;
        this.toSettle.add(tag);
        this.settleTimer ??= setTimeout(() => void this.flushSettled(), SETTLE_GATHER_MS);
    }

    private async flushSettled(): Promise<void> {
        this.settleTimer = null;
        const tags = [...this.toSettle];
        this.toSettle.clear();
        const token = this.token;
        if (!token || tags.length === 0) return;
        const chunks: string[] = [];
        let current = "";
        for (const tag of tags) {
            const next = current ? `${current},${tag}` : tag;
            if (next.length > SETTLE_CHUNK_CHARS && current) {
                chunks.push(current);
                current = tag;
            } else current = next;
        }
        if (current) chunks.push(current);
        for (const chunk of chunks) {
            try {
                await getMessaging().send({
                    token,
                    data: { type: "settled", tags: chunk },
                    android: { priority: "high" },
                });
            } catch (e) {
                console.error("[FCM] settle error:", (e as Error).message);
            }
        }
    }
}

const SETTLE_GATHER_MS = 2_000;
const SETTLE_CHUNK_CHARS = 3_000;
