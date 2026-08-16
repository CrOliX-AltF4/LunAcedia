import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EmailClassificationConfig } from "../../types/email_classification.js";
import { DEFAULT_EMAIL_CLASSIFICATION } from "../../types/email_classification.js";
import type { EmailRule } from "./email_rules.js";

function resolveConfigPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "email_classification.json");
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Structured, panel-editable email classification — VIP senders / urgent keywords / normal
 * keywords, compiled into the same EmailRule[] shape email_rules.ts already consumes.
 * Persisted the same way ActionTierStore is (STORAGE_DIR JSON file).
 *
 * GMAIL_RULES (raw JSON, .env) remains supported as a fallback for anyone who already has
 * it configured — GmailConnector only uses compileRules() output when this store actually
 * has something in it, so a fresh install with GMAIL_RULES set keeps working unchanged.
 */
export class EmailClassificationStore {
    private config: EmailClassificationConfig = { ...DEFAULT_EMAIL_CLASSIFICATION };
    private readonly configPath: string;

    constructor(configPath?: string) {
        this.configPath = configPath ?? resolveConfigPath();
    }

    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.configPath, "utf-8");
            const parsed = JSON.parse(raw) as Partial<EmailClassificationConfig>;
            if (isStringArray(parsed.vipSenders)) this.config.vipSenders = parsed.vipSenders;
            if (isStringArray(parsed.urgentKeywords))
                this.config.urgentKeywords = parsed.urgentKeywords;
            if (isStringArray(parsed.normalKeywords))
                this.config.normalKeywords = parsed.normalKeywords;
        } catch {
            // File absent or unreadable — keep defaults (empty), that's fine
        }
    }

    getAll(): EmailClassificationConfig {
        return {
            vipSenders: [...this.config.vipSenders],
            urgentKeywords: [...this.config.urgentKeywords],
            normalKeywords: [...this.config.normalKeywords],
        };
    }

    /** True once anything has ever been configured — GmailConnector's signal to prefer this over GMAIL_RULES. */
    isConfigured(): boolean {
        return (
            this.config.vipSenders.length > 0 ||
            this.config.urgentKeywords.length > 0 ||
            this.config.normalKeywords.length > 0
        );
    }

    /** vipSenders and urgentKeywords both map to "urgent" (senders take precedence — checked first),
     *  normalKeywords maps to "normal"; first match wins downstream in classifyEmail(). */
    compileRules(): EmailRule[] {
        return [
            ...this.config.vipSenders.map((s): EmailRule => ({
                senderPattern: s,
                priority: "urgent",
                label: "VIP",
            })),
            ...this.config.urgentKeywords.map((k): EmailRule => ({
                senderPattern: k,
                priority: "urgent",
                label: "urgent keyword",
            })),
            ...this.config.normalKeywords.map((k): EmailRule => ({
                senderPattern: k,
                priority: "normal",
                label: "normal keyword",
            })),
        ];
    }

    async patch(updates: Partial<EmailClassificationConfig>): Promise<void> {
        if (isStringArray(updates.vipSenders)) this.config.vipSenders = updates.vipSenders;
        if (isStringArray(updates.urgentKeywords))
            this.config.urgentKeywords = updates.urgentKeywords;
        if (isStringArray(updates.normalKeywords))
            this.config.normalKeywords = updates.normalKeywords;
        await this.save();
    }

    private async save(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.configPath), { recursive: true });
            await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
        } catch (e) {
            console.error("[EmailClassification] Failed to persist:", (e as Error).message);
        }
    }
}
