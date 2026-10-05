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

describe("dashboard AI provider onboarding (ADR-013 I1)", () => {
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

// ADR-018 R5 — the standalone dashboard is LunAcedia's own panel: the same box as the Core's.
describe("dashboard box (ADR-018 R5)", () => {
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

    it("offers archive, trash, unread and done as buttons that read the key from the card, never a JS argument", () => {
        const cardBlock = script.slice(
            script.indexOf("list.innerHTML=shown.map"),
            script.indexOf("`).join('');") + 1,
        );
        expect(cardBlock).toContain('data-g="archive"');
        expect(cardBlock).toContain('data-g="trash"');
        expect(cardBlock).toContain('data-g="unread"');
        expect(cardBlock).toContain('data-g="done"');
        // "Fait" on a task (ADR-020 §5.10 M4d) — same gesture as GitHub's, its own label.
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
        expect(block).toContain("req('/api/inbox/trash')");
        expect(block).toContain('data-id="${esc(t.id)}"');
        expect(block).toContain("esc(t.title)");
        expect(block).toContain("esc(t.from)");
        expect(block).toContain("btn.closest('.trash-row').dataset.id");
        expect(block).toContain("'/api/inbox/trash/'+encodeURIComponent(id)+'/restore'");
    });
});

// ADR-020 amendment 1, S1 — parity: the pocket app's topics are visible from the dashboard, read-only.
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

// ADR-021 P2 — LLM spend on the dashboard: figures, fired alerts, and the paliers (information only).
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

// ADR-020 M3 — paired devices on the dashboard.
describe("dashboard devices", () => {
    const html = DASHBOARD_HTML;

    it("lists devices, revokes by the id read from the row, and asks for a pairing code", () => {
        expect(html).toContain('onclick="openDevices()"');
        const block = html.slice(
            html.indexOf("async function openDevices"),
            html.indexOf("// LLM spend (ADR-021 P2)"),
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

// ADR-020 §5.11 M5b (law 3) — the agent's switch and its writes, set from the dashboard; pending writes say when they
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
