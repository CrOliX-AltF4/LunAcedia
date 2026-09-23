import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AcediaEventPriority } from "../types/acedia_event.js";
import type { GuardAction, GuardCondition, GuardRule } from "./guard_types.js";

const MAX_RULES = 200;
const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 5;
const MAX_VALUE = 200;
const MAX_NAME = 80;
const MAX_TAG = 40;
const PRIORITIES: readonly AcediaEventPriority[] = ["urgent", "normal", "info"];
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;

export type RulesValidation = { ok: true; rules: GuardRule[] } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 && t.length <= max ? t : null;
}

function parseCondition(raw: unknown, where: string): GuardCondition | string {
    if (!isRecord(raw)) return `${where}: condition must be an object`;
    const field = raw["field"];
    const op = raw["op"];
    if (field === "from") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "equals" && op !== "contains" && op !== "domain")
            return `${where}: from.op must be equals, contains or domain`;
        if (!value) return `${where}: from.value is required (max ${MAX_VALUE} characters)`;
        return {
            field,
            op,
            value: op === "domain" ? value.toLowerCase().replace(/^@/, "") : value,
        };
    }
    if (field === "subject" || field === "snippet") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "contains") return `${where}: ${field}.op must be contains`;
        if (!value) return `${where}: ${field}.value is required (max ${MAX_VALUE} characters)`;
        return { field, op, value };
    }
    if (field === "label") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "equals") return `${where}: label.op must be equals`;
        if (!value) return `${where}: label.value is required`;
        return { field, op, value };
    }
    if (field === "header") {
        const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
        if (op !== "present") return `${where}: header.op must be present`;
        if (!HEADER_NAME.test(name))
            return `${where}: header.name must be a plain header name (letters, digits, dashes)`;
        return { field, op, name };
    }
    return `${where}: unknown condition field (allowed: from, subject, snippet, label, header)`;
}

function parseAction(raw: unknown, where: string): GuardAction | string {
    if (!isRecord(raw)) return `${where}: action must be an object`;
    if (raw["type"] === "drop") return { type: "drop" };
    if (raw["type"] === "tag") {
        const tag = str(raw["tag"], MAX_TAG);
        return tag ? { type: "tag", tag } : `${where}: tag is required (max ${MAX_TAG} characters)`;
    }
    if (raw["type"] === "set_priority") {
        const priority = raw["priority"];
        return PRIORITIES.includes(priority as AcediaEventPriority)
            ? { type: "set_priority", priority: priority as AcediaEventPriority }
            : `${where}: priority must be urgent, normal or info`;
    }
    return `${where}: unknown action type (allowed: drop, tag, set_priority)`;
}

/**
 * Strict validation of a whole rule list (a form submits the full list). Unknown fields are ignored,
 * unknown *kinds* are refused — a typo must never silently become a rule that does something else.
 * Rules missing an id get a fresh one; duplicate ids are refused.
 */
export function validateRules(input: unknown): RulesValidation {
    if (!Array.isArray(input)) return { ok: false, error: "rules must be an array" };
    if (input.length > MAX_RULES) return { ok: false, error: `too many rules (max ${MAX_RULES})` };
    const rules: GuardRule[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < input.length; i++) {
        const where = `rule ${i + 1}`;
        const raw = input[i];
        if (!isRecord(raw)) return { ok: false, error: `${where}: must be an object` };
        const name = str(raw["name"], MAX_NAME);
        if (!name)
            return { ok: false, error: `${where}: name is required (max ${MAX_NAME} characters)` };
        const rawConditions = raw["conditions"];
        if (!Array.isArray(rawConditions) || rawConditions.length === 0)
            return { ok: false, error: `${where}: at least one condition is required` };
        if (rawConditions.length > MAX_CONDITIONS)
            return { ok: false, error: `${where}: too many conditions (max ${MAX_CONDITIONS})` };
        const rawActions = raw["actions"];
        if (!Array.isArray(rawActions) || rawActions.length === 0)
            return { ok: false, error: `${where}: at least one action is required` };
        if (rawActions.length > MAX_ACTIONS)
            return { ok: false, error: `${where}: too many actions (max ${MAX_ACTIONS})` };

        const conditions: GuardCondition[] = [];
        for (const c of rawConditions) {
            const parsed = parseCondition(c, where);
            if (typeof parsed === "string") return { ok: false, error: parsed };
            conditions.push(parsed);
        }
        const actions: GuardAction[] = [];
        for (const a of rawActions) {
            const parsed = parseAction(a, where);
            if (typeof parsed === "string") return { ok: false, error: parsed };
            actions.push(parsed);
        }
        const id =
            typeof raw["id"] === "string" && raw["id"].trim() ? raw["id"].trim() : randomUUID();
        if (ids.has(id)) return { ok: false, error: `${where}: duplicate id "${id}"` };
        ids.add(id);
        rules.push({ id, name, enabled: raw["enabled"] !== false, conditions, actions });
    }
    return { ok: true, rules };
}

function resolvePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "guard_rules.json");
}

interface PersistedRules {
    v: 1;
    version: number;
    rules: GuardRule[];
}

/**
 * The user's guard rules, persisted as a versioned JSON file (same STORAGE_DIR convention as the
 * other stores). `version` increments whenever the rule list actually changes — the verdict cache
 * keys on it, so editing a rule invalidates exactly the verdicts it could have changed.
 */
export class GuardRulesStore {
    private rules: GuardRule[] = [];
    private version = 0;
    private readonly filePath: string;

    constructor(filePath?: string) {
        this.filePath = filePath ?? resolvePath();
    }

    async load(): Promise<void> {
        try {
            const raw = JSON.parse(
                await fs.readFile(this.filePath, "utf-8"),
            ) as Partial<PersistedRules>;
            const parsed = validateRules(raw.rules ?? []);
            if (parsed.ok) {
                this.rules = parsed.rules;
                this.version =
                    typeof raw.version === "number" && raw.version >= 0 ? raw.version : 0;
            } else {
                console.error(
                    "[Guards] guard_rules.json is invalid, starting with no rules:",
                    parsed.error,
                );
            }
        } catch {
            // File absent or unreadable — no rules, that is the safe default (nothing is ever dropped)
        }
    }

    getRules(): GuardRule[] {
        return this.rules.map((r) => structuredClone(r));
    }

    /** Read-only view of the live list, for the per-event hot path (getRules() clones everything). */
    peekRules(): readonly GuardRule[] {
        return this.rules;
    }

    getVersion(): number {
        return this.version;
    }

    /** Replaces the whole list. Returns the validation error instead of persisting anything invalid. */
    async replaceAll(
        input: unknown,
    ): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
        const parsed = validateRules(input);
        if (!parsed.ok) return parsed;
        if (JSON.stringify(parsed.rules) !== JSON.stringify(this.rules)) {
            this.rules = parsed.rules;
            this.version += 1;
            await this.save();
        }
        return { ok: true, version: this.version };
    }

    private async save(): Promise<void> {
        const payload: PersistedRules = { v: 1, version: this.version, rules: this.rules };
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
        } catch (e) {
            console.error("[Guards] Failed to persist guard rules:", (e as Error).message);
        }
    }
}
