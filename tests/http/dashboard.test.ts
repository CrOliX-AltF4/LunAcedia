import { actionCapabilities } from "../../source/capabilities/capability_manifest.js";
import { describe, it, expect } from "vitest";
import { DASHBOARD_HTML } from "../../source/http/dashboard";

/**
 * Extracts the exact `esc(...)` function shipped inside DASHBOARD_HTML's inline
 * <script> and evaluates it in isolation. This exercises the real code the browser
 * runs (not a reimplementation) — a regression in the shipped escaping breaks this too.
 */
function extractEscFn(): (s: unknown) => string {
    const match = DASHBOARD_HTML.match(/function esc\(s\)\{[\s\S]*?\}\[c\]\)\);\}/);
    if (!match)
        throw new Error(
            "esc() not found in DASHBOARD_HTML — dashboard.ts's inline script may have changed shape",
        );
    return eval(`(${match[0]})`) as (s: unknown) => string;
}

describe("dashboard esc()", () => {
    const esc = extractEscFn();

    it("escapes angle brackets so injected tags can't parse as HTML", () => {
        expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("escapes double quotes so attribute contexts can't be broken out of", () => {
        expect(esc('" onmouseover="alert(1)')).toBe("&quot; onmouseover=&quot;alert(1)");
    });

    it("escapes ampersands", () => {
        expect(esc("Tom & Jerry")).toBe("Tom &amp; Jerry");
    });

    it("escapes single quotes", () => {
        expect(esc("it's")).toBe("it&#39;s");
    });

    it("passes plain text through unchanged", () => {
        expect(esc("New PR opened on lunanima")).toBe("New PR opened on lunanima");
    });

    it("stringifies non-string input instead of throwing", () => {
        expect(esc(null)).toBe("");
        expect(esc(undefined)).toBe("");
        expect(esc(42)).toBe("42");
    });
});

describe("DASHBOARD_HTML render() sink", () => {
    it("wraps every interpolated event field in esc(...) inside the card template", () => {
        const cardBlock = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("list.innerHTML=shown.map"),
            DASHBOARD_HTML.indexOf("`).join('');") + 1,
        );
        expect(cardBlock).toContain("esc(e.dedupeKey)");
        expect(cardBlock).toContain("esc(e.source)");
        expect(cardBlock).toContain("esc(e.priority)");
        expect(cardBlock).toContain("esc(e.title)");
        expect(cardBlock).toContain("esc(e.body)");
    });

    it("doesn't re-interpolate dedupeKey a second time into the onclick attribute", () => {
        // Regression guard for the gap the audit found: dedupeKey used to be embedded a second
        // time in onclick="toggle(this,'VALUE')" via a hand-rolled single-quote-only replace,
        // which left the double-quoted attribute boundary (a bare ") unprotected. Fixed by
        // reading the key from the already-escaped data-key attribute instead — toggle(this)
        // takes no second copy of untrusted data at all, so there's nothing left to escape wrong.
        const cardBlock = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("list.innerHTML=shown.map"),
            DASHBOARD_HTML.indexOf("`).join('');") + 1,
        );
        expect(cardBlock).toContain('onclick="toggle(this)"');
        expect(cardBlock).not.toMatch(/onclick="toggle\(this,/);
    });
});

describe("DASHBOARD_HTML renderPending() sink", () => {
    it("passes the pending action's id via data-id + this, never as a JS string argument", () => {
        // Same regression class as the dedupeKey/onclick fix above: an id interpolated
        // straight into onclick="confirmPending('ID')" would survive esc()'s HTML-entity
        // encoding only until the browser decodes the attribute back to a literal string
        // before running it as JS — at that point a quote in the id breaks out of the
        // string literal. data-id + reading it from the clicked element sidesteps that
        // entirely, the same way toggle(el) already does for dedupeKey.
        const block = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("function renderPending"),
            DASHBOARD_HTML.indexOf("function confirmPending"),
        );
        expect(block).toContain('data-id="${esc(p.id)}"');
        expect(block).toContain('onclick="confirmPending(this)"');
        expect(block).toContain('onclick="cancelPending(this)"');
        expect(block).not.toMatch(/onclick="confirmPending\('/);
        expect(block).not.toMatch(/onclick="cancelPending\('/);
    });

    it("lists every action kind of the manifest in the tiers, with its label", () => {
        for (const a of actionCapabilities())
            expect(DASHBOARD_HTML, a.kind).toContain(`"${a.kind}":${JSON.stringify(a.label)}`);
    });

    it("wraps every interpolated pending-action field in esc(...) — label and detail alike", () => {
        // describeAction() covers 17 action kinds generically (label lookup + a single
        // "detail" field pulled from whichever of body/label/fields.title/sourceId the kind
        // actually has) rather than one branch per kind — both the label and the extracted
        // detail must still go through esc() before landing in the pending-row's innerHTML.
        const block = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("function describeAction"),
            DASHBOARD_HTML.indexOf("function renderPending"),
        );
        expect(block).toContain("esc(label)");
        expect(block).toContain("esc(String(detail))");
        // The raw fields feeding `detail` must never be interpolated a second time unescaped.
        expect(block).not.toMatch(/\$\{a\.action\.(body|sourceId|label)\}/);
    });

    it("confirmPending/cancelPending read the id from the clicked element's closest row", () => {
        const block = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("async function confirmPending"),
            DASHBOARD_HTML.indexOf("// ── Settings"),
        );
        expect(block).toContain("btn.closest('.pending-row').dataset.id");
    });
});

