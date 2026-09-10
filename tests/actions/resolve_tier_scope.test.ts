import { describe, it, expect } from "vitest";
import { resolveTierScope } from "../../source/actions/resolve_tier_scope.js";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

function makeEvent(overrides: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: "Test",
        priority: "normal",
        dedupeKey: "email-msg1",
        ...overrides,
    };
}

describe("resolveTierScope — backlog #329 P1 'paliers par expéditeur/repo'", () => {
    it("extracts the repo directly from sourceId for comment_issue/add_label/close_issue/merge_pr", () => {
        const store = new EventStore();
        expect(
            resolveTierScope(
                { kind: "comment_issue", sourceId: "owner/repo#42", body: "x" },
                store,
            ),
        ).toBe("owner/repo");
        expect(
            resolveTierScope({ kind: "add_label", sourceId: "owner/repo#7", label: "bug" }, store),
        ).toBe("owner/repo");
        expect(resolveTierScope({ kind: "close_issue", sourceId: "owner/repo#3" }, store)).toBe(
            "owner/repo",
        );
        expect(resolveTierScope({ kind: "merge_pr", sourceId: "owner/repo#9" }, store)).toBe(
            "owner/repo",
        );
    });

    it("returns null for a malformed GitHub sourceId (no '#')", () => {
        const store = new EventStore();
        expect(
            resolveTierScope({ kind: "close_issue", sourceId: "no-hash-here" }, store),
        ).toBeNull();
    });

    it("looks up the sender from EventStore for email kinds", () => {
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "email-msg1", meta: { from: "boss@corp.com" } }));
        expect(resolveTierScope({ kind: "reply", sourceId: "msg1", body: "hi" }, store)).toBe(
            "boss@corp.com",
        );
        expect(resolveTierScope({ kind: "archive_email", sourceId: "msg1" }, store)).toBe(
            "boss@corp.com",
        );
        expect(resolveTierScope({ kind: "mark_email_read", sourceId: "msg1" }, store)).toBe(
            "boss@corp.com",
        );
    });

    it("returns null for an email kind when the event isn't in the buffer", () => {
        const store = new EventStore();
        expect(
            resolveTierScope({ kind: "reply", sourceId: "unknown-msg", body: "hi" }, store),
        ).toBeNull();
    });

    it("returns null for an email kind when the buffered event has no meta.from", () => {
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "email-msg1" }));
        expect(resolveTierScope({ kind: "reply", sourceId: "msg1", body: "hi" }, store)).toBeNull();
    });

    it("returns null for kinds with no derivable scope (create_*, open_pr, complete_task, ...)", () => {
        const store = new EventStore();
        expect(resolveTierScope({ kind: "create_task", fields: { title: "t" } }, store)).toBeNull();
        expect(resolveTierScope({ kind: "complete_task", sourceId: "task1" }, store)).toBeNull();
        expect(
            resolveTierScope(
                { kind: "open_pr", fields: { repo: "o/r", title: "t", head: "h", base: "b" } },
                store,
            ),
        ).toBeNull();
        expect(
            resolveTierScope({ kind: "mark_notification_read", sourceId: "gh-mention-1" }, store),
        ).toBeNull();
    });
});
