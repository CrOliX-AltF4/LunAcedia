import { describe, it, expect } from "vitest";
import {
    evaluateGuard,
    extractAddress,
    makeVipMatcher,
    senderDomain,
} from "../../source/guards/guard_engine.js";
import type { GuardRule } from "../../source/guards/guard_types.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

function mail(
    overrides: Partial<AcediaEvent> & { meta?: Record<string, unknown> } = {},
): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: "Votre colis est en route",
        body: "Suivez votre commande",
        priority: "info",
        dedupeKey: "email-1",
        ...overrides,
        meta: {
            from: "AliExpress <deals@mail.aliexpress.com>",
            labels: ["INBOX", "CATEGORY_PROMOTIONS"],
            headers: { "list-unsubscribe": "<mailto:x@y>" },
            ...overrides.meta,
        },
    };
}

function rule(overrides: Partial<GuardRule>): GuardRule {
    return {
        id: "r1",
        name: "r",
        enabled: true,
        conditions: [{ field: "from", op: "domain", value: "aliexpress.com" }],
        actions: [{ type: "drop" }],
        ...overrides,
    };
}

const noVip = () => false;

describe("extractAddress / senderDomain", () => {
    it("reads the address out of a display-name From header, lowercased", () => {
        expect(extractAddress("Ali Express <Deals@Mail.AliExpress.com>")).toBe(
            "deals@mail.aliexpress.com",
        );
        expect(extractAddress("bob@corp.io")).toBe("bob@corp.io");
        expect(extractAddress("no address here")).toBe("");
    });
    it("returns the domain, empty when there is none", () => {
        expect(senderDomain("A <x@sub.example.com>")).toBe("sub.example.com");
        expect(senderDomain("plain text")).toBe("");
    });
});

describe("evaluateGuard — conditions", () => {
    it("matches a sender domain including its subdomains, and not lookalike domains", () => {
        expect(evaluateGuard(mail(), [rule({})], noVip).drop).toBe(true);
        expect(
            evaluateGuard(mail({ meta: { from: "x@aliexpress.com" } }), [rule({})], noVip).drop,
        ).toBe(true);
        expect(
            evaluateGuard(mail({ meta: { from: "x@notaliexpress.com" } }), [rule({})], noVip).drop,
        ).toBe(false);
        expect(
            evaluateGuard(mail({ meta: { from: "x@aliexpress.com.evil.io" } }), [rule({})], noVip)
                .drop,
        ).toBe(false);
    });

    it("supports from equals (address or full header) and contains", () => {
        const eq = rule({
            conditions: [{ field: "from", op: "equals", value: "deals@mail.aliexpress.com" }],
        });
        expect(evaluateGuard(mail(), [eq], noVip).drop).toBe(true);
        const contains = rule({
            conditions: [{ field: "from", op: "contains", value: "ALIEXPRESS" }],
        });
        expect(evaluateGuard(mail(), [contains], noVip).drop).toBe(true);
        const no = rule({
            conditions: [{ field: "from", op: "equals", value: "other@mail.aliexpress.com" }],
        });
        expect(evaluateGuard(mail(), [no], noVip).drop).toBe(false);
    });

    it("matches subject and snippet case-insensitively", () => {
        const subject = rule({
            conditions: [{ field: "subject", op: "contains", value: "COLIS" }],
        });
        expect(evaluateGuard(mail(), [subject], noVip).drop).toBe(true);
        const snippet = rule({
            conditions: [{ field: "snippet", op: "contains", value: "commande" }],
        });
        expect(evaluateGuard(mail(), [snippet], noVip).drop).toBe(true);
    });

    it("matches a Gmail label and a present header", () => {
        const label = rule({
            conditions: [{ field: "label", op: "equals", value: "category_promotions" }],
        });
        expect(evaluateGuard(mail(), [label], noVip).drop).toBe(true);
        const header = rule({
            conditions: [{ field: "header", op: "present", name: "List-Unsubscribe" }],
        });
        expect(evaluateGuard(mail(), [header], noVip).drop).toBe(true);
        expect(evaluateGuard(mail({ meta: { headers: {} } }), [header], noVip).drop).toBe(false);
    });

    it("ANDs the conditions of a rule", () => {
        const both = rule({
            conditions: [
                { field: "from", op: "domain", value: "aliexpress.com" },
                { field: "subject", op: "contains", value: "facture" },
            ],
        });
        expect(evaluateGuard(mail(), [both], noVip).drop).toBe(false);
        expect(evaluateGuard(mail({ title: "Votre facture" }), [both], noVip).drop).toBe(true);
    });

    it("never matches on a non-mail event lacking the field, and ignores disabled or condition-less rules", () => {
        const rss: AcediaEvent = {
            type: "rss.item",
            ts: 1,
            source: "rss",
            title: "News",
            priority: "info",
            dedupeKey: "rss-1",
        };
        expect(evaluateGuard(rss, [rule({})], noVip).drop).toBe(false);
        expect(evaluateGuard(mail(), [rule({ enabled: false })], noVip).drop).toBe(false);
        expect(evaluateGuard(mail(), [rule({ conditions: [] })], noVip).drop).toBe(false);
    });
});