describe("dashboard toggle()", () => {
    it("reads the key from the element's data-key attribute, not a function argument", () => {
        const toggleBlock = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("async function toggle"),
            DASHBOARD_HTML.indexOf("async function toggle") + 200,
        );
        expect(toggleBlock).toContain("async function toggle(el){");
        expect(toggleBlock).toContain("el.dataset.key");
    });
});

describe("dashboard AI provider onboarding", () => {
    it("checks /api/health's ai field to decide whether to show the onboarding banner", () => {
        expect(DASHBOARD_HTML).toContain("function checkAiProvider");
        const block = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("function checkAiProvider"),
            DASHBOARD_HTML.indexOf("function checkAiProvider") + 300,
        );
        expect(block).toContain("/api/health");
        expect(block).toContain("data.ai");
    });

    it("saveAiProvider() posts to /api/config/ai-provider with the form's provider/apiKey", () => {
        expect(DASHBOARD_HTML).toContain("function saveAiProvider");
        const block = DASHBOARD_HTML.slice(
            DASHBOARD_HTML.indexOf("function saveAiProvider"),
            DASHBOARD_HTML.indexOf("function saveAiProvider") + 500,
        );
        expect(block).toContain("/api/config/ai-provider");
        expect(block).toContain("method:'POST'");
        expect(block).toContain("provider");
        expect(block).toContain("apiKey");
    });

    it("calls checkAiProvider() during the initial bootstrap", () => {
        const bootstrapStart = DASHBOARD_HTML.indexOf("// Initial load");
        expect(bootstrapStart).toBeGreaterThan(-1);
        const bootstrapBlock = DASHBOARD_HTML.slice(bootstrapStart, bootstrapStart + 400);
        expect(bootstrapBlock).toContain("checkAiProvider()");
    });
});

