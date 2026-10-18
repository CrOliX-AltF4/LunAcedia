/**
 * The dossiers — read, and Master's own gestures on them. Admin only.
 *
 *   GET   /api/dossiers                         { dossiers: DossierSummary[], proposals: number }
 *   GET   /api/dossiers/:id                     { dossier, proposals: DossierProposal[] }
 *   POST  /api/dossiers                         { title?, label?, repos? } → 201 the dossier (a label: a project)
 *   PATCH /api/dossiers/:id                     { title?, label? (null: none), repos? }
 *   POST  /api/dossiers/:id/attach              { ref } — a box key or a planning id; refused for what a model may
 *                                               not read
 *   POST  /api/dossiers/:id/detach              { ref } — out, never brought back on its own
 *   POST  /api/dossiers/:id/dismiss             { ref } — a proposal declined, never proposed again
 *   POST  /api/dossiers/:id/digest              « Résumer maintenant »: summed up now, whatever the daily switch
 *   GET   /api/dossiers/candidates?after=<n>    { candidates: FactCandidate[], cursor } — the facts the daily pass drew,
 *                                               after the hub's cursor; the hub keeps the cursor it is given back
 *   GET   /api/dossiers/settings                { digestEnabled }
 *   PATCH /api/dossiers/settings                { digestEnabled }
 */
import type http from "node:http";
import type { DossierStore } from "../dossiers/dossier_store.js";
import { validateDossierEdit, type DossierEdit } from "../dossiers/dossier_store.js";
import type { Dossier, DossierMember } from "../dossiers/dossier_index.js";

export interface DossierSummary {
    id: string;
    title: string;
    label?: string;
    repos: string[];
    count: number;
    updatedAt: number;
    /** The latest member — what the list shows under the title. */
    last?: Pick<DossierMember, "kind" | "title" | "at">;
    proposals: number;
}

export interface DossierRouteDeps {
    store: DossierStore;
    /** The item a ref names, as a member — undefined when nothing does, or when a model may not read it. */
    resolve: (ref: string) => DossierMember | undefined;
    /** « Résumer maintenant » — absent without a model: the gesture answers 503. */
    digest?: (ids: string[]) => Promise<{ digested: string[]; failed: string[] }>;
    readBody: (req: http.IncomingMessage) => Promise<unknown>;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export function summarize(d: Dossier, proposals: number): DossierSummary {
    const last = d.members.at(-1);
    return {
        id: d.id,
        title: d.title,
        ...(d.label && { label: d.label }),
        repos: d.repos,
        count: d.members.length,
        updatedAt: d.updatedAt,
        ...(last && { last: { kind: last.kind, title: last.title, at: last.at } }),
        proposals,
    };
}

export class DossierRoutes {
    constructor(private readonly deps: DossierRouteDeps) {}

    /** Handles the request if it is a dossier route; returns false otherwise. */
    async handle(
        method: string,
        path: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<boolean> {
        if (path !== "/api/dossiers" && !path.startsWith("/api/dossiers/")) return false;
        const { store, json } = this.deps;

        if (path === "/api/dossiers") {
            if (method === "GET") {
                const proposals = store.proposalsFor();
                json(res, 200, {
                    dossiers: store
                        .list()
                        .map((d) =>
                            summarize(d, proposals.filter((p) => p.dossierId === d.id).length),
                        ),
                    proposals: proposals.length,
                });
                return true;
            }
            if (method === "POST") {
                const body = await this.body(req, res);
                if (body === undefined) return true;
                const invalid = validateDossierEdit(body, true);
                if (invalid) {
                    json(res, 400, { error: invalid });
                    return true;
                }
                json(res, 201, store.create(body as DossierEdit));
                return true;
            }
            return false;
        }

        if (path === "/api/dossiers/candidates" && method === "GET") {
            const after = Number(
                new URL(req.url ?? "/", "http://localhost").searchParams.get("after") ?? 0,
            );
            json(res, 200, store.candidatesAfter(Number.isFinite(after) ? after : 0));
            return true;
        }
        if (path === "/api/dossiers/settings") {
            if (method === "GET") {
                json(res, 200, store.settings());
                return true;
            }
            if (method === "PATCH") {
                const body = await this.body(req, res);
                if (body === undefined) return true;
                const enabled = (body as Record<string, unknown>)["digestEnabled"];
                if (typeof enabled !== "boolean") {
                    json(res, 400, { error: "digestEnabled must be true or false" });
                    return true;
                }
                json(res, 200, store.setSettings({ digestEnabled: enabled }));
                return true;
            }
            return false;
        }

        const digestNow = path.match(/^\/api\/dossiers\/([^/]+)\/digest$/);
        if (digestNow && method === "POST") {
            const id = decodeURIComponent(digestNow[1]!);
            if (!store.get(id)) json(res, 404, { error: "No such dossier" });
            else if (!this.deps.digest) json(res, 503, { error: "No model configured" });
            else {
                const r = await this.deps.digest([id]);
                if (r.digested.includes(id)) json(res, 200, store.get(id));
                else json(res, 502, { error: "The model gave no usable summary" });
            }
            return true;
        }

        const m = path.match(/^\/api\/dossiers\/([^/]+)(?:\/(attach|detach|dismiss))?$/);
        if (!m) return false;
        const id = decodeURIComponent(m[1]!);
        const gesture = m[2];

        if (!gesture && method === "GET") {
            const dossier = store.get(id);
            if (!dossier) json(res, 404, { error: "No such dossier" });
            else json(res, 200, { dossier, proposals: store.proposalsFor(id) });
            return true;
        }
        if (!gesture && method === "PATCH") {
            const body = await this.body(req, res);
            if (body === undefined) return true;
            const invalid = validateDossierEdit(body);
            if (invalid) {
                json(res, 400, { error: invalid });
                return true;
            }
            const dossier = store.update(id, body as DossierEdit);
            json(res, dossier ? 200 : 404, dossier ?? { error: "No such dossier" });
            return true;
        }
        if (gesture && method === "POST") {
            const body = await this.body(req, res);
            if (body === undefined) return true;
            const ref = (body as Record<string, unknown>)["ref"];
            if (typeof ref !== "string" || !ref) {
                json(res, 400, { error: "ref is required" });
                return true;
            }
            if (!store.get(id)) {
                json(res, 404, { error: "No such dossier" });
                return true;
            }
            if (gesture === "attach") {
                const member = this.deps.resolve(ref);
                if (!member) {
                    json(res, 404, {
                        error: "Nothing to attach under this ref (or a model may not read it)",
                    });
                    return true;
                }
                json(res, 200, store.attach(id, member));
            } else if (gesture === "detach") {
                json(res, 200, store.detach(id, ref));
            } else {
                store.dismiss(id, ref);
                json(res, 200, { ok: true });
            }
            return true;
        }
        return false;
    }

    private async body(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
        try {
            return await this.deps.readBody(req);
        } catch {
            this.deps.json(res, 400, { error: "Invalid JSON" });
            return undefined;
        }
    }
}