describe("evaluateGuard — actions and precedence", () => {
    it("accumulates tags across rules without duplicates (case-insensitive) and keeps the first priority", () => {
        const rules = [
            rule({
                id: "a",
                conditions: [{ field: "from", op: "domain", value: "aliexpress.com" }],
                actions: [
                    { type: "tag", tag: "Promo" },
                    { type: "set_priority", priority: "info" },
                ],
            }),
            rule({
                id: "b",
                conditions: [{ field: "label", op: "equals", value: "CATEGORY_PROMOTIONS" }],
                actions: [
                    { type: "tag", tag: "promo" },
                    { type: "tag", tag: "shopping" },
                    { type: "set_priority", priority: "normal" },
                ],
            }),
        ];
        const v = evaluateGuard(mail(), rules, noVip);
        expect(v.drop).toBe(false);
        expect(v.tags).toEqual(["Promo", "shopping"]);
        expect(v.priority).toBe("info");
        expect(v.matchedRuleIds).toEqual(["a", "b"]);
        expect(v.ruleId).toBe("a");
    });

    it("attributes a drop to the first dropping rule", () => {
        const rules = [
            rule({ id: "t", actions: [{ type: "tag", tag: "x" }] }),
            rule({ id: "d1" }),
            rule({ id: "d2" }),
        ];
        const v = evaluateGuard(mail(), rules, noVip);
        expect(v.drop).toBe(true);
        expect(v.ruleId).toBe("d1");
        expect(v.tags).toEqual(["x"]);
    });

    it("the VIP allowlist always wins over a drop, but tags and priority still apply", () => {
        const isVip = makeVipMatcher(["deals@mail.aliexpress.com"]);
        const rules = [
            rule({ id: "d" }),
            rule({
                id: "t",
                actions: [
                    { type: "tag", tag: "vip-seen" },
                    { type: "set_priority", priority: "urgent" },
                ],
            }),
        ];
        const v = evaluateGuard(mail(), rules, isVip);
        expect(v.drop).toBe(false);
        expect(v.vipProtected).toBe(true);
        expect(v.tags).toEqual(["vip-seen"]);
        expect(v.priority).toBe("urgent");
    });

    it("returns a neutral verdict when nothing matches", () => {
        const v = evaluateGuard(
            mail({ meta: { from: "friend@home.org", labels: [], headers: {} } }),
            [rule({})],
            noVip,
        );
        expect(v).toEqual({
            drop: false,
            tags: [],
            matchedRuleIds: [],
            vipProtected: false,
            ruleId: undefined,
        });
    });
});

describe("evaluateGuard — actions at the source (ADR-023 T3)", () => {
    it("collects what the matching rules do at the source, once each, with the rule that asks", () => {
        const rules = [
            rule({ id: "a", actions: [{ type: "source", action: "mark_spam" }] }),
            rule({ id: "b", actions: [{ type: "source", action: "mark_spam" }, { type: "source", action: "label_email", label: "Pubs" }] }),
        ];
        expect(evaluateGuard(mail(), rules, noVip).source).toEqual([
            { ruleId: "a", action: "mark_spam" },
            { ruleId: "b", action: "label_email", label: "Pubs" },
        ]);
    });

    it("a VIP is never archived, trashed or reported by a rule — a label still applies", () => {
        const isVip = makeVipMatcher(["deals@mail.aliexpress.com"]);
        const rules = [rule({ actions: [{ type: "source", action: "delete_email" }, { type: "source", action: "star_email" }] })];
        const v = evaluateGuard(mail(), rules, isVip);
        expect(v.source).toEqual([{ ruleId: "r1", action: "star_email" }]);
        expect(v.vipProtected).toBe(true);
    });
});

describe("makeVipMatcher", () => {
    it("keeps the legacy semantics: case-insensitive substring on from + subject, ignoring blank patterns", () => {
        const isVip = makeVipMatcher(["BOSS@corp.com", "  "]);
        expect(isVip(mail({ meta: { from: "The Boss <boss@corp.com>" } }))).toBe(true);
        expect(isVip(mail({ title: "note de boss@corp.com" }))).toBe(true);
        expect(isVip(mail())).toBe(false);
        expect(makeVipMatcher([])(mail())).toBe(false);
    });
});
