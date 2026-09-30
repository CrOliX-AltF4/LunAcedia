/**
 * Topics — "une conversation = un sujet à traiter" (ADR-020 amendment 1, S1): the pocket app's conversations with
 * LunAcedia's default agent, kept here, server side, so they are the same from every client.
 *
 * On disk (same STORAGE_DIR convention as the other stores), under `conversations/`:
 *   index.json      the topics' metadata, rewritten atomically on each change
 *   <id>.jsonl      one topic's messages, append-only
 *   journal.jsonl   create / rename / archive / delete — who can see what happened to a topic
 * Without a directory (tests), everything stays in memory.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export function defaultConversationDir(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "conversations");
}

/** Longest message accepted — a topic is a conversation, not a document dump. */
export const MAX_MESSAGE_CHARS = 4_000;
/** Beyond this, the topic is full: open a new one (no silent truncation, no automatic purge). */
export const MAX_MESSAGES = 500;
const TITLE_CHARS = 80;

/** What the client may show of an agent run: its outcome, not its steps (those stay in the agent journal). */
export interface AgentOutcome {
    version: 1;
    status: "done" | "limit_reached" | "unavailable" | "error";
    items: Record<string, unknown>[];
    actions: Record<string, unknown>[];
}

export interface ConversationMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
    at: string;
    /** Assistant: the run read text written by a third party (mail, issue…) — see the contamination rule. */
    external?: boolean;
    /** User: the box item this message is about (a notification's "Traiter"). */
    about?: string;
    agent?: AgentOutcome;
}

/** The older turns folded into one text once they leave the context window. */
export interface ConversationSummary {
    text: string;
    /** How many messages, from the start, the summary covers. */
    covers: number;
    /** One of the covered messages carried third-party text. */
    external: boolean;
}

export interface ConversationMeta {
    id: string;
    title: string;
    titleSource: "first_message" | "generated" | "user";
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    messageCount: number;
    summary?: ConversationSummary;
}

/** The public view of a topic — the summary is internal context, not part of the contract. */
export type ConversationView = Omit<ConversationMeta, "summary" | "titleSource">;

export function toView(meta: ConversationMeta): ConversationView {
    const { summary: _summary, titleSource: _titleSource, ...view } = meta;
    return view;
}

export class ConversationFullError extends Error {
    constructor() {
        super(`This topic reached ${MAX_MESSAGES} messages — open a new one`);
        this.name = "ConversationFullError";
    }
}

