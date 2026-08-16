import { describe, it, expect } from "vitest";
import { resolveEventSync } from "../../source/store/event_sync.js";
import type { ConnectorAction } from "../../source/types/connector_action.js";

describe("resolveEventSync — email", () => {
    it("mark_email_read maps to the email dedupeKey with effect 'read'", () => {
        expect(resolveEventSync({ kind: "mark_email_read", sourceId: "msg1" })).toEqual({
            dedupeKey: "email-msg1",
            effect: "read",
        });
    });

    it("mark_email_unread maps to effect 'unread'", () => {
        expect(resolveEventSync({ kind: "mark_email_unread", sourceId: "msg1" })).toEqual({
            dedupeKey: "email-msg1",
            effect: "unread",
        });
    });

    it("archive_email maps to effect 'read' — archiving is handling, not deleting", () => {
        expect(resolveEventSync({ kind: "archive_email", sourceId: "msg1" })).toEqual({
            dedupeKey: "email-msg1",
            effect: "read",
        });
    });

    it("delete_email maps to effect 'remove' — Gmail trash means the notification is done too", () => {
        expect(resolveEventSync({ kind: "delete_email", sourceId: "msg1" })).toEqual({
            dedupeKey: "email-msg1",
            effect: "remove",
        });
    });
});

describe("resolveEventSync — tasks", () => {
    it("complete_task with a bare taskId", () => {
        expect(resolveEventSync({ kind: "complete_task", sourceId: "task1" })).toEqual({
            dedupeKey: "task-task1",
            effect: "read",
        });
    });

    it("complete_task with a '{listId}/{taskId}' sourceId strips the listId", () => {
        expect(resolveEventSync({ kind: "complete_task", sourceId: "listA/task1" })).toEqual({
            dedupeKey: "task-task1",
            effect: "read",
        });
    });

    it("delete_task maps to effect 'remove'", () => {
        expect(resolveEventSync({ kind: "delete_task", sourceId: "listA/task1" })).toEqual({
            dedupeKey: "task-task1",
            effect: "remove",
        });
    });
});

describe("resolveEventSync — calendar", () => {
    it("update_event strips the calendarId prefix", () => {
        expect(
            resolveEventSync({ kind: "update_event", sourceId: "primary/ev1", fields: {} }),
        ).toEqual({
            dedupeKey: "cal-ev1",
            effect: "read",
        });
    });

    it("delete_event maps to effect 'remove'", () => {
        expect(resolveEventSync({ kind: "delete_event", sourceId: "primary/ev1" })).toEqual({
            dedupeKey: "cal-ev1",
            effect: "remove",
        });
    });
});

describe("resolveEventSync — no derivable mapping", () => {
    const noSyncCases: ConnectorAction[] = [
        { kind: "reply", sourceId: "msg1", body: "hi" },
        { kind: "create_event", fields: { summary: "s", start: "a", end: "b" } },
        { kind: "create_task", fields: { title: "t" } },
        { kind: "comment_issue", sourceId: "owner/repo#1", body: "hi" },
        { kind: "add_label", sourceId: "owner/repo#1", label: "bug" },
        { kind: "create_issue", fields: { repo: "owner/repo", title: "t" } },
        { kind: "close_issue", sourceId: "owner/repo#1" },
        { kind: "open_pr", fields: { repo: "owner/repo", title: "t", head: "h", base: "b" } },
        { kind: "merge_pr", sourceId: "owner/repo#1" },
    ];

    for (const action of noSyncCases) {
        it(`returns null for ${action.kind}`, () => {
            expect(resolveEventSync(action)).toBeNull();
        });
    }
});
