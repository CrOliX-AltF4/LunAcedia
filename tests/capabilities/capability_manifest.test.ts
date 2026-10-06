import { describe, it, expect } from "vitest";
import {
    CAPABILITY_MANIFESTS,
    actionCapabilities,
    actionFromArgs,
    actionToolDefinitions,
} from "../../source/capabilities/capability_manifest.js";
import { DEFAULT_ACTION_TIERS, ACTION_RISK } from "../../source/types/action_tier.js";

// The values in force before the manifest existed (v0.9.0) — deriving them from the manifest must
// change nothing for an existing install. Deliberate changes since, each with its decision:
//   delete_email manual → confirm, high → medium: it is Gmail's trash, kept 30 days (CrOliX, 2026-10-06);
//   mark_spam, unmark_spam, star_email, unstar_email, label_email, unlabel_email, bulk_email, create_rule: added the same day.
const HISTORICAL_TIERS = {
    reply: "confirm",
    archive_email: "confirm",
    delete_email: "confirm",
    mark_spam: "confirm",
    unmark_spam: "confirm",
    star_email: "confirm",
    unstar_email: "confirm",
    label_email: "confirm",
    unlabel_email: "confirm",
    bulk_email: "confirm",
    create_rule: "confirm",
    mark_email_read: "confirm",
    mark_email_unread: "confirm",
    create_event: "confirm",
    update_event: "confirm",
    delete_event: "confirm",
    create_task: "confirm",
    complete_task: "confirm",
    delete_task: "confirm",
    comment_issue: "confirm",
    add_label: "confirm",
    create_issue: "confirm",
    close_issue: "confirm",
    open_pr: "confirm",
    merge_pr: "manual",
    mark_notification_read: "confirm",
};
const HISTORICAL_RISK = {
    mark_email_read: "low",
    mark_email_unread: "low",
    archive_email: "low",
    complete_task: "low",
    mark_notification_read: "low",
    mark_spam: "low",
    unmark_spam: "low",
    star_email: "low",
    unstar_email: "low",
    label_email: "low",
    unlabel_email: "low",
    delete_email: "medium",
    bulk_email: "medium",
    create_rule: "medium",
    reply: "medium",
    comment_issue: "medium",
    add_label: "medium",
    create_event: "medium",
    create_task: "medium",
    create_issue: "medium",
    open_pr: "medium",
    update_event: "medium",
    delete_event: "high",
    delete_task: "high",
    close_issue: "high",
    merge_pr: "high",
};

describe("capability manifests", () => {
    it("names every action once, in Master's words — the one label push, dashboard and Core show", () => {
        for (const a of actionCapabilities()) expect(a.label, a.kind).toMatch(/^[A-ZÀ-Ý]/);
        expect(new Set(actionCapabilities().map((a) => a.label)).size).toBe(actionCapabilities().length);
    });

    it("declares every action kind exactly once", () => {
        const kinds = actionCapabilities().map((a) => a.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        expect(kinds.sort()).toEqual(Object.keys(HISTORICAL_TIERS).sort());
    });

    it("derives the default tiers without changing any of them", () => {
        expect(DEFAULT_ACTION_TIERS).toEqual(HISTORICAL_TIERS);
    });

    it("derives the risk levels without changing any of them", () => {
        expect(ACTION_RISK).toEqual(HISTORICAL_RISK);
    });

    it("attaches each action to the connector that executes it", () => {
        const owner = (kind: string) =>
            actionCapabilities().find((a) => a.kind === kind)!.connector;
        expect(owner("archive_email")).toBe("Gmail");
        expect(owner("create_event")).toBe("Calendar");
        expect(owner("complete_task")).toBe("Tasks");
        expect(owner("open_pr")).toBe("GitHub");
        expect(owner("mark_notification_read")).toBe("GitHub");
    });

    it("only lists connectors that exist in the registry", () => {
        expect(CAPABILITY_MANIFESTS.map((m) => m.slug).sort()).toEqual([
            "calendar",
            "email",
            "github",
            "tasks",
        ]);
    });
});

describe("actionFromArgs — tool arguments to a ConnectorAction, validated by the manifest", () => {
    it("builds a valid action and names its connector", () => {
        expect(actionFromArgs("archive_email", { sourceId: "m1" })).toEqual({
            ok: true,
            connector: "Gmail",
            action: { kind: "archive_email", sourceId: "m1" },
        });
    });

    it("keeps optional fields and drops undeclared ones", () => {
        const r = actionFromArgs("create_task", {
            fields: { title: "Appeler", due: "2026-09-26", evil: 1 },
        });
        expect(r).toEqual({
            ok: true,
            connector: "Tasks",
            action: { kind: "create_task", fields: { title: "Appeler", due: "2026-09-26" } },
        });
    });

    it("refuses invalid arguments with a readable reason", () => {
        const r = actionFromArgs("create_event", {
            fields: { summary: "x", start: "2026-09-26T10:00" },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("end");
    });

    it("refuses an unknown kind", () => {
        expect(actionFromArgs("delete_forever", { sourceId: "1" }).ok).toBe(false);
    });

    it("never builds merge_pr from model output — merging stays human", () => {
        expect(actionFromArgs("merge_pr", { sourceId: "o/r#1" }).ok).toBe(false);
    });
});

describe("actionToolDefinitions — what the model is offered", () => {
    it("offers one tool per agent-allowed action, merge_pr excluded", () => {
        const names = actionToolDefinitions().map((t) => t.name);
        expect(names).toContain("archive_email");
        expect(names).not.toContain("merge_pr");
        expect(names).toHaveLength(Object.keys(HISTORICAL_TIERS).length - 1);
    });

    it("gives each tool a description and an object schema", () => {
        for (const t of actionToolDefinitions()) {
            expect(t.description.length, t.name).toBeGreaterThan(10);
            expect(t.parameters.type).toBe("object");
        }
    });
});

// CrOliX 2026-09-25: the agent sorts the inbox now; everything that writes waits for a later v1.
// 2026-10-06: spam, star and labels are sorting too.
describe("triage vs write actions", () => {
    const TRIAGE = [
        "archive_email",
        "delete_email",
        "mark_email_read",
        "mark_email_unread",
        "mark_spam",
        "unmark_spam",
        "star_email",
        "unstar_email",
        "label_email",
        "unlabel_email",
        "bulk_email",
        "create_rule",
        "mark_notification_read",
    ];

    it("classes exactly the inbox-sorting gestures as triage", () => {
        const triage = actionCapabilities()
            .filter((a) => a.category === "triage")
            .map((a) => a.kind);
        expect(triage.sort()).toEqual([...TRIAGE].sort());
    });

    it("offers only triage actions and reply — the first write opened — when writes are off", () => {
        const names = actionToolDefinitions({ includeWrites: false }).map((t) => t.name);
        expect(names.sort()).toEqual([...TRIAGE, "reply"].sort());
    });

    it("offers writes too when they are on (merge_pr still never)", () => {
        const names = actionToolDefinitions({ includeWrites: true }).map((t) => t.name);
        expect(names).toContain("create_task");
        expect(names).not.toContain("merge_pr");
    });
});
