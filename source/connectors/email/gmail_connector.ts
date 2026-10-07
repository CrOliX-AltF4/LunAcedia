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
import type { GoogleTokenStore } from "../../auth/google_token_store.js";
import { assertHttpOk } from "../connector_http.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Trashed mails read at once by listTrash() — fast enough, gentle on the Gmail API quota. */
const TRASH_READ_CONCURRENCY = 8;

class GmailListError extends Error {
    constructor(
        query: string,
        readonly status: number,
        reason?: string,
    ) {
        super(`[Gmail] list "${query}" returned ${status}${reason ? ` (${reason})` : ""}`);
    }

    /** Keeps Google's own reason (rateLimitExceeded, insufficientPermissions…): a bare 403 says nothing. */
    static async from(query: string, resp: Response): Promise<GmailListError> {
        let reason: string | undefined;
        try {
            const body = (await resp.json()) as {
                error?: { errors?: Array<{ reason?: string }>; status?: string };
            };
            reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
        } catch {
            // no readable body: the status alone
        }
        return new GmailListError(query, resp.status, reason);
    }
}

/** One page of Gmail's trash. `skipped`: mails listed but unreadable — counted, never hidden. */
export interface TrashPage {
    items: Array<{ id: string; title: string; from: string; ts: number }>;
    next?: string;
    skipped: number;
}

const TRASH_PAGE_SIZE = 50;

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

type LabelMutation = Extract<
    ConnectorAction,
    {
        kind:
            | "archive_email"
            | "delete_email"
            | "mark_email_read"
            | "mark_email_unread"
            | "mark_spam"
            | "unmark_spam"
            | "star_email"
            | "unstar_email"
            | "label_email"
            | "unlabel_email";
    }
>;

