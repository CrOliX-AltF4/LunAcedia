import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { AcediaEvent, AcediaEventPriority } from "../types/acedia_event.js";

const FILTER_DEFAULT: AcediaEventPriority[] = ["urgent"];

/**
 * Firebase Cloud Messaging sender for LunAcedia events.
 * Opt-in: returns null from fromEnv() when FIREBASE_* vars are absent.
 * Mono-user: stores a single device token in memory.
 */
export class FcmSender {
    private token: string | null = null;
    private readonly filter: AcediaEventPriority[];

    constructor(filter?: AcediaEventPriority[]) {
        this.filter = filter ?? FILTER_DEFAULT;
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

    setToken(token: string | null): void {
        this.token = token;
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
                android: { priority: "high" },
            });
        } catch (e) {
            console.error("[FCM] send error:", (e as Error).message);
        }
    }
}