// The standalone dashboard is LunAcedia's own panel: the same box as the Core's.
describe("dashboard box", () => {
    const script = DASHBOARD_HTML;

    it("loads the box from /api/inbox, not the raw event stream", () => {
        const block = script.slice(
            script.indexOf("async function load()"),
            script.indexOf("function render()"),
        );
        expect(block).toContain("req('/api/inbox')");
        expect(block).not.toContain("/api/events");
    });

    it("opens an item through the open gesture and shows its whole text, escaped", () => {
        const block = script.slice(
            script.indexOf("async function toggle"),
            script.indexOf("async function gesture"),
        );
        expect(block).toContain("'/api/inbox/'+encodeURIComponent(key)+'/open'");
        expect(block).toContain("esc(data.body)");
    });

    // Lot S: the box and the waiting actions follow /api/changes; the 60 s refresh is only a safety net.
    it("follows the stream of changes, reloads what it concerns once per burst, and keeps a slow safety net", () => {
        const block = script.slice(
            script.indexOf("const reloadSoon"),
            script.indexOf("setInterval(loadPending"),
        );
        expect(block).toContain("req('/api/changes')");
        expect(block).toContain("c.scope==='box'){\n    reloadOnce('box',load);");
        expect(block).toContain("reloadOnce('planning',()=>openPlanning())");
        expect(block).toContain("c.scope==='actions')reloadOnce('actions',loadPending)");
        expect(block).toContain("buf.indexOf('\\n\\n')");
        expect(script).toContain("setInterval(load,60000)");
        expect(script).not.toContain("setInterval(load,15000)");
    });

    // 2026-10-07: a token from .env showed « non connecté », a refused one « connecté », « Connecter » failed with a 503.
    it("shows each Google source as it really is, and says before the click when it cannot be connected", () => {
        const block = script.slice(
            script.indexOf("const SOURCE_STATES"),
            script.indexOf("function connectSource"),
        );
        expect(block).toContain("Google a refusé le jeton — reconnecter");
        expect(block).toContain("jeton du fichier .env");
        expect(block).toContain("st.canConnect");
        expect(block).toContain("Connexion impossible : ${esc(st.why");
        // The error text comes from Google or a network: escaped.
        expect(block).toContain("esc(st.lastError)");
    });

    it("the digest shows the urgent items listed by LunAcedia, then the summary — as text, never HTML", () => {
        const block = script.slice(
            script.indexOf("async function openDigest()"),
            script.indexOf("function openProposals"),
        );
        expect(block).toContain("data.urgent");
        expect(block).toContain("priorityReason");
        expect(block).toContain("Rien de nouveau");
        expect(block).toContain("t.textContent=");
        expect(block).not.toContain("innerHTML");
    });

    it("offers archive, trash, read and done as buttons that read the key from the card, never a JS argument", () => {
        const cardBlock = script.slice(
            script.indexOf("list.innerHTML=shown.map"),
            script.indexOf("`).join('');") + 1,
        );
        expect(cardBlock).toContain('data-g="archive"');
        expect(cardBlock).toContain('data-g="trash"');
        expect(cardBlock).toContain('data-g="spam"');
        // Opening is reading: no "Non lu" any more. A GitHub notification can be marked read and stays.
        expect(cardBlock).not.toContain('data-g="unread"');
        expect(cardBlock).toContain(
            'e.source===\'github\'?\'<button data-g="read" onclick="gesture(this,event)">Lu</button>',
        );
        expect(cardBlock).toContain('data-g="done"');
        // "Fait" on a task — same gesture as GitHub's, its own label.
        expect(cardBlock).toContain(
            "e.source==='tasks'?'<button data-g=\"done\" onclick=\"gesture(this,event)\">Fait</button>'",
        );
        expect(cardBlock).toContain('onclick="gesture(this,event)"');
        const g = script.slice(
            script.indexOf("async function gesture"),
            script.indexOf("async function gesture") + 400,
        );
        expect(g).toContain("btn.closest('.card').dataset.key");
        expect(g).toContain("btn.dataset.g");
        expect(g).toContain("'/api/inbox/'+encodeURIComponent(key)+'/'+g");
    });

    it("no longer offers 'Mark all read' (it only touched the stored copy, never Gmail)", () => {
        expect(script).not.toContain("markAll()");
    });

    it("shows Gmail's trash with a restore per row, ids read from the row", () => {
        expect(script).toContain('onclick="openTrash()"');
        const block = script.slice(
            script.indexOf("async function openTrash"),
            script.indexOf("async function restoreTrash") + 400,
        );
        // A page at a time: the next page's token comes back encoded, "Voir plus" asks for it.
        expect(block).toContain(
            "req('/api/inbox/trash'+(trashNext?'?page='+encodeURIComponent(trashNext):''))",
        );
        expect(block).toContain("Voir plus");
        expect(block).toContain("data.skipped");
        expect(block).toContain('data-id="${esc(t.id)}"');
        expect(block).toContain("esc(t.title)");
        expect(block).toContain("esc(t.from)");
        expect(block).toContain("btn.closest('.trash-row').dataset.id");
        expect(block).toContain("'/api/inbox/trash/'+encodeURIComponent(id)+'/restore'");
    });
});

// Parity: the pocket app's topics are visible from the dashboard, read-only.
describe("dashboard topics (read-only)", () => {
    const html = DASHBOARD_HTML;

    it("lists the topics and opens one, ids read from the row and every text escaped", () => {
        expect(html).toContain('onclick="openTopics()"');
        const block = html.slice(
            html.indexOf("async function openTopics"),
            html.indexOf("async function openDigestLike"),
        );
        expect(block).toContain("req('/api/conversations')");
        expect(block).toContain('data-id="${esc(t.id)}"');
        expect(block).toContain("esc(t.title)");
        expect(block).toContain("const id=row.dataset.id;");
        expect(block).toContain("'/api/conversations/'+encodeURIComponent(id)+'?limit=100'");
        expect(block).toContain("esc(m.text)");
        // Read-only: nothing here posts, renames, archives or deletes.
        expect(block).not.toMatch(/method:'(POST|PATCH|DELETE)'/);
    });
});

