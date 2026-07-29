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
