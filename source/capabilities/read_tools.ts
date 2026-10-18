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
import type { PlanningSnapshot } from "../types/planning.js";
import type { ToolDefinition } from "./capability_manifest.js";
import type { Dossier } from "../dossiers/dossier_index.js";

export interface ReadToolDeps {
    store: EventStore;
    busyIntervals: () => TimeSlot[];
    now: () => number;
    /**
     * Marks a mail read at its source once read in full (like opening it in Gmail). Runs in
     * the background: a failure never keeps the agent from reading the mail.
     */
    markRead?: (event: AcediaEvent) => Promise<void>;
    /** Whether a model may read an item (its class of mail): the others are never handed to it. Absent: all may. */
    aiReadable?: (event: AcediaEvent) => boolean;
    /**
     * The planning over [from, to) — every event of the horizon and every task (lot AT). Absent: the agenda and tasks
     * tools are not offered.
     */
    planning?: (from: number, to: number) => PlanningSnapshot;
    /** The dossiers: what the sources group — absent, their tools are not offered. */
    dossiers?: { list: () => Dossier[]; get: (id: string) => Dossier | undefined };
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
            maximum: 336,
            description: "Window from now (default 24, up to two weeks).",
        },
        minGapMin: {
            type: "integer",
            minimum: 15,
            maximum: 240,
            description: "Shortest slot (default 30).",
        },
    },
};

const DAY_MS = 86_400_000;
/** The longest period agenda reads at once — the planning holds 90 days ahead. */
const AGENDA_MAX_DAYS = 90;
const TASKS_LIMIT = 50;
const DESCRIPTION_CHARS = 300;

const AGENDA_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        from: {
            type: "string",
            description:
                "Start: an ISO date (YYYY-MM-DD) or date-time. Default: the start of today.",
        },
        to: { type: "string", description: "End (excluded), same form. Default: from + days." },
        days: {
            type: "integer",
            minimum: 1,
            maximum: AGENDA_MAX_DAYS,
            description: "Length of the period when `to` is not given (default 7).",
        },
    },
};
const TASKS_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        status: {
            type: "string",
            enum: ["open", "completed", "all"],
            description: "Default open.",
        },
        listId: { type: "string", description: "Only this list." },
        dueBefore: {
            type: "string",
            description: "Only tasks due on or before this date (YYYY-MM-DD).",
        },
        undated: { type: "boolean", description: "Only tasks without a due date." },
        text: { type: "string", description: "Case-insensitive text in the title or the notes." },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Max results (default 50).",
        },
    },
};

const DOSSIERS_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        text: { type: "string", description: "Only dossiers whose title or label contains this." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
    },
};

const DOSSIER_SCHEMA: ObjectSchema = {
    type: "object",
    properties: {
        id: { type: "string", description: "The `id` of a dossier from list_dossiers." },
    },
    required: ["id"],
};