// LLM spend on the dashboard: figures, fired alerts, and the paliers (information only).
describe("dashboard LLM spend", () => {
    const html = DASHBOARD_HTML;

    it("shows the spend and the alerts, every text escaped, and saves paliers with PUT", () => {
        expect(html).toContain('onclick="openUsage()"');
        const block = html.slice(
            html.indexOf("async function openUsage"),
            html.indexOf("// The pocket app's topics"),
        );
        expect(block).toContain("req('/api/usage?days=7')");
        expect(block).toContain("esc(a.title)");
        expect(block).toContain("esc(CALLER_LABELS[c]||c)");
        expect(block).toContain("req('/api/config/usage-alerts',{method:'PUT'");
        expect(block).toContain("jamais de coupure");
    });

    it("ships a script the browser can parse", () => {
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
        expect(scripts.length).toBeGreaterThan(0);
        for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });
});

// Paired devices on the dashboard.
describe("dashboard devices", () => {
    const html = DASHBOARD_HTML;

    it("lists devices, revokes by the id read from the row, and asks for a pairing code", () => {
        expect(html).toContain('onclick="openDevices()"');
        const block = html.slice(
            html.indexOf("async function openDevices"),
            html.indexOf("// LLM spend"),
        );
        expect(block).toContain("req('/api/devices')");
        expect(block).toContain('data-id="${esc(x.id)}"');
        expect(block).toContain("esc(x.name)");
        expect(block).toContain("const id=row.dataset.id;");
        expect(block).toContain("'/api/devices/'+encodeURIComponent(id),{method:'DELETE'}");
        expect(block).toContain("req('/api/devices/pairing-code',{method:'POST'})");
        expect(block).toContain("esc(c.code)");
    });
});

// Law 3 — the agent's switch and its writes, set from the dashboard; pending writes say when they
// expire and why a confirmation failed.
describe("dashboard agent and pending writes", () => {
    const html = DASHBOARD_HTML;

    it("reads and sets the agent's switch and its writes with PUT /api/agent/settings", () => {
        expect(html).toContain('onclick="openAgent()"');
        const block = html.slice(
            html.indexOf("async function openAgent"),
            html.indexOf("// End of the agent section"),
        );
        expect(block).toContain("req('/api/agent/settings')");
        expect(block).toContain("req('/api/agent/settings',{method:'PUT'");
        expect(block).toContain("toujours avec ta confirmation");
    });

    it("says when a pending write expires, flags a third party's text, and says why a confirmation failed", () => {
        const render = html.slice(
            html.indexOf("function renderPending"),
            html.indexOf("async function confirmPending"),
        );
        expect(render).toContain("p.expiresAt");
        expect(render).toContain("p.untrusted");
        const confirm = html.slice(
            html.indexOf("async function confirmPending"),
            html.indexOf("async function cancelPending"),
        );
        expect(confirm).toContain("if(!r.ok)");
        expect(confirm).toContain("esc(");
    });

    it("ships a script the browser can parse", () => {
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
        for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });
});

