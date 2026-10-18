import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    indexDossiers,
    type Dossier,
    type DossierMember,
    type DossierProposal,
    type IndexInput,
} from "./dossier_index.js";
import type { DossierDigest, FactDraft } from "./dossier_digest.js";

/** Where the dossiers live — STORAGE_DIR, kept across image updates. */
export function defaultDossierPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "dossiers.json");
}

const MAX_TITLE = 120;
const MAX_LABEL = 60;
const MAX_REPOS = 20;
/** Candidates kept for the hub to ask for — the oldest go first past this. */
const MAX_CANDIDATES = 500;

/** A fact the daily pass drew from a dossier, waiting for the hub: it only ever proposes it to its owner. */
export interface FactCandidate extends FactDraft {
    /** Rising number: the hub asks for what came after the last one it took. */
    seq: number;
    dossierId: string;
    dossierTitle: string;
    at: number;
}

export interface DossierSettings {
    /** The daily pass (summaries and facts) — off until Master turns it on. « Résumer maintenant » works either way. */
    digestEnabled: boolean;
}

interface DossierFile {
    version: 1;
    dossiers: Dossier[];
    candidates?: FactCandidate[];
    seq?: number;
    settings?: DossierSettings;
    /** The day (YYYY-MM-DD, local) of the last daily pass. */
    lastPassDay?: string;
}

export type DossierEdit = { title?: string; label?: string | null; repos?: string[] };

/** Why an edit is refused, or null. */
export function validateDossierEdit(input: unknown, creating = false): string | null {
    if (typeof input !== "object" || input === null) return "Body must be an object";
    const p = input as Record<string, unknown>;
    if (creating && typeof p["title"] !== "string" && typeof p["label"] !== "string")
        return "A dossier needs a title or a label";
    if (
        p["title"] !== undefined &&
        (typeof p["title"] !== "string" || !p["title"].trim() || p["title"].length > MAX_TITLE)
    )
        return `title must be a text of ${MAX_TITLE} characters at most`;
    if (
        p["label"] !== undefined &&
        p["label"] !== null &&
        (typeof p["label"] !== "string" || !p["label"].trim() || p["label"].length > MAX_LABEL)
    )
        return `label must be a text of ${MAX_LABEL} characters at most`;
    if (p["repos"] !== undefined) {
        const r = p["repos"];
        if (
            !Array.isArray(r) ||
            r.length > MAX_REPOS ||
            !r.every((x) => typeof x === "string" && /^[^/\s]+\/[^/\s]+$/.test(x))
        )
            return `repos must be a list of ${MAX_REPOS} « owner/name » at most`;
    }
    return null;
}

/**
 * The dossiers, on disk: one file, rewritten atomically; writes chained so they land in order. Indexing
 * (`dossier_index.ts`) adds what the sources group; Master's gestures attach, detach, decline a proposal, label.
 * The proposals are worked out again at each index — never stored.
 */
