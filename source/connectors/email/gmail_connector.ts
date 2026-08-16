import type { IConnector } from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getAccessToken, clearTokenCache } from "./gmail_auth.js";
import { parseRules, classifyEmail } from "./email_rules.js";
import type { EmailRule } from "./email_rules.js";
import type { EmailClassificationStore } from "./email_classification_store.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface MessageHeader {
    name: string;
    value: string;
}
interface GmailMessageMeta {
    id: string;
    threadId: string;
    internalDate: string;
    payload: { headers: MessageHeader[] };
}

/**
 * Polls Gmail INBOX for unread messages and classifies them by configurable rules.
 *
 * Config (in .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — OAuth2 credentials
 *                — GMAIL_REFRESH_TOKEN is a fallback; ignored once GoogleTokenStore has one
 *                  for "gmail" (obtained via GET /api/oauth/google/start?connector=gmail)
 *   GMAIL_MAX_AGE_HOURS=24            — ignore messages older than N hours
 *   GMAIL_POLL_INTERVAL_MIN=5         — poll frequency
 *   GMAIL_RULES='[{"senderPattern":"boss@corp.com","priority":"urgent"}]'
 *                — fallback only; ignored once EmailClassificationStore has anything configured
 *
 * Rule: classification by senderPattern substring match only — never by LLM.
 */
export class GmailConnector implements IConnector {
    readonly slug: ConnectorSlug = "email";
    get name(): string {
        return CONNECTOR_REGISTRY[this.slug].label;
    }
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly staticRefreshToken: string;
    private readonly maxAgeMs: number;
    /** Legacy fallback, parsed once from GMAIL_RULES at construction. */
    private readonly staticRules: EmailRule[];
    private readonly classificationStore?: EmailClassificationStore;
    private readonly tokenStore?: GoogleTokenStore;

    constructor(classificationStore?: EmailClassificationStore, tokenStore?: GoogleTokenStore) {
        this.classificationStore = classificationStore;
        this.tokenStore = tokenStore;
        this.clientId = process.env["GMAIL_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GMAIL_CLIENT_SECRET"] ?? "";
        this.staticRefreshToken = process.env["GMAIL_REFRESH_TOKEN"] ?? "";

        const intervalMin = parseInt(process.env["GMAIL_POLL_INTERVAL_MIN"] ?? "5", 10);
        this.preferredPollIntervalMs = Math.max(2, intervalMin) * 60_000;

        const maxAgeHours = parseInt(process.env["GMAIL_MAX_AGE_HOURS"] ?? "24", 10);
        this.maxAgeMs = Math.max(1, maxAgeHours) * 3_600_000;

        this.staticRules = parseRules(process.env["GMAIL_RULES"] ?? "[]");

        // GMAIL_ENABLED=true gates whether this connector is even constructed — if we're here
        // without credentials AND no stored token, that's a real misconfiguration, not an
        // intentional disable. poll() silently returning [] every cycle gave no visibility.
        if (!this.clientId || !this.clientSecret || !this.refreshToken()) {
            console.warn(
                "[Gmail] GMAIL_ENABLED=true but client_id/client_secret/refresh_token are incomplete — poll() will return nothing until fixed (or connect via the dashboard).",
            );
        }
    }

    /** Read fresh, not cached — a token obtained through the OAuth flow after startup takes
     *  effect on the very next poll, no restart needed (same reasoning as classificationStore). */
    private refreshToken(): string {
        return this.tokenStore?.get("gmail") ?? this.staticRefreshToken;
    }

    async poll(): Promise<AcediaEvent[]> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return [];

        let token: string;
        try {
            token = await getAccessToken(this.clientId, this.clientSecret, refreshToken);
        } catch (e) {
            console.error("[Gmail] token refresh error:", (e as Error).message);
            return [];
        }

        const authHeaders = { Authorization: `Bearer ${token}` };
        const cutoff = Date.now() - this.maxAgeMs;

        let ids: string[];
        try {
            const resp = await fetch(
                `${GMAIL_API}/messages?q=is:unread+label:inbox&maxResults=50`,
                { headers: authHeaders },
            );
            if (!resp.ok) {
                if (resp.status === 401) clearTokenCache();
                console.warn(`[Gmail] list messages returned ${resp.status}`);
                return [];
            }
            const data = (await resp.json()) as { messages?: Array<{ id: string }> };
            ids = (data.messages ?? []).map((m) => m.id);
        } catch (e) {
            console.error("[Gmail] list error:", (e as Error).message);
            return [];
        }