/** A title from the first message: one line, cut on a word. */
export function titleFromText(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    if (line.length <= TITLE_CHARS) return line;
    const cut = line.slice(0, TITLE_CHARS);
    const space = cut.lastIndexOf(" ");
    return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type JournalOp = "create" | "rename" | "archive" | "unarchive" | "delete";

export class ConversationStore {
    private readonly metas = new Map<string, ConversationMeta>();
    private readonly messageCache = new Map<string, ConversationMessage[]>();
    /** Every disk write goes through here, in order — two index rewrites never race on the same temp file. */
    private writes: Promise<void> = Promise.resolve();

    constructor(
        private readonly dir?: string,
        private readonly now: () => number = Date.now,
        private readonly newId: () => string = randomUUID,
    ) {}

    async load(): Promise<void> {
        if (!this.dir) return;
        try {
            const raw = JSON.parse(await fs.readFile(this.indexPath(), "utf-8")) as unknown;
            if (!Array.isArray(raw)) return;
            for (const m of raw) {
                if (m && typeof m === "object" && typeof (m as ConversationMeta).id === "string") {
                    this.metas.set((m as ConversationMeta).id, m as ConversationMeta);
                }
            }
        } catch {
            // Missing or unreadable index: start empty (the message files stay on disk untouched).
        }
    }

    /** Newest activity first. */
    list(filter: { archived?: boolean } = {}): ConversationMeta[] {
        return [...this.metas.values()]
            .filter((m) => filter.archived === undefined || m.archived === filter.archived)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id: string): ConversationMeta | undefined {
        return this.metas.get(id);
    }

    async create(firstText: string): Promise<ConversationMeta> {
        const at = this.iso();
        const meta: ConversationMeta = {
            id: this.newId(),
            title: titleFromText(firstText),
            titleSource: "first_message",
            createdAt: at,
            updatedAt: at,
            archived: false,
            messageCount: 0,
        };
        this.metas.set(meta.id, meta);
        this.messageCache.set(meta.id, []);
        await this.saveIndex();
        await this.journal("create", meta.id);
        return meta;
    }

    isFull(id: string): boolean {
        return (this.metas.get(id)?.messageCount ?? 0) >= MAX_MESSAGES;
    }

    async append(
        id: string,
        message: Omit<ConversationMessage, "id" | "at">,
    ): Promise<ConversationMessage> {
        const meta = this.require(id);
        if (meta.messageCount >= MAX_MESSAGES) throw new ConversationFullError();
        const full: ConversationMessage = { id: this.newId(), at: this.iso(), ...message };
        const messages = await this.messages(id);
        messages.push(full);
        if (this.dir) {
            const dir = this.dir;
            const file = this.messagesPath(id);
            await this.write(async () => {
                await fs.mkdir(dir, { recursive: true });
                await fs.appendFile(file, JSON.stringify(full) + "\n", "utf-8");
            });
        }
        meta.messageCount = messages.length;
        meta.updatedAt = full.at;
        await this.saveIndex();
        return full;
    }

    /** All messages, oldest first. */
    async messages(id: string): Promise<ConversationMessage[]> {
        this.require(id);
        const cached = this.messageCache.get(id);
        if (cached) return cached;
        const loaded: ConversationMessage[] = [];
        if (this.dir) {
            try {
                const raw = await fs.readFile(this.messagesPath(id), "utf-8");
                for (const line of raw.split("\n")) {
                    if (!line.trim()) continue;
                    try {
                        loaded.push(JSON.parse(line) as ConversationMessage);
                    } catch {
                        // A torn last line (crash mid-write) is skipped, the rest of the topic is kept.
                    }
                }
            } catch {
                // No file yet: an empty topic.
            }
        }
        this.messageCache.set(id, loaded);
        return loaded;
    }

    /** A page of messages, oldest first, ending just before `before` (a message id) or at the newest. */
    async page(
        id: string,
        options: { before?: string; limit: number },
    ): Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
        const all = await this.messages(id);
        let end = all.length;
        if (options.before) {
            const i = all.findIndex((m) => m.id === options.before);
            if (i >= 0) end = i;
        }
        const start = Math.max(0, end - options.limit);
        return { messages: all.slice(start, end), hasMore: start > 0 };
    }

    async rename(id: string, title: string, source: ConversationMeta["titleSource"]): Promise<ConversationMeta> {
        const meta = this.require(id);
        meta.title = titleFromText(title);
        meta.titleSource = source;
        await this.saveIndex();
        await this.journal("rename", id);
        return meta;
    }

    async setArchived(id: string, archived: boolean): Promise<ConversationMeta> {
        const meta = this.require(id);
        if (meta.archived !== archived) {
            meta.archived = archived;
            await this.saveIndex();
            await this.journal(archived ? "archive" : "unarchive", id);
        }
        return meta;
    }

    async setSummary(id: string, summary: ConversationSummary): Promise<void> {
        const meta = this.metas.get(id);
        if (!meta) return; // deleted meanwhile
        meta.summary = summary;
        await this.saveIndex();
    }

    async delete(id: string): Promise<boolean> {
        if (!this.metas.delete(id)) return false;
        this.messageCache.delete(id);
        if (this.dir) {
            const file = this.messagesPath(id);
            await this.write(() => fs.rm(file, { force: true }));
        }
        await this.saveIndex();
        await this.journal("delete", id);
        return true;
    }

    private require(id: string): ConversationMeta {
        const meta = this.metas.get(id);
        if (!meta) throw new Error(`No topic ${id}`);
        return meta;
    }

    private iso(): string {
        return new Date(this.now()).toISOString();
    }

    private indexPath(): string {
        return path.join(this.dir!, "index.json");
    }

    private messagesPath(id: string): string {
        // Ids are generated here (UUIDs); a foreign one never reaches the file system.
        if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`Invalid topic id ${id}`);
        return path.join(this.dir!, `${id}.jsonl`);
    }

    private write(op: () => Promise<void>): Promise<void> {
        const next = this.writes.then(op);
        // A failed write must not block the ones after it; its caller still sees the error.
        this.writes = next.catch(() => {});
        return next;
    }

    private async saveIndex(): Promise<void> {
        if (!this.dir) return;
        const dir = this.dir;
        const index = this.indexPath();
        await this.write(async () => {
            // Serialized when the write runs, so the file always ends up with the latest state.
            const content = JSON.stringify([...this.metas.values()], null, 2);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(`${index}.tmp`, content, "utf-8");
            await fs.rename(`${index}.tmp`, index);
        });
    }

    private async journal(op: JournalOp, id: string): Promise<void> {
        if (!this.dir) return;
        const file = path.join(this.dir, "journal.jsonl");
        const line = JSON.stringify({ at: this.iso(), op, id }) + "\n";
        await this.write(async () => {
            await fs.appendFile(file, line, "utf-8");
        });
    }
}
