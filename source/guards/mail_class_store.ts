import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
    DEFAULT_CLASSES,
    MAIL_CLASSES,
    type ClassSettings,
    type ClassTable,
    type MailClass,
} from "./mail_class.js";

const MAX_SENDERS = 500;
const MAX_SENDER = 200;

export interface MailClassConfig {
    classes: ClassTable;
    /** Senders whose mail is personal (family, friends): a name, an address or a part of one. */
    personalSenders: string[];
}

export type MailClassPatch = {
    classes?: Partial<Record<MailClass, Partial<ClassSettings>>>;
    personalSenders?: string[];
};

function defaultPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "mail_classes.json");
}

function copyTable(t: ClassTable): ClassTable {
    return Object.fromEntries(MAIL_CLASSES.map((c) => [c, { ...t[c] }])) as ClassTable;
}

/** Why a patch is refused, or null when it is valid. */
export function validateMailClassPatch(input: unknown): string | null {
    if (typeof input !== "object" || input === null) return "Body must be an object";
    const p = input as Record<string, unknown>;
    if (p["classes"] !== undefined) {
        if (typeof p["classes"] !== "object" || p["classes"] === null)
            return "classes must be an object";
        for (const [name, settings] of Object.entries(p["classes"] as Record<string, unknown>)) {
            if (!(MAIL_CLASSES as readonly string[]).includes(name))
                return `Unknown class "${name}"`;
            if (typeof settings !== "object" || settings === null)
                return `${name} must be an object`;
            for (const [k, v] of Object.entries(settings as Record<string, unknown>)) {
                if (!["visible", "ai", "rings"].includes(k))
                    return `${name}: unknown setting "${k}"`;
                if (typeof v !== "boolean") return `${name}.${k} must be true or false`;
            }
        }
    }
    if (p["personalSenders"] !== undefined) {
        const s = p["personalSenders"];
        if (!Array.isArray(s) || !s.every((x) => typeof x === "string" && x.length <= MAX_SENDER))
            return `personalSenders must be a list of texts (${MAX_SENDER} characters at most)`;
        if (s.length > MAX_SENDERS) return `At most ${MAX_SENDERS} personal senders`;
    }
    return null;
}

/**
 * The classes of mail and the personal senders, one JSON file next to the other settings. Read synchronously by the
 * collection and by every call that hands the box to a model; `version` changes on every edit, so a mail kept out under
 * the old settings is looked at again.
 */
export class MailClassStore {
    private config: MailClassConfig = { classes: copyTable(DEFAULT_CLASSES), personalSenders: [] };
    private version = 0;

    constructor(private readonly file: string = defaultPath()) {}

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await fs.readFile(this.file, "utf-8")) as unknown;
            if (validateMailClassPatch(parsed) === null) this.apply(parsed as MailClassPatch);
        } catch {
            // Absent or unreadable: the defaults.
        }
    }

    table(): ClassTable {
        return this.config.classes;
    }

    personalSenders(): string[] {
        return this.config.personalSenders;
    }

    getVersion(): number {
        return this.version;
    }

    get(): MailClassConfig {
        return {
            classes: copyTable(this.config.classes),
            personalSenders: [...this.config.personalSenders],
        };
    }

    /** Applies a validated patch and saves it. */
    async patch(patch: MailClassPatch): Promise<MailClassConfig> {
        this.apply(patch);
        this.version++;
        await this.save();
        return this.get();
    }

    private apply(patch: MailClassPatch): void {
        const classes = copyTable(this.config.classes);
        for (const c of MAIL_CLASSES) Object.assign(classes[c], patch.classes?.[c] ?? {});
        this.config = {
            classes,
            personalSenders:
                patch.personalSenders?.map((s) => s.trim()).filter((s) => s !== "") ??
                this.config.personalSenders,
        };
    }

    private async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.config, null, 2), "utf-8");
        await fs.rename(tmp, this.file);
    }
}
