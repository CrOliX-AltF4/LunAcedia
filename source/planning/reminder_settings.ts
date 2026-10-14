import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    DEFAULT_REMINDER_SETTINGS,
    REMINDER_RULES,
    type ReminderSettings,
} from "./reminder_rules.js";

export function defaultReminderSettingsPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "reminder_settings.json");
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

type Check = { ok: true; value: ReminderSettings } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Applies a partial change to the settings, checked field by field — anything unknown or out of range refuses the
 * whole change, saying which field.
 */
export function mergeReminderSettings(current: ReminderSettings, patch: unknown): Check {
    if (!isObj(patch)) return { ok: false, error: "an object is expected" };
    const next: ReminderSettings = structuredClone(current);
    for (const [k, v] of Object.entries(patch)) {
        if (k === "enabled") {
            if (typeof v !== "boolean") return { ok: false, error: "enabled: true or false" };
            next.enabled = v;
        } else if (k === "quietStart" || k === "quietEnd") {
            if (typeof v !== "string" || !HHMM.test(v)) return { ok: false, error: `${k}: HH:MM` };
            next[k] = v;
        } else if (k === "rules") {
            if (!isObj(v)) return { ok: false, error: "rules: an object" };
            for (const [rule, rv] of Object.entries(v)) {
                if (!REMINDER_RULES.includes(rule as never))
                    return { ok: false, error: `rules.${rule}: unknown rule` };
                if (!isObj(rv)) return { ok: false, error: `rules.${rule}: an object` };
                const target = next.rules[rule as keyof ReminderSettings["rules"]] as Record<
                    string,
                    unknown
                >;
                for (const [field, fv] of Object.entries(rv)) {
                    const where = `rules.${rule}.${field}`;
                    if (!(field in target)) return { ok: false, error: `${where}: unknown field` };
                    if (field === "enabled") {
                        if (typeof fv !== "boolean")
                            return { ok: false, error: `${where}: true or false` };
                    } else if (field === "time") {
                        if (typeof fv !== "string" || !HHMM.test(fv))
                            return { ok: false, error: `${where}: HH:MM` };
                    } else if (field === "minutesBefore") {
                        if (!Number.isInteger(fv) || (fv as number) < 5 || (fv as number) > 1440)
                            return { ok: false, error: `${where}: 5 to 1440 minutes` };
                    } else if (!Number.isInteger(fv) || (fv as number) < 1 || (fv as number) > 60) {
                        return { ok: false, error: `${where}: 1 to 60 days` };
                    }
                    target[field] = fv;
                }
            }
        } else {
            return { ok: false, error: `${k}: unknown setting` };
        }
    }
    return { ok: true, value: next };
}

/** The reminder settings, kept in STORAGE_DIR. A missing or unreadable file means the defaults. */
export class ReminderSettingsStore {
    private settings: ReminderSettings = structuredClone(DEFAULT_REMINDER_SETTINGS);

    constructor(private readonly filePath?: string) {}

    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const raw = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            const merged = mergeReminderSettings(DEFAULT_REMINDER_SETTINGS, raw);
            if (merged.ok) this.settings = merged.value;
            else console.warn(`[Reminders] settings file ignored — ${merged.error}`);
        } catch {
            // first run, or unreadable: the defaults
        }
    }

    get(): ReminderSettings {
        return structuredClone(this.settings);
    }

    async set(patch: unknown): Promise<Check> {
        const merged = mergeReminderSettings(this.settings, patch);
        if (!merged.ok) return merged;
        this.settings = merged.value;
        if (this.filePath) {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), "utf-8");
            await fs.rename(tmp, this.filePath);
        }
        return { ok: true, value: this.get() };
    }
}
