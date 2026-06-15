import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import { getAccessToken, clearTokenCache } from "./gmail_auth.js";
import { parseRules, classifyEmail } from "./email_rules.js";
import type { EmailRule } from "./email_rules.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface MessageHeader {
    name: string;
    value: string;
}
interface GmailMessageMeta {
    id: string;
    internalDate: string;
    payload: { headers: MessageHeader[] };
}

/**
 * Polls Gmail INBOX for unread messages and classifies them by configurable rules.
 *
 * Config (in .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — OAuth2 credentials
 *   GMAIL_MAX_AGE_HOURS=24            — ignore messages older than N hours
 *   GMAIL_POLL_INTERVAL_MIN=5         — poll frequency
 *   GMAIL_RULES='[{"senderPattern":"boss@corp.com","priority":"urgent"}]'
 *
 * Rule: classification by senderPattern substring match only — never by LLM.
 */
export class GmailConnector implements IConnector {
    readonly name = "Gmail";
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly refreshToken: string;
    private readonly maxAgeMs: number;
    private readonly rules: EmailRule[];

    constructor() {
        this.clientId = process.env["GMAIL_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GMAIL_CLIENT_SECRET"] ?? "";
        this.refreshToken = process.env["GMAIL_REFRESH_TOKEN"] ?? "";

        const intervalMin = parseInt(process.env["GMAIL_POLL_INTERVAL_MIN"] ?? "5", 10);
        this.preferredPollIntervalMs = Math.max(2, intervalMin) * 60_000;

        const maxAgeHours = parseInt(process.env["GMAIL_MAX_AGE_HOURS"] ?? "24", 10);
        this.maxAgeMs = Math.max(1, maxAgeHours) * 3_600_000;

        this.rules = parseRules(process.env["GMAIL_RULES"] ?? "[]");
    }

    async poll(): Promise<AcediaEvent[]> {
        if (!this.clientId || !this.clientSecret || !this.refreshToken) return [];

        let token: string;
        try {
            token = await getAccessToken(this.clientId, this.clientSecret, this.refreshToken);
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
                const priority = classifyEmail(from, subject, this.rules);

                events.push({
                    type: "email.received",
                    ts,
                    source: "email",
                    title: subject,
                    body: from,
                    priority,
                    dedupeKey: `email-${id}`,
                    meta: { from, messageId: id },
                });
            } catch {
                // skip individual message errors silently
            }
        }

        return events;
    }
}