// The planning on the dashboard: rendered by the shipped code itself, on a sample.
describe("dashboard planning", () => {
    const html = DASHBOARD_HTML;
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join("\n");
    const pure = script.slice(
        script.indexOf("let planView="),
        script.indexOf("async function openPlanning"),
    );
    const esc = extractEscFn();
    const render = (view: string, p: unknown, conflicts: unknown[], now: Date): string =>
        new Function("esc", `${pure}; planView=${JSON.stringify(view)}; return renderPlanning;`)(
            esc,
        )(p, conflicts, now);

    const now = new Date(2026, 9, 19, 8);
    const at = (h: number, m = 0) => new Date(2026, 9, 19, h, m).toISOString();
    const planning = {
        complete: true,
        events: [
            { id: "p/a", title: "Dentiste", start: at(10), end: at(11), allDay: false },
            { id: "p/b", title: "<b>Appel</b>", start: at(10, 30), end: at(11, 30), allDay: false },
        ],
        tasks: [
            {
                id: "l/x",
                title: "Payer la facture",
                listTitle: "Maison",
                due: "2026-10-17",
                status: "open",
            },
            { id: "l/y", title: "Courses", listTitle: "Maison", due: "2026-10-21", status: "open" },
            {
                id: "l/z",
                title: "Vieux",
                listTitle: "Maison",
                due: "2026-10-01",
                status: "completed",
            },
        ],
        conflicts: [{ id: "c1", eventIds: ["p/a", "p/b"], from: at(10, 30), to: at(11) }],
    };
    const conflict = {
        dedupeKey: "c1",
        type: "planning.conflict",
        title: "Conflit — Dentiste et Appel",
        meta: { movingTitle: "Appel", solutions: [{ eventId: "p/b", start: at(14), end: at(15) }] },
    };

    it("the week: each day's events, the conflict's ways out and the week's tasks, every text escaped", () => {
        const out = render("week", planning, [conflict], now);
        expect(out).toContain("10:00 Dentiste");
        expect(out).toContain("10:30 &lt;b&gt;Appel&lt;/b&gt;");
        expect(out).not.toContain("<b>Appel</b>");
        expect(out).toContain("· conflit");
        expect(out).toContain('data-key="c1"');
        expect(out).toContain('<button data-n="0" onclick="solveConflict(this)">À 14:00</button>');
        expect(out).toContain("Laisser tel quel");
        expect(out).toContain("Payer la facture <small>· en retard de 2 j</small>");
        expect(out).toContain("Courses");
        expect(out).toContain("En retard · 1");
        expect(out).not.toContain("Vieux");
    });

    it("late: only what is past due; « Fait » reads the task's id from its row", () => {
        const out = render("late", planning, [], now);
        expect(out).toContain('data-id="l/x"');
        expect(out).not.toContain("Courses");
        const block = script.slice(
            script.indexOf("async function donePlanningTask"),
            script.indexOf("async function settleConflict"),
        );
        expect(block).toContain(
            "'/api/planning/tasks/'+encodeURIComponent(row.dataset.id)+'/done',{method:'POST'}",
        );
    });

    it("says when the planning was not read in full", () => {
        expect(render("tasks", { ...planning, complete: false }, [], now)).toContain(
            "pas encore été lu en entier",
        );
    });
});

// Sorting mail on the dashboard: rendered by the shipped code itself, on a sample.
describe("dashboard mail sorting", () => {
    const script = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]!)
        .join("\n");
    const pure = script.slice(
        script.indexOf("const CLASS_NAMES="),
        script.indexOf("let sortRules="),
    );
    const esc = extractEscFn();
    const render = (cfg: unknown, rules: unknown[], journal: unknown): string =>
        new Function("esc", `${pure}; return renderSort;`)(esc)(cfg, rules, journal);
    const on = { visible: true, ai: true, rings: true };
    const cfg = {
        classes: {
            pro: on,
            perso: { ...on, ai: false },
            notification: on,
            pub: { ...on, visible: false },
            inconnu: on,
        },
        personalSenders: ["maman@famille.fr"],
        mailboxes: [{ address: "pro@<espi>.fr", mailClass: "pro" }],
        counts: { pro: 4, pub: 9 },
    };
    const rules = [
        {
            id: "r1",
            name: "x",
            enabled: true,
            conditions: [{ field: "from", op: "domain", value: "<espi>.fr" }],
            actions: [{ type: "classify", mailClass: "pro" }],
        },
        {
            id: "r2",
            name: "AliExpress",
            enabled: true,
            conditions: [{ field: "from", op: "domain", value: "ali.com" }],
            actions: [{ type: "drop" }],
        },
    ];
    const journal = {
        total: 2,
        entries: [
            {
                ts: 1,
                ruleId: "class:pub",
                event: { dedupeKey: "email-1", title: "Soldes", meta: { from: "Lumen" } },
            },
            {
                ts: 1,
                ruleId: "r2",
                event: { dedupeKey: "email-2", title: "Colis", meta: { from: "Ali" } },
            },
        ],
    };

    it("shows each class with its three switches and its count, the rules that classify only, and why a mail was kept out", () => {
        const out = render(cfg, rules, journal);
        expect(out).toContain('data-class="perso" data-key="ai"  onchange');
        expect(out).toContain('data-class="pro" data-key="ai" checked');
        expect(out).toContain("<td><small>9</small></td>");
        expect(out).toContain("l'expéditeur est du domaine « &lt;espi&gt;.fr »");
        expect(out).not.toContain("ali.com");
        expect(out).toContain('data-id="r1"');
        expect(out).toContain("classe Pub (masquée)");
        expect(out).toContain("règle « AliExpress »");
        expect(out).toContain("maman@famille.fr");
        expect(out).toContain('data-address="pro@&lt;espi&gt;.fr"');
        expect(out).toContain('<option value="pro" selected>Pro</option>');
    });

    it("switches one rule by the id read from its row, and restores by the key read from its row", () => {
        const block = script.slice(
            script.indexOf("async function toggleRule"),
            script.indexOf("async function putRules"),
        );
        expect(block).toContain("'/api/guard/rules/'+encodeURIComponent(id),{method:'PATCH'");
        expect(script).toContain("body:JSON.stringify({dedupeKey:row.dataset.key})");
        expect(DASHBOARD_HTML).toContain('onclick="openSort()"');
    });
});

