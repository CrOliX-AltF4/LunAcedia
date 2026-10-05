/**
 * Read tools of the agent: they only see what LunAcedia already ingested —
 * the EventStore (currently unread mail plus everything received since the last start; it is
 * deliberately in-memory) and the calendar's busy intervals. Live searches in Gmail/Calendar/Tasks
 * are v2.
 *
 * Every result that carries event text is flagged `external`: it was written by someone else, so
 * it is data, never an instruction — the agent loop uses the flag to cap the tier of
 * any action proposed afterwards.
 */
import type { EventStore } from "../store/event_store.js";
import type { AcediaEvent, AcediaEventPriority, AcediaEventSource } from "../types/acedia_event.js";
import { computeFreeSlots, type TimeSlot } from "../connectors/calendar/free_slots.js";
import { validateArgs, type ObjectSchema } from "./json_schema.js";
import type { ToolDefinition } from "./capability_manifest.js";

export interface ReadToolDeps {
    store: EventStore;
    busyIntervals: () => TimeSlot[];
    now: () => number;
    /**
     * Marks a mail read at its source once read in full (like opening it in Gmail). Runs in
     * the background: a failure never keeps the agent from reading the mail.
     */
    markRead?: (event: AcediaEvent) => Promise<void>;
}

export type ReadToolResult =
    { ok: true; result: unknown; external: boolean } | { ok: false; error: string };

const SOURCES: readonly AcediaEventSource[] = ["email", "calendar", "tasks", "github", "rss", "ha"];
const PRIORITIES: readonly AcediaEventPriority[] = ["urgent", "normal", "info"];
/** meta keys an action needs to address an event — nothing else from meta reaches the model. */
const ID_KEYS = ["messageId", "threadId", "calendarId", "eventId", "listId", "taskId", "repo"];
const SNIPPET_CHARS = 160;
const BODY_CHARS = 4_000;
const STORE_SCAN = 1_000;

const SEARCH_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        source: { type: "string", enum: SOURCES, description: "Only events from this source." },
        priority: { type: "string", enum: PRIORITIES },
        unread: { type: "boolean", description: "Only events not marked read yet." },
        tag: { type: "string", description: "Only events tagged by this guard label." },
        sinceHours: {
            type: "integer",
            minimum: 1,
            maximum: 720,
            description: "Only the last N hours.",
        },
        text: {
            type: "string",
            description: "Case-insensitive text in the title, the body or the sender.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 30,
            description: "Max results (default 10).",
        },
    },
};
const GET_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        key: { type: "string", minLength: 1, description: "The `key` of a search result." },
    },
    required: ["key"],
};
const SLOTS_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        hours: {
            type: "integer",
            minimum: 1,
            maximum: 168,
            description: "Window from now (default 24).",
        },
        minGapMin: {
            type: "integer",
            minimum: 15,
            maximum: 240,
            description: "Shortest slot (default 30).",
        },
    },
};

export function readToolDefinitions(): ToolDefinition[] {
    return [
        {
            name: "search_events",
            description:
                "Search LunAcedia's box: the whole mail inbox (read and unread), upcoming calendar events, tasks due, GitHub notifications and feed items. Returns compact items with the ids actions need. Filter by `unread` only when the user asks for unread items; when nothing matches, search again with fewer filters before concluding it does not exist.",
            parameters: SEARCH_SCHEMA,
        },
        {
            name: "get_event",
            description:
                "Read one event in full (e.g. the whole mail body), by the `key` of a search result.",
            parameters: GET_SCHEMA,
        },
        {
            name: "free_slots",
            description: "Open slots in the calendar, from now over the next hours.",
            parameters: SLOTS_SCHEMA,
        },
    ];
}

function ids(e: AcediaEvent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of ID_KEYS) if (e.meta?.[k] !== undefined) out[k] = e.meta[k];
    return out;
}

function compact(e: AcediaEvent): Record<string, unknown> {
    const body = e.body ?? "";
    return {
        key: e.dedupeKey,
        source: e.source,
        type: e.type,
        title: e.title,
        ...(body && {
            snippet: body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS)}…` : body,
        }),
        ...(typeof e.meta?.["from"] === "string" && { from: e.meta["from"] }),
        priority: e.priority,
        read: e.read === true,
        at: new Date(e.ts).toISOString(),
        ...(e.tags?.length && { tags: e.tags }),
        ids: ids(e),
    };
}

function searchEvents(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    const sinceHours = args["sinceHours"] as number | undefined;
    const { events } = deps.store.query({
        limit: STORE_SCAN,
        ...(args["source"] !== undefined && { source: args["source"] as AcediaEventSource }),
        ...(args["priority"] !== undefined && {
            priority: args["priority"] as AcediaEventPriority,
        }),
        ...(args["unread"] === true && { unread: true }),
        ...(args["tag"] !== undefined && { tag: args["tag"] as string }),
        ...(sinceHours !== undefined && { since: deps.now() - sinceHours * 3_600_000 }),
    });
    const text = typeof args["text"] === "string" ? args["text"].toLowerCase() : "";
    const matched = (events as AcediaEvent[]).filter(
        (e) =>
            !text ||
            e.title.toLowerCase().includes(text) ||
            (e.body ?? "").toLowerCase().includes(text) ||
            (typeof e.meta?.["from"] === "string" && e.meta["from"].toLowerCase().includes(text)),
    );
    const limit = (args["limit"] as number | undefined) ?? 10;
    return {
        ok: true,
        result: { total: matched.length, events: matched.slice(0, limit).map(compact) },
        external: matched.length > 0,
    };
}

function getEvent(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    const key = args["key"] as string;
    const { events } = deps.store.query({ limit: STORE_SCAN });
    const e = (events as AcediaEvent[]).find((x) => x.dedupeKey === key);
    if (!e)
        return {
            ok: false,
            error: `no event with key '${key}' (it may have been read and dropped)`,
        };
    if (e.source === "email" && !e.read && deps.markRead) {
        void deps
            .markRead(e)
            .catch((err: unknown) =>
                console.warn("[agent] could not mark the mail read:", (err as Error).message),
            );
    }
    const body = e.body ?? "";
    return {
        ok: true,
        result: {
            ...compact(e),
            body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}…` : body,
        },
        external: true,
    };
}

function freeSlots(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    const now = deps.now();
    const hours = (args["hours"] as number | undefined) ?? 24;
    const minGapMin = (args["minGapMin"] as number | undefined) ?? 30;
    const slots = computeFreeSlots(
        deps.busyIntervals(),
        now,
        now + hours * 3_600_000,
        minGapMin * 60_000,
    );
    return {
        ok: true,
        result: {
            slots: slots.map((s) => ({
                start: new Date(s.start).toISOString(),
                end: new Date(s.end).toISOString(),
            })),
        },
        external: false,
    };
}

const TOOLS: Record<
    string,
    { schema: ObjectSchema; run: (a: Record<string, unknown>, d: ReadToolDeps) => ReadToolResult }
> = {
    search_events: { schema: SEARCH_SCHEMA, run: searchEvents },
    get_event: { schema: GET_SCHEMA, run: getEvent },
    free_slots: { schema: SLOTS_SCHEMA, run: freeSlots },
};

export function isReadTool(name: string): boolean {
    return name in TOOLS;
}

export function runReadTool(name: string, args: unknown, deps: ReadToolDeps): ReadToolResult {
    const tool = TOOLS[name];
    if (!tool) return { ok: false, error: `unknown read tool '${name}'` };
    const v = validateArgs(tool.schema, args ?? {});
    if (!v.ok) return v;
    return tool.run(v.value, deps);
}