export function readToolDefinitions(
    opts: { planning?: boolean; dossiers?: boolean } = {},
): ToolDefinition[] {
    return [
        {
            name: "search_events",
            description:
                "Search LunAcedia's box: the whole mail inbox (read and unread), near-term calendar events and tasks, GitHub notifications and feed items. Returns compact items with the ids actions need. Filter by `unread` only when the user asks for unread items; when nothing matches, search again with fewer filters before concluding it does not exist." +
                (opts.planning
                    ? " For the calendar and tasks, prefer agenda and tasks: they see the whole planning."
                    : ""),
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
        ...(opts.planning
            ? [
                  {
                      name: "agenda",
                      description:
                          "The calendar over a period — from 7 days back to 90 days ahead: every event with its id (what event actions take), and the overlaps between them. Use it for any question about the schedule, a date, a meeting.",
                      parameters: AGENDA_SCHEMA,
                  },
                  {
                      name: "tasks",
                      description:
                          "Every task of every list, whatever its due date (or none), with its id (what task actions take). Default: the open ones.",
                      parameters: TASKS_SCHEMA,
                  },
              ]
            : []),
        ...(opts.dossiers
            ? [
                  {
                      name: "list_dossiers",
                      description:
                          "The dossiers: mails of one thread, and what a project label gathers (its mails, events, tasks, GitHub notifications). Most recently active first. Use it for « where are we with X », a project, a matter that spans several mails.",
                      parameters: DOSSIERS_SCHEMA,
                  },
                  {
                      name: "get_dossier",
                      description:
                          "One dossier in full: every item in it, oldest first, with its `ref` (a mail's ref is the key get_event takes).",
                      parameters: DOSSIER_SCHEMA,
                  },
              ]
            : []),
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
    const readable = deps.aiReadable ?? (() => true);
    const matched = (events as AcediaEvent[]).filter(
        (e) =>
            readable(e) &&
            (!text ||
                e.title.toLowerCase().includes(text) ||
                (e.body ?? "").toLowerCase().includes(text) ||
                (typeof e.meta?.["from"] === "string" &&
                    e.meta["from"].toLowerCase().includes(text))),
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
    if (deps.aiReadable && !deps.aiReadable(e))
        return {
            ok: false,
            error: `the item '${key}' is kept away from the assistant (personal or advertising mail)`,
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

/** An ISO date is read as local midnight (the user's day), a date-time as is. NaN when unreadable. */
function parseWhen(value: string): number {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
    return Date.parse(value);
}

function startOfToday(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function agenda(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    if (!deps.planning) return { ok: false, error: "the planning is not available" };
    const from =
        typeof args["from"] === "string" ? parseWhen(args["from"]) : startOfToday(deps.now());
    const days = (args["days"] as number | undefined) ?? 7;
    const to = typeof args["to"] === "string" ? parseWhen(args["to"]) : from + days * DAY_MS;
    if (isNaN(from) || isNaN(to))
        return { ok: false, error: "from and to must be ISO dates (YYYY-MM-DD) or date-times" };
    if (to <= from) return { ok: false, error: "to must come after from" };
    if (to - from > AGENDA_MAX_DAYS * DAY_MS)
        return { ok: false, error: `at most ${AGENDA_MAX_DAYS} days at once` };
    const snap = deps.planning(from, to);
    const events = snap.events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        ...(e.recurring && { recurring: true }),
        ...(e.location && { location: e.location }),
        ...(e.description && {
            description:
                e.description.length > DESCRIPTION_CHARS
                    ? `${e.description.slice(0, DESCRIPTION_CHARS)}…`
                    : e.description,
        }),
    }));
    return {
        ok: true,
        result: {
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            events,
            conflicts: snap.conflicts.map((c) => ({
                eventIds: c.eventIds,
                from: c.from,
                to: c.to,
            })),
            syncedAt: snap.syncedAt,
            complete: snap.complete,
        },
        // An invitation's title and description are written by someone else.
        external: events.length > 0,
    };
}

function tasks(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    if (!deps.planning) return { ok: false, error: "the planning is not available" };
    const now = deps.now();
    // Tasks do not depend on the period: the planning holds them all.
    const snap = deps.planning(now, now + 1);
    const status = (args["status"] as string | undefined) ?? "open";
    const text = typeof args["text"] === "string" ? args["text"].toLowerCase() : "";
    const dueBefore = args["dueBefore"] as string | undefined;
    const matched = snap.tasks.filter(
        (t) =>
            (status === "all" || t.status === status) &&
            (!args["listId"] || t.listId === args["listId"]) &&
            (!dueBefore || (t.due !== undefined && t.due <= dueBefore)) &&
            (args["undated"] !== true || t.due === undefined) &&
            (!text ||
                t.title.toLowerCase().includes(text) ||
                (t.notes ?? "").toLowerCase().includes(text)),
    );
    const limit = (args["limit"] as number | undefined) ?? TASKS_LIMIT;
    const shown = matched.slice(0, limit).map((t) => ({
        id: t.id,
        title: t.title,
        list: t.listTitle,
        ...(t.due && { due: t.due }),
        status: t.status,
        ...(t.notes && { notes: t.notes }),
    }));
    return {
        ok: true,
        result: {
            total: matched.length,
            tasks: shown,
            syncedAt: snap.syncedAt,
            complete: snap.complete,
        },
        // A note may hold text copied from a mail.
        external: shown.some((t) => "notes" in t),
    };
}

const TOOLS: Record<
    string,
    { schema: ObjectSchema; run: (a: Record<string, unknown>, d: ReadToolDeps) => ReadToolResult }
> = {
    search_events: { schema: SEARCH_SCHEMA, run: searchEvents },
    get_event: { schema: GET_SCHEMA, run: getEvent },
    free_slots: { schema: SLOTS_SCHEMA, run: freeSlots },
    agenda: { schema: AGENDA_SCHEMA, run: agenda },
    tasks: { schema: TASKS_SCHEMA, run: tasks },
    list_dossiers: { schema: DOSSIERS_SCHEMA, run: listDossiers },
    get_dossier: { schema: DOSSIER_SCHEMA, run: getDossier },
};

function listDossiers(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    if (!deps.dossiers) return { ok: false, error: "dossiers are not available" };
    const text = typeof args["text"] === "string" ? args["text"].toLowerCase() : "";
    const matched = deps.dossiers
        .list()
        .filter(
            (d) =>
                !text ||
                d.title.toLowerCase().includes(text) ||
                (d.label ?? "").toLowerCase().includes(text),
        );
    const limit = (args["limit"] as number | undefined) ?? 10;
    const shown = matched.slice(0, limit).map((d) => {
        const last = d.members.at(-1);
        return {
            id: d.id,
            title: d.title,
            ...(d.label && { label: d.label }),
            items: d.members.length,
            ...(last && {
                last: { kind: last.kind, title: last.title, at: new Date(last.at).toISOString() },
            }),
        };
    });
    // Titles of mails come from their senders: data, never an instruction.
    return {
        ok: true,
        result: { total: matched.length, dossiers: shown },
        external: shown.length > 0,
    };
}

function getDossier(args: Record<string, unknown>, deps: ReadToolDeps): ReadToolResult {
    if (!deps.dossiers) return { ok: false, error: "dossiers are not available" };
    const d = deps.dossiers.get(args["id"] as string);
    if (!d) return { ok: false, error: `no dossier '${String(args["id"])}'` };
    return {
        ok: true,
        result: {
            id: d.id,
            title: d.title,
            ...(d.label && { label: d.label }),
            ...(d.digest && { summary: d.digest.summary, state: d.digest.state }),
            items: d.members.map((m) => ({
                kind: m.kind,
                ref: m.ref,
                title: m.title,
                at: new Date(m.at).toISOString(),
                ...(m.from && { from: m.from }),
                why: m.reason,
            })),
        },
        external: d.members.length > 0,
    };
}

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
