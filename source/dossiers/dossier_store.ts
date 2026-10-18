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
    type MemberKind,
} from "./dossier_index.js";

/** Where the dossiers live — STORAGE_DIR, kept across image updates. */
export function defaultDossierPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "dossiers.json");
}

const MAX_TITLE = 120;
const MAX_LABEL = 60;
const MAX_REPOS = 20;
const MEMBER_KINDS: readonly MemberKind[] = ["mail", "event", "task", "github"];

interface DossierFile {
    version: 1;
    dossiers: Dossier[];
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

/** Why a member to attach is refused, or null. */
export function validateMember(input: unknown): string | null {
    if (typeof input !== "object" || input === null) return "Body must be an object";
    const p = input as Record<string, unknown>;
    if (!MEMBER_KINDS.includes(p["kind"] as MemberKind))
        return `kind must be one of ${MEMBER_KINDS.join(", ")}`;
    if (typeof p["ref"] !== "string" || !p["ref"]) return "ref is required";
    if (typeof p["title"] !== "string") return "title is required";
    if (typeof p["at"] !== "number") return "at is required";
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
        const body: DossierFile = { version: 1, dossiers: this.dossiers };
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