// The dossiers on the dashboard: rendered by the shipped code itself, on a sample.
describe("dashboard dossiers", () => {
    const script = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]!)
        .join("\n");
    const pure = script.slice(
        script.indexOf("const DOSSIER_KIND="),
        script.indexOf("async function openDossiers"),
    );
    const esc = extractEscFn();
    const fns = new Function("esc", `${pure}; return { renderDossiers, renderDossier };`)(esc) as {
        renderDossiers: (list: unknown[], settings?: unknown) => string;
        renderDossier: (d: unknown, proposals: unknown[]) => string;
    };

    it("lists each dossier with its count, its latest item and its proposals — escaped", () => {
        const html = fns.renderDossiers([
            {
                id: "dos_1",
                title: "<b>Devis</b>",
                label: "ACME",
                repos: [],
                count: 3,
                updatedAt: 1,
                proposals: 1,
                last: { kind: "mail", title: "Re: Devis", at: Date.parse("2026-10-17T10:00:00Z") },
            },
        ]);
        expect(html).toContain("&lt;b&gt;Devis&lt;/b&gt;");
        expect(html).toContain("3 élément(s)");
        expect(html).toContain("1 proposition(s)");
        expect(html).toContain('data-id="dos_1" onclick="openDossier(this.dataset.id)"');
        expect(html).toContain("Nouveau projet");
    });

    it("shows a dossier's items with why they are there, and its proposals with their ways out", () => {
        const html = fns.renderDossier(
            {
                id: "dos_1",
                title: "ACME",
                label: "ACME",
                repos: ["acme/site"],
                members: [
                    {
                        kind: "event",
                        ref: "primary/e1",
                        title: "Réunion ACME",
                        at: 0,
                        reason: "label",
                    },
                ],
            },
            [
                {
                    dossierId: "dos_1",
                    member: { kind: "event", ref: "primary/e2", title: "Point", at: 0 },
                    why: "même participant : lea@acme.fr",
                },
            ],
        );
        expect(html).toContain("étiquette");
        expect(html).toContain('data-ref="primary/e1"');
        expect(html).toContain("dossierGesture(this,'detach')");
        expect(html).toContain("même participant : lea@acme.fr");
        expect(html).toContain("dossierGesture(this,'attach')");
        expect(html).toContain("dossierGesture(this,'dismiss')");
    });

    it("opens from the header", () => {
        expect(DASHBOARD_HTML).toContain('onclick="openDossiers()"');
    });

    it("shows where a dossier stands, « Résumer maintenant », and the daily switch as it is", () => {
        const html = fns.renderDossier(
            {
                id: "dos_1",
                title: "ACME",
                repos: [],
                members: [],
                digest: {
                    summary: "Un <i>devis</i>.",
                    state: "Réponse attendue",
                    at: Date.parse("2026-10-18T03:00:00Z"),
                },
            },
            [],
        );
        expect(html).toContain("Où on en est :</strong> Réponse attendue");
        expect(html).toContain("Un &lt;i&gt;devis&lt;/i&gt;.");
        expect(html).toContain('data-id="dos_1" onclick="digestDossier(this)"');
        expect(fns.renderDossiers([], { digestEnabled: true })).toContain(
            'onchange="toggleDossierDigest(this.checked)" checked',
        );
        expect(fns.renderDossiers([], { digestEnabled: false })).not.toContain(" checked");
    });
});
