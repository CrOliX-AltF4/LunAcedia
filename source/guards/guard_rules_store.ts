import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AcediaEventPriority } from "../types/acedia_event.js";
import type { GuardAction, GuardCondition, GuardRule, RuleSourceKind } from "./guard_types.js";

const MAX_RULES = 200;
const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 5;
const MAX_VALUE = 200;
const MAX_NAME = 80;
const MAX_TAG = 40;
const PRIORITIES: readonly AcediaEventPriority[] = ["urgent", "normal", "info"];
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;
const SOURCE_KINDS: readonly RuleSourceKind[] = [
    "archive_email",
    "delete_email",
    "mark_spam",
    "mark_email_read",
    "star_email",
    "label_email",
];

/**
 * Where a rule list is wrong, in a form a client can translate and point at (live check C21: the panel showed the
 * English sentence verbatim). `rule` and `index` are 0-based; `part` is the rule's field at fault.
 */
export interface RuleProblem {
    code:
        | "not_a_list"
        | "too_many_rules"
        | "invalid_rule"
        | "name_required"
        | "conditions_required"
        | "too_many_conditions"
        | "actions_required"
        | "too_many_actions"
        | "invalid_condition"
        | "value_required"
        | "header_name_invalid"
        | "invalid_action"
        | "tag_required"
        | "label_required"
        | "duplicate_id";
    rule?: number;
    part?: "name" | "conditions" | "actions";
    index?: number;
}

/** `error` stays the English sentence (logs, older clients); `problem` is the structured form. */
export type RulesValidation =
    { ok: true; rules: GuardRule[] } | { ok: false; error: string; problem: RuleProblem };

type Fail = { message: string; code: RuleProblem["code"] };
const fail = (message: string, code: RuleProblem["code"]): Fail => ({ message, code });

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 && t.length <= max ? t : null;
}

function parseCondition(raw: unknown, where: string): GuardCondition | Fail {
    if (!isRecord(raw)) return fail(`${where}: condition must be an object`, "invalid_condition");
    const field = raw["field"];
    const op = raw["op"];
    if (field === "from") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "equals" && op !== "contains" && op !== "domain")
            return fail(
                `${where}: from.op must be equals, contains or domain`,
                "invalid_condition",
            );
        if (!value)
            return fail(
                `${where}: from.value is required (max ${MAX_VALUE} characters)`,
                "value_required",
            );
        return {
            field,
            op,
            value: op === "domain" ? value.toLowerCase().replace(/^@/, "") : value,
        };
    }
    if (field === "subject" || field === "snippet") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "contains")
            return fail(`${where}: ${field}.op must be contains`, "invalid_condition");
        if (!value)
            return fail(
                `${where}: ${field}.value is required (max ${MAX_VALUE} characters)`,
                "value_required",
            );
        return { field, op, value };
    }
    if (field === "label") {
        const value = str(raw["value"], MAX_VALUE);
        if (op !== "equals") return fail(`${where}: label.op must be equals`, "invalid_condition");
        if (!value) return fail(`${where}: label.value is required`, "value_required");
        return { field, op, value };
    }
    if (field === "header") {
        const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
        if (op !== "present")
            return fail(`${where}: header.op must be present`, "invalid_condition");
        if (!HEADER_NAME.test(name))
            return fail(
                `${where}: header.name must be a plain header name (letters, digits, dashes)`,
                "header_name_invalid",
            );
        return { field, op, name };
    }
    return fail(
        `${where}: unknown condition field (allowed: from, subject, snippet, label, header)`,
        "invalid_condition",
    );
}

function parseAction(raw: unknown, where: string): GuardAction | Fail {
    if (!isRecord(raw)) return fail(`${where}: action must be an object`, "invalid_action");
    if (raw["type"] === "drop") return { type: "drop" };
    if (raw["type"] === "tag") {
        const tag = str(raw["tag"], MAX_TAG);
        return tag
            ? { type: "tag", tag }
            : fail(`${where}: tag is required (max ${MAX_TAG} characters)`, "tag_required");
    }
    if (raw["type"] === "set_priority") {
        const priority = raw["priority"];
        return PRIORITIES.includes(priority as AcediaEventPriority)
            ? { type: "set_priority", priority: priority as AcediaEventPriority }
            : fail(`${where}: priority must be urgent, normal or info`, "invalid_action");
    }
    if (raw["type"] === "source") {
        const action = raw["action"];
        if (!SOURCE_KINDS.includes(action as RuleSourceKind))
            return fail(`${where}: source.action must be one of ${SOURCE_KINDS.join(", ")}`, "invalid_action");
        if (action === "label_email") {
            const label = str(raw["label"], MAX_TAG);
            return label
                ? { type: "source", action, label }
                : fail(`${where}: label is required (max ${MAX_TAG} characters)`, "label_required");
        }
        return { type: "source", action: action as RuleSourceKind };
    }
    return fail(
        `${where}: unknown action type (allowed: drop, tag, set_priority, source)`,
        "invalid_action",
    );
}