export class DossierStore {
    private dossiers: Dossier[] = [];
    private proposals: DossierProposal[] = [];
    private candidates: FactCandidate[] = [];
    private seq = 0;
    private settingsValue: DossierSettings = { digestEnabled: false };
    private lastPassDayValue: string | undefined;
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly filePath?: string) {}

    /** A missing or unreadable file means no dossier yet — the next index makes them again — never a crash. */
    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(
                await fs.readFile(this.filePath, "utf-8"),
            ) as Partial<DossierFile>;
            this.dossiers = Array.isArray(parsed.dossiers) ? parsed.dossiers : [];
            this.candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
            this.seq = typeof parsed.seq === "number" ? parsed.seq : 0;
            this.settingsValue = { digestEnabled: parsed.settings?.digestEnabled === true };
            this.lastPassDayValue = parsed.lastPassDay;
        } catch {
            this.dossiers = [];
        }
    }

    flush(): Promise<void> {
        return this.chain;
    }

    list(): Dossier[] {
        return structuredClone([...this.dossiers].sort((a, b) => b.updatedAt - a.updatedAt));
    }

    get(id: string): Dossier | undefined {
        const d = this.dossiers.find((x) => x.id === id);
        return d ? structuredClone(d) : undefined;
    }

    proposalsFor(id?: string): DossierProposal[] {
        return structuredClone(
            id ? this.proposals.filter((p) => p.dossierId === id) : this.proposals,
        );
    }

    settings(): DossierSettings {
        return { ...this.settingsValue };
    }

    setSettings(patch: Partial<DossierSettings>): DossierSettings {
        if (typeof patch.digestEnabled === "boolean")
            this.settingsValue.digestEnabled = patch.digestEnabled;
        this.persist();
        return this.settings();
    }

    lastPassDay(): string | undefined {
        return this.lastPassDayValue;
    }

    markPass(day: string): void {
        this.lastPassDayValue = day;
        this.persist();
    }

    /** A summary of the daily pass, and the facts it drew — candidates for the hub, numbered in order. */
    setDigest(id: string, digest: DossierDigest, facts: FactDraft[]): boolean {
        const d = this.dossiers.find((x) => x.id === id);
        if (!d) return false;
        d.digest = digest;
        for (const fact of facts)
            this.candidates.push({
                ...fact,
                seq: ++this.seq,
                dossierId: d.id,
                dossierTitle: d.title,
                at: digest.at,
            });
        if (this.candidates.length > MAX_CANDIDATES)
            this.candidates = this.candidates.slice(-MAX_CANDIDATES);
        this.persist();
        return true;
    }

    /** What came after `cursor` — the hub keeps the cursor it is given back. */
    candidatesAfter(cursor: number): { candidates: FactCandidate[]; cursor: number } {
        return {
            candidates: structuredClone(this.candidates.filter((c) => c.seq > cursor)),
            cursor: this.seq,
        };
    }

    /** Brings the dossiers up to date with the box and the planning; writes only when something changed. */
    index(input: Omit<IndexInput, "newId">): void {
        const r = indexDossiers(this.dossiers, { ...input, newId: () => `dos_${randomUUID()}` });
        this.dossiers = r.dossiers;
        this.proposals = r.proposals;
        if (r.changed) this.persist();
    }

    create(edit: DossierEdit, now = Date.now()): Dossier {
        const label = edit.label?.trim();
        const d: Dossier = {
            id: `dos_${randomUUID()}`,
            title: edit.title?.trim() || label || "Dossier",
            ...(label && { label }),
            repos: edit.repos ?? [],
            members: [],
            detached: [],
            dismissed: [],
            createdAt: now,
            updatedAt: now,
        };
        this.dossiers.push(d);
        this.persist();
        return structuredClone(d);
    }

    update(id: string, edit: DossierEdit, now = Date.now()): Dossier | undefined {
        const d = this.dossiers.find((x) => x.id === id);
        if (!d) return undefined;
        if (edit.title !== undefined) d.title = edit.title.trim();
        if (edit.label === null) delete d.label;
        else if (edit.label !== undefined) d.label = edit.label.trim();
        if (edit.repos !== undefined) d.repos = edit.repos;
        d.updatedAt = now;
        this.persist();
        return structuredClone(d);
    }

    /** Master's hand: in it, and no longer detached. A proposal accepted is this too. */
    attach(id: string, member: DossierMember, now = Date.now()): Dossier | undefined {
        const d = this.dossiers.find((x) => x.id === id);
        if (!d) return undefined;
        d.detached = d.detached.filter((r) => r !== member.ref);
        if (!d.members.some((m) => m.ref === member.ref))
            d.members.push({ ...member, reason: "manual" });
        d.members.sort((a, b) => a.at - b.at);
        this.proposals = this.proposals.filter(
            (p) => !(p.dossierId === id && p.member.ref === member.ref),
        );
        d.updatedAt = now;
        this.persist();
        return structuredClone(d);
    }

    /** Out, and never brought back on its own. */
    detach(id: string, ref: string, now = Date.now()): Dossier | undefined {
        const d = this.dossiers.find((x) => x.id === id);
        if (!d) return undefined;
        d.members = d.members.filter((m) => m.ref !== ref);
        if (!d.detached.includes(ref)) d.detached.push(ref);
        d.updatedAt = now;
        this.persist();
        return structuredClone(d);
    }

    /** A proposal declined: never proposed again. */
    dismiss(id: string, ref: string, now = Date.now()): boolean {
        const d = this.dossiers.find((x) => x.id === id);
        if (!d) return false;
        if (!d.dismissed.includes(ref)) d.dismissed.push(ref);
        this.proposals = this.proposals.filter(
            (p) => !(p.dossierId === id && p.member.ref === ref),
        );
        d.updatedAt = now;
        this.persist();
        return true;
    }

    private persist(): void {
        if (!this.filePath) return;
        const file = this.filePath;
        const body: DossierFile = {
            version: 1,
            dossiers: this.dossiers,
            candidates: this.candidates,
            seq: this.seq,
            settings: this.settingsValue,
            ...(this.lastPassDayValue && { lastPassDay: this.lastPassDayValue }),
        };
        const text = JSON.stringify(body);
        this.chain = this.chain
            .then(async () => {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const tmp = `${file}.tmp`;
                await fs.writeFile(tmp, text, "utf-8");
                await fs.rename(tmp, file);
            })
            .catch((e: Error) => console.error("[Dossiers] Failed to persist:", e.message));
    }
}