        const events: AcediaEvent[] = [];
        for (const id of ids) {
            try {
                const resp = await fetch(
                    `${GMAIL_API}/messages/${id}?format=metadata` +
                        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                    { headers: authHeaders },
                );
                if (!resp.ok) continue;

                const msg = (await resp.json()) as GmailMessageMeta;
                const header = (name: string) =>
                    msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
                        ?.value ?? "";

                const ts = parseInt(msg.internalDate, 10);
                if (ts < cutoff) continue;

                const from = header("From");
                const subject = header("Subject") || "(no subject)";
                const rules = this.classificationStore?.isConfigured()
                    ? this.classificationStore.compileRules()
                    : this.staticRules;
                const priority = classifyEmail(from, subject, rules);

                events.push({
                    type: "email.received",
                    ts,
                    source: "email",
                    title: subject,
                    body: from,
                    priority,
                    dedupeKey: `email-${id}`,
                    meta: { from, messageId: id, threadId: msg.threadId },
                });
            } catch {
                // skip individual message errors silently
            }
        }

        return events;
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (
            action.kind !== "reply" &&
            action.kind !== "archive_email" &&
            action.kind !== "delete_email" &&
            action.kind !== "mark_email_read" &&
            action.kind !== "mark_email_unread"
        ) {
            return;
        }
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return;

        let token: string;
        try {
            token = await getAccessToken(this.clientId, this.clientSecret, refreshToken);
        } catch (e) {
            console.error("[Gmail] action token error:", (e as Error).message);
            return;
        }

        if (
            action.kind === "archive_email" ||
            action.kind === "delete_email" ||
            action.kind === "mark_email_read" ||
            action.kind === "mark_email_unread"
        ) {
            await this.modifyMessage(token, action.kind, action.sourceId);
            return;
        }

        // Fetch original message to get threadId + headers for proper reply
        let threadId: string;
        let toAddress: string;
        let subject: string;
        let messageId: string;
        try {
            const resp = await fetch(
                `${GMAIL_API}/messages/${action.sourceId}?format=metadata` +
                    `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-Id`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!resp.ok) {
                console.warn(
                    `[Gmail] reply: fetch message ${action.sourceId} returned ${resp.status}`,
                );
                return;
            }
            const msg = (await resp.json()) as GmailMessageMeta & {
                payload: { headers: MessageHeader[] };
            };
            threadId = msg.threadId;
            const h = (n: string) =>
                msg.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ??
                "";
            toAddress = h("From");
            subject = h("Subject") ? `Re: ${h("Subject")}` : "Re:";
            messageId = h("Message-Id");
        } catch (e) {
            console.error("[Gmail] reply: fetch error:", (e as Error).message);
            return;
        }

        // Build minimal MIME reply
        const mime = [
            `From: me`,
            `To: ${toAddress}`,
            `Subject: ${subject}`,
            `In-Reply-To: ${messageId}`,
            `References: ${messageId}`,
            `Content-Type: text/plain; charset=utf-8`,
            ``,
            action.body,
        ].join("\r\n");

        const raw = Buffer.from(mime).toString("base64url");

        try {
            const resp = await fetch(`${GMAIL_API}/messages/send`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ raw, threadId }),
            });
            if (!resp.ok) {
                console.warn(`[Gmail] reply send returned ${resp.status}`);
            }
        } catch (e) {
            console.error("[Gmail] reply send error:", (e as Error).message);
        }
    }

    /** archive/delete/mark-read/mark-unread all reduce to a Gmail label mutation.
     *  delete_email moves to Trash (recoverable, not a permanent delete) — matches what
     *  "delete" means in a normal Gmail client. */
    private async modifyMessage(
        token: string,
        kind: "archive_email" | "delete_email" | "mark_email_read" | "mark_email_unread",
        messageId: string,
    ): Promise<void> {
        const endpoint = kind === "delete_email" ? "trash" : "modify";
        const body: { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined =
            kind === "archive_email"
                ? { removeLabelIds: ["INBOX"] }
                : kind === "mark_email_read"
                  ? { removeLabelIds: ["UNREAD"] }
                  : kind === "mark_email_unread"
                    ? { addLabelIds: ["UNREAD"] }
                    : undefined;

        try {
            const resp = await fetch(
                `${GMAIL_API}/messages/${encodeURIComponent(messageId)}/${endpoint}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                },
            );
            if (!resp.ok) console.warn(`[Gmail] ${kind} returned ${resp.status}`);
        } catch (e) {
            console.error(`[Gmail] ${kind} error:`, (e as Error).message);
        }
    }
}