/**
 * Strict validation of a whole rule list (a form submits the full list). Unknown fields are ignored,
 * unknown *kinds* are refused — a typo must never silently become a rule that does something else.
 * Rules missing an id get a fresh one; duplicate ids are refused.
 */
export function validateRules(input: unknown): RulesValidation {
    const refuse = (error: string, problem: RuleProblem): RulesValidation => ({
        ok: false,
        error,
        problem,
    });
    if (!Array.isArray(input)) return refuse("rules must be an array", { code: "not_a_list" });
    if (input.length > MAX_RULES)
        return refuse(`too many rules (max ${MAX_RULES})`, { code: "too_many_rules" });
    const rules: GuardRule[] = [];
    const ids = new Set<string>();
    for (let i = 0; i < input.length; i++) {
        const where = `rule ${i + 1}`;
        const raw = input[i];
        if (!isRecord(raw))
            return refuse(`${where}: must be an object`, { code: "invalid_rule", rule: i });
        const name = str(raw["name"], MAX_NAME);
        if (!name)
            return refuse(`${where}: name is required (max ${MAX_NAME} characters)`, {
                code: "name_required",
                rule: i,
                part: "name",
            });
        const rawConditions = raw["conditions"];
        if (!Array.isArray(rawConditions) || rawConditions.length === 0)
            return refuse(`${where}: at least one condition is required`, {
                code: "conditions_required",
                rule: i,
                part: "conditions",
            });
        if (rawConditions.length > MAX_CONDITIONS)
            return refuse(`${where}: too many conditions (max ${MAX_CONDITIONS})`, {
                code: "too_many_conditions",
                rule: i,
                part: "conditions",
            });
        const rawActions = raw["actions"];
        if (!Array.isArray(rawActions) || rawActions.length === 0)
            return refuse(`${where}: at least one action is required`, {
                code: "actions_required",
                rule: i,
                part: "actions",
            });
        if (rawActions.length > MAX_ACTIONS)
            return refuse(`${where}: too many actions (max ${MAX_ACTIONS})`, {
                code: "too_many_actions",
                rule: i,
                part: "actions",
            });

        const conditions: GuardCondition[] = [];
        for (let j = 0; j < rawConditions.length; j++) {
            const parsed = parseCondition(rawConditions[j], where);
            if ("message" in parsed)
                return refuse(parsed.message, {
                    code: parsed.code,
                    rule: i,
                    part: "conditions",
                    index: j,
                });
            conditions.push(parsed);
        }
        const actions: GuardAction[] = [];
        for (let j = 0; j < rawActions.length; j++) {
            const parsed = parseAction(rawActions[j], where);
            if ("message" in parsed)
                return refuse(parsed.message, {
                    code: parsed.code,
                    rule: i,
                    part: "actions",
                    index: j,
                });
            actions.push(parsed);
        }
        const id =
            typeof raw["id"] === "string" && raw["id"].trim() ? raw["id"].trim() : randomUUID();
        if (ids.has(id))
            return refuse(`${where}: duplicate id "${id}"`, { code: "duplicate_id", rule: i });
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
    /** Rules may act at the source — absent = on. */
    sourceActions?: boolean;
}

/**
 * The user's guard rules, persisted as a versioned JSON file (same STORAGE_DIR convention as the
 * other stores). `version` increments whenever the rule list actually changes — the verdict cache
 * keys on it, so editing a rule invalidates exactly the verdicts it could have changed.
 */
export class GuardRulesStore {
    private rules: GuardRule[] = [];
    private version = 0;
    private sourceActions = true;
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
                if (typeof raw.sourceActions === "boolean") this.sourceActions = raw.sourceActions;
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
    ): Promise<{ ok: true; version: number } | { ok: false; error: string; problem: RuleProblem }> {
        const parsed = validateRules(input);
        if (!parsed.ok) return parsed;
        if (JSON.stringify(parsed.rules) !== JSON.stringify(this.rules)) {
            this.rules = parsed.rules;
            this.version += 1;
            await this.save();
        }
        return { ok: true, version: this.version };
    }

    /** The one switch over every rule's actions at the source (law 3) — off, rules only sort the box. */
    sourceActionsEnabled(): boolean {
        return this.sourceActions;
    }

    async setSourceActionsEnabled(enabled: boolean): Promise<void> {
        this.sourceActions = enabled;
        await this.save();
    }

    /** Adds one rule (a confirmed proposal) at the end of the list, validated like the rest. */
    async add(input: unknown): Promise<{ ok: true; version: number; id: string } | { ok: false; error: string }> {
        const parsed = validateRules([...this.rules, input]);
        if (!parsed.ok) return parsed;
        this.rules = parsed.rules;
        this.version += 1;
        await this.save();
        return { ok: true, version: this.version, id: this.rules[this.rules.length - 1]!.id };
    }

    private async save(): Promise<void> {
        const payload: PersistedRules = {
            v: 1,
            version: this.version,
            rules: this.rules,
            sourceActions: this.sourceActions,
        };
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
        } catch (e) {
            console.error("[Guards] Failed to persist guard rules:", (e as Error).message);
        }
    }
}