const LABEL_CHANGES: Record<
    Exclude<LabelMutation["kind"], "label_email" | "unlabel_email">,
    { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined
> = {
    archive_email: { removeLabelIds: ["INBOX"] },
    delete_email: undefined, // the /trash endpoint, no body
    mark_email_read: { removeLabelIds: ["UNREAD"] },
    mark_email_unread: { addLabelIds: ["UNREAD"] },
    mark_spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
    unmark_spam: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
    star_email: { addLabelIds: ["STARRED"] },
    unstar_email: { removeLabelIds: ["STARRED"] },
};

function isLabelMutation(action: ConnectorAction): action is LabelMutation {
    return (
        action.kind in LABEL_CHANGES ||
        action.kind === "label_email" ||
        action.kind === "unlabel_email"
    );
}

/**
 * Polls the whole Gmail INBOX (read and unread). Its priority is Gmail's default only — « important » is normal,
 * the rest info; the VIP list and the guard rules decide the rest downstream, in one place.
 *
 * Config (in .env):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — OAuth2 credentials
 *                — GMAIL_REFRESH_TOKEN is a fallback; ignored once GoogleTokenStore has one
 *                  for "gmail" (obtained via GET /api/oauth/google/start?connector=gmail)
 *   GMAIL_MAX_AGE_HOURS=24            — announce window: an older mail is still collected (the box is the
 *                                        whole inbox) but flagged `meta.backlog` — stored, never
 *                                        announced to the Core nor pushed (live check 2026-09-28, C7)
 *   GMAIL_MAX_INBOX=500               — how many inbox mails are listed at most (paginated)
 *   GMAIL_POLL_INTERVAL_MIN=5         — poll frequency
 *
 * GMAIL_RULES is no longer read here: it is turned into guard rules once, at startup (priority_migration.ts).
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
    private readonly maxInbox: number;
    private readonly tokenStore?: GoogleTokenStore;
    /** Set by the hub: keys already settled (dispatched, or dropped by a guard) are not fetched again. */
    private isSettled?: (dedupeKey: string) => boolean;

    constructor(tokenStore?: GoogleTokenStore) {
        this.tokenStore = tokenStore;
        this.clientId = process.env["GMAIL_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GMAIL_CLIENT_SECRET"] ?? "";
        this.staticRefreshToken = process.env["GMAIL_REFRESH_TOKEN"] ?? "";

        const intervalMin = parseInt(process.env["GMAIL_POLL_INTERVAL_MIN"] ?? "5", 10);
        this.preferredPollIntervalMs = Math.max(2, intervalMin) * 60_000;

        const maxAgeHours = parseInt(process.env["GMAIL_MAX_AGE_HOURS"] ?? "24", 10);
        this.maxAgeMs = Math.max(1, maxAgeHours) * 3_600_000;
        this.maxInbox = Math.max(1, parseInt(process.env["GMAIL_MAX_INBOX"] ?? "500", 10) || 500);

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
     *  effect on the very next poll, no restart needed. */
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
            // The whole inbox, read and unread, like Gmail itself: a mail leaves the box
            // when it is archived or trashed, not when it is read. Paginated — it used to stop at 50.
            ids = [...(await this.listIds(token, "label:inbox"))];
        } catch (e) {
            if (e instanceof GmailListError && e.status === 401) clearTokenCache();
            console.warn("[Gmail] list error:", (e as Error).message);
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
                // Collected whatever its age (C7): the age only decides whether it is news.
                const backlog = ts < cutoff;

                const from = header("From");
                const subject = header("Subject") || "(no subject)";
                // Gmail's default only — the VIP list and the rules decide the rest, downstream, in one place.
                const important = (msg.labelIds ?? []).includes("IMPORTANT");

                events.push({
                    type: "email.received",
                    ts,
                    source: "email",
                    title: subject,
                    body: msg.snippet?.slice(0, 200).trim(),
                    priority: important ? "normal" : "info",
                    ...(important && { priorityReason: "Gmail : important" }),
                    dedupeKey: `email-${id}`,
                    read: !(msg.labelIds ?? []).includes("UNREAD"),
                    meta: {
                        ...(backlog && { backlog: true }),
                        from,
                        messageId: id,
                        threadId: msg.threadId,
                        // Neutral inputs for the ingestion guards: Gmail's labels and the presence of a
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

    /** Every id the query lists, page after page, up to GMAIL_MAX_INBOX. Throws when a page cannot be read. */
    private async listIds(token: string, query: string): Promise<Set<string>> {
        const ids = new Set<string>();
        let pageToken: string | undefined;
        do {
            const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
            const resp = await fetch(
                `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=100${page}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!resp.ok) throw await GmailListError.from(query, resp);
            const data = (await resp.json()) as {
                messages?: Array<{ id: string }>;
                nextPageToken?: string;
            };
            for (const m of data.messages ?? []) {
                if (ids.size >= this.maxInbox) return ids;
                ids.add(m.id);
            }
            pageToken = data.nextPageToken;
        } while (pageToken);
        return ids;
    }

    /**
     * Where each held mail stands in Gmail. Two bounded listings (inbox, unread inbox) settle
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
     * Opens a mail like Gmail does: the whole plain-text body, and the mail is marked read
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
        await this.modifyMessage(token, { kind: "mark_email_read", sourceId: id });
        return { body };
    }

    /** Master's gestures on a mail, applied in Gmail. */
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
            archive: ["archive_email", "removed"],
            trash: ["delete_email", "removed"],
            spam: ["mark_spam", "removed"],
        } as const;
        if (!(gesture in kinds)) throw new Error(`[Gmail] "${gesture}" does not apply to a mail`);
        const [kind, change] = kinds[gesture as keyof typeof kinds];
        const token = await this.accessToken();
        if (!token) throw new Error("[Gmail] not configured");
        await this.modifyMessage(token, { kind, sourceId: id });
        return { change };
    }

    /** Gmail's trash, most recent first (Gmail keeps it 30 days) — nothing is stored on our side. */
    /**
     * One page of the trash (TRASH_PAGE_SIZE mails), `page` being the token of a previous answer: read
     * whole, a trash of hundreds of mails was slow and cut without a word past GMAIL_MAX_INBOX.
     */
    async listTrash(page?: string): Promise<TrashPage> {
        const token = await this.accessToken();
        if (!token) return { items: [], skipped: 0 };
        const resp = await fetch(
            `${GMAIL_API}/messages?q=${encodeURIComponent("in:trash")}&maxResults=${TRASH_PAGE_SIZE}` +
                (page ? `&pageToken=${encodeURIComponent(page)}` : ""),
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!resp.ok) throw await GmailListError.from("in:trash", resp);
        const listed = (await resp.json()) as {
            messages?: Array<{ id: string }>;
            nextPageToken?: string;
        };
        const ids = (listed.messages ?? []).map((m) => m.id);
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
        const items = results.filter((r): r is TrashItem => r !== null);
        return {
            items,
            ...(listed.nextPageToken && { next: listed.nextPageToken }),
            skipped: ids.length - items.length,
        };
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
        if (action.kind !== "reply" && action.kind !== "bulk_email" && !isLabelMutation(action))
            throw new Error(`[Gmail] "${action.kind}" is not a mail action — nothing was done`);
        // Never a quiet return: the caller would count the action as done and drop its notification.
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken)
            throw new Error("[Gmail] not configured — nothing was done");

        let token: string;
        try {
            token = await getAccessToken(this.clientId, this.clientSecret, refreshToken);
        } catch (e) {
            console.error("[Gmail] action token error:", (e as Error).message);
            throw e;
        }

        if (isLabelMutation(action)) {
            await this.modifyMessage(token, action);
            return;
        }
        if (action.kind === "bulk_email") {
            await this.modifyBatch(token, action);
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

    /** Every sorting action reduces to a Gmail label mutation. delete_email moves to Trash (recoverable, not a
     *  permanent delete) — what "delete" means in a normal Gmail client. */
    private async modifyMessage(token: string, action: LabelMutation): Promise<void> {
        const endpoint = action.kind === "delete_email" ? "trash" : "modify";
        let body: { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined;
        if (action.kind === "label_email" || action.kind === "unlabel_email") {
            const labelId = await this.labelId(token, action.label, action.kind === "label_email");
            if (!labelId) return; // removing a label Gmail does not have: nothing to do
            body =
                action.kind === "label_email"
                    ? { addLabelIds: [labelId] }
                    : { removeLabelIds: [labelId] };
        } else {
            body = LABEL_CHANGES[action.kind];
        }

        try {
            const resp = await fetch(
                `${GMAIL_API}/messages/${encodeURIComponent(action.sourceId)}/${endpoint}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                },
            );
            await assertHttpOk(resp, `[Gmail] ${action.kind}`);
        } catch (e) {
            console.error(`[Gmail] ${action.kind} error:`, (e as Error).message);
            throw e;
        }
    }

    /** A frozen batch: one batchModify for label changes (Gmail takes up to 1000 ids), the trash mail by mail. */
    private async modifyBatch(
        token: string,
        action: Extract<ConnectorAction, { kind: "bulk_email" }>,
    ): Promise<void> {
        const ids = action.sourceIds ?? [];
        if (ids.length === 0) throw new Error("[Gmail] bulk_email: no mail was selected");
        if (action.action === "delete_email") {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < ids.length) {
                    const id = ids[next++]!;
                    await this.modifyMessage(token, { kind: "delete_email", sourceId: id });
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(TRASH_READ_CONCURRENCY, ids.length) }, worker),
            );
            return;
        }
        let change: { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined;
        if (action.action === "label_email") {
            if (!action.label?.trim())
                throw new Error("[Gmail] bulk_email: label_email needs a label");
            const labelId = await this.labelId(token, action.label, true);
            change = { addLabelIds: [labelId!] };
        } else {
            change = LABEL_CHANGES[action.action];
        }
        const resp = await fetch(`${GMAIL_API}/messages/batchModify`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ids, ...change }),
        });
        await assertHttpOk(resp, `[Gmail] bulk ${action.action} (${ids.length})`);
    }

    /** A user label's id, by name (case-insensitive); created when [create] and Gmail has none by that name. */
    private async labelId(token: string, name: string, create: boolean): Promise<string | null> {
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const list = await fetch(`${GMAIL_API}/labels`, { headers });
        await assertHttpOk(list, "[Gmail] list labels");
        const { labels = [] } = (await list.json()) as {
            labels?: Array<{ id: string; name: string }>;
        };
        const wanted = name.trim().toLowerCase();
        const found = labels.find((l) => l.name.toLowerCase() === wanted);
        if (found) return found.id;
        if (!create) return null;
        const made = await fetch(`${GMAIL_API}/labels`, {
            method: "POST",
            headers,
            body: JSON.stringify({ name: name.trim() }),
        });
        await assertHttpOk(made, `[Gmail] create label "${name}"`);
        return ((await made.json()) as { id: string }).id;
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
