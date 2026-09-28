import type {
    IConnector,
    InboxGesture,
    InboxGestureResult,
    SourceState,
} from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getAccessToken, clearTokenCache } from "./gmail_auth.js";
import { parseRules, classifyEmail } from "./email_rules.js";
import type { EmailRule } from "./email_rules.js";
import type { EmailClassificationStore } from "./email_classification_store.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";
import { assertHttpOk } from "../connector_http.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Trashed mails read at once by listTrash() — fast enough, gentle on the Gmail API quota. */
const TRASH_READ_CONCURRENCY = 8;

interface MessageHeader {
    name: string;
    value: string;
}
interface GmailMessageMeta {
    id: string;
    threadId: string;
    internalDate: string;
    payload: { headers: MessageHeader[] };
    /** Gmail's own labels (INBOX, UNREAD, CATEGORY_PROMOTIONS…) — present in a format=metadata response. */
    labelIds?: string[];
    /** Short plain-text preview Gmail generates itself — present regardless of `format`,
     *  since it isn't part of `payload` (unlike headers, which `format=metadata` limits). */
    snippet?: string;
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
    /** Set by the hub: keys already settled (dispatched, or dropped by a guard) are not fetched again. */
    private isSettled?: (dedupeKey: string) => boolean;

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

    setSettledFilter(isSettled: (dedupeKey: string) => boolean): void {
        this.isSettled = isSettled;
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
                // The whole inbox, read and unread, like Gmail itself (ADR-018 D2): a mail leaves the box
                // when it is archived or trashed, not when it is read.
                `${GMAIL_API}/messages?q=label:inbox&maxResults=50`,
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
            // An unread mail stays in the inbox: without this, every poll (every 60 s) would re-fetch the metadata
            // of every mail already dispatched or dropped by a guard.
            if (this.isSettled?.(`email-${id}`)) continue;
            try {
                const resp = await fetch(
                    `${GMAIL_API}/messages/${id}?format=metadata` +
                        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe`,
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
                    body: msg.snippet?.slice(0, 200).trim(),
                    priority,
                    dedupeKey: `email-${id}`,
                    read: !(msg.labelIds ?? []).includes("UNREAD"),
                    meta: {
                        from,
                        messageId: id,
                        threadId: msg.threadId,
                        // Neutral inputs for the ingestion guards (chantier A): Gmail's labels and the presence of a
                        // List-Unsubscribe header (the reliable mark of bulk mail). Both come from the response this
                        // call already returns — no extra API request.
                        labels: msg.labelIds ?? [],
                        headers: header("List-Unsubscribe")
                            ? { "list-unsubscribe": header("List-Unsubscribe").slice(0, 200) }
                            : {},
                    },
                });
            } catch {
                // skip individual message errors silently
            }
        }

        return events;
    }

    private async accessToken(): Promise<string | null> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return null;
        return getAccessToken(this.clientId, this.clientSecret, refreshToken);
    }

    private async listIds(token: string, query: string): Promise<Set<string>> {
        const resp = await fetch(
            `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=100`,
            {
                headers: { Authorization: `Bearer ${token}` },
            },
        );
        if (!resp.ok) throw new Error(`[Gmail] list "${query}" returned ${resp.status}`);
        const data = (await resp.json()) as { messages?: Array<{ id: string }> };
        return new Set((data.messages ?? []).map((m) => m.id));
    }

    /**
     * Where each held mail stands in Gmail (ADR-018 R8). Two bounded listings (inbox, unread inbox) settle
     * the recent mail; anything they did not show is checked one by one, so a mail that is merely older
     * than the listing is never mistaken for gone. null when Gmail cannot be asked: change nothing.
     */
    async sourceState(events: AcediaEvent[]): Promise<Map<string, SourceState> | null> {
        const held = events
            .filter((e) => e.source === "email" && typeof e.meta?.["messageId"] === "string")
            .map((e) => ({ key: e.dedupeKey, id: e.meta!["messageId"] as string }));
        const state = new Map<string, SourceState>();
        if (held.length === 0) return state;

        let token: string | null;
        let inbox: Set<string>;
        let unread: Set<string>;
        try {
            token = await this.accessToken();
            if (!token) return null;
            inbox = await this.listIds(token, "label:inbox");
            unread = await this.listIds(token, "label:inbox is:unread");
        } catch (e) {
            console.warn("[Gmail] source state unavailable:", (e as Error).message);
            return null;
        }

        for (const { key, id } of held) {
            if (inbox.has(id)) {
                state.set(key, unread.has(id) ? "unread" : "read");
                continue;
            }
            try {
                const resp = await fetch(
                    `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=minimal`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (resp.status === 404) {
                    state.set(key, "gone");
                    continue;
                }
                if (!resp.ok) continue; // unknown this time — judged on a later pass
                const labels = ((await resp.json()) as { labelIds?: string[] }).labelIds ?? [];
                state.set(
                    key,
                    !labels.includes("INBOX")
                        ? "gone"
                        : labels.includes("UNREAD")
                          ? "unread"
                          : "read",
                );
            } catch {
                // unknown this time — never removed on uncertainty
            }
        }
        return state;
    }

    /**
     * Opens a mail like Gmail does (ADR-018 R1/R4): the whole plain-text body, and the mail is marked read
     * at the source. null when Gmail no longer has it.
     */
    async openMessage(id: string): Promise<{ body: string } | null> {
        const token = await this.accessToken();
        if (!token) return null;
        const resp = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.status === 404) return null;
        await assertHttpOk(resp, `[Gmail] open ${id}`);
        const msg = (await resp.json()) as { payload?: GmailPart };
        const body = extractBody(msg.payload);
        await this.modifyMessage(token, "mark_email_read", id);
        return { body };
    }

    /** Master's gestures on a mail, applied in Gmail (ADR-018 R1). */
    async inboxGesture(gesture: InboxGesture, event: AcediaEvent): Promise<InboxGestureResult> {
        const id = event.meta?.["messageId"];
        if (typeof id !== "string") throw new Error("[Gmail] item has no message id");
        if (gesture === "open") {
            const opened = await this.openMessage(id);
            if (!opened) throw new Error("[Gmail] mail no longer exists");
            return { change: "read", body: opened.body };
        }
        const kinds = {
            read: ["mark_email_read", "read"],
            unread: ["mark_email_unread", "unread"],
            archive: ["archive_email", "removed"],
            trash: ["delete_email", "removed"],
        } as const;
        if (!(gesture in kinds)) throw new Error(`[Gmail] "${gesture}" does not apply to a mail`);
        const [kind, change] = kinds[gesture as keyof typeof kinds];
        const token = await this.accessToken();
        if (!token) throw new Error("[Gmail] not configured");
        await this.modifyMessage(token, kind, id);
        return { change };
    }

    /** Gmail's trash, most recent first (Gmail keeps it 30 days) — nothing is stored on our side. */
    async listTrash(): Promise<Array<{ id: string; title: string; from: string; ts: number }>> {
        const token = await this.accessToken();
        if (!token) return [];
        const ids = [...(await this.listIds(token, "in:trash"))];
        // In parallel, a few at a time (live check 2026-09-28: one by one took 18.7 s, past the Core's
        // proxy timeout). Gmail's order is kept; an unreadable mail is skipped, not fatal.
        type TrashItem = { id: string; title: string; from: string; ts: number };
        const results: Array<TrashItem | null> = new Array<TrashItem | null>(ids.length).fill(null);
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < ids.length) {
                const index = next++;
                const id = ids[index]!;
                try {
                    const resp = await fetch(
                        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                    if (!resp.ok) continue;
                    const msg = (await resp.json()) as GmailMessageMeta;
                    const h = (n: string) =>
                        msg.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())
                            ?.value ?? "";
                    results[index] = {
                        id,
                        title: h("Subject") || "(no subject)",
                        from: h("From"),
                        ts: parseInt(msg.internalDate, 10),
                    };
                } catch {
                    // skip one unreadable mail rather than failing the whole list
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(TRASH_READ_CONCURRENCY, ids.length) }, worker),
        );
        return results.filter((r): r is TrashItem => r !== null);
    }

    /** Takes a mail out of the trash (Gmail keeps trashed mail 30 days). */
    async restoreMessage(id: string): Promise<void> {
        const token = await this.accessToken();
        if (!token) throw new Error("[Gmail] not configured");
        const resp = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/untrash`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
        });
        await assertHttpOk(resp, `[Gmail] restore ${id}`);
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
            throw e;
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
            await assertHttpOk(resp, `[Gmail] reply: fetch message ${action.sourceId}`);
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
            throw e;
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
            await assertHttpOk(resp, "[Gmail] reply send");
        } catch (e) {
            console.error("[Gmail] reply send error:", (e as Error).message);
            throw e;
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
            await assertHttpOk(resp, `[Gmail] ${kind}`);
        } catch (e) {
            console.error(`[Gmail] ${kind} error:`, (e as Error).message);
            throw e;
        }
    }
}

interface GmailPart {
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailPart[];
}

function decodePart(part: GmailPart | undefined): string {
    const data = part?.body?.data;
    return data ? Buffer.from(data, "base64url").toString("utf-8") : "";
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
    if (!part) return undefined;
    if (part.mimeType === mimeType && part.body?.data) return part;
    for (const child of part.parts ?? []) {
        const found = findPart(child, mimeType);
        if (found) return found;
    }
    return undefined;
}

/** The readable text of a mail: its text/plain part, else its HTML with the tags stripped. */
function extractBody(payload: GmailPart | undefined): string {
    const plain = findPart(payload, "text/plain");
    if (plain) return decodePart(plain).trim();
    const html = findPart(payload, "text/html");
    if (html) {
        return decodePart(html)
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim();
    }
    return decodePart(payload).trim();
}
