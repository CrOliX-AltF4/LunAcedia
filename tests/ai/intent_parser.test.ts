import { describe, it, expect } from "vitest";
import { formatIntentPrompt, parseIntentResponse } from "../../source/ai/intent_parser.js";

describe("formatIntentPrompt", () => {
    it("embeds the user's text", () => {
        expect(formatIntentPrompt("crée une tâche pour rappeler le rendez-vous")).toContain(
            "crée une tâche pour rappeler le rendez-vous",
        );
    });

    it("escapes double quotes in the user's text", () => {
        expect(formatIntentPrompt('say "hi"')).toContain('say \\"hi\\"');
    });

    it("instructs the model to never output merge_pr", () => {
        expect(formatIntentPrompt("merge my PR")).toContain('Never output "merge_pr"');
    });
});

describe("parseIntentResponse", () => {
    it("returns null for invalid JSON", () => {
        expect(parseIntentResponse("not json at all")).toBeNull();
    });

    it("strips markdown code fences before parsing", () => {
        const raw = '```json\n{"matched": false}\n```';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("returns null when matched is false", () => {
        expect(parseIntentResponse('{"matched": false}')).toBeNull();
    });

    it("returns null for an unknown connector", () => {
        const raw = '{"matched":true,"connector":"Dropbox","action":{"kind":"reply","sourceId":"1","body":"hi"}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("returns null for merge_pr regardless of shape validity", () => {
        const raw = '{"matched":true,"connector":"GitHub","action":{"kind":"merge_pr","sourceId":"owner/repo#1"}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("returns null for an unrecognized kind", () => {
        const raw = '{"matched":true,"connector":"Gmail","action":{"kind":"delete_forever","sourceId":"1"}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("parses a valid simple-sourceId action (mark_email_read)", () => {
        const raw = '{"matched":true,"connector":"Gmail","action":{"kind":"mark_email_read","sourceId":"msg1"}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "Gmail",
            action: { kind: "mark_email_read", sourceId: "msg1" },
        });
    });

    it("rejects a simple-sourceId action with an empty sourceId", () => {
        const raw = '{"matched":true,"connector":"Gmail","action":{"kind":"mark_email_read","sourceId":""}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("parses a valid reply action", () => {
        const raw = '{"matched":true,"connector":"Gmail","action":{"kind":"reply","sourceId":"msg1","body":"On it."}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "Gmail",
            action: { kind: "reply", sourceId: "msg1", body: "On it." },
        });
    });

    it("parses a valid add_label action", () => {
        const raw = '{"matched":true,"connector":"GitHub","action":{"kind":"add_label","sourceId":"o/r#1","label":"bug"}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "GitHub",
            action: { kind: "add_label", sourceId: "o/r#1", label: "bug" },
        });
    });

    it("rejects add_label without a label", () => {
        const raw = '{"matched":true,"connector":"GitHub","action":{"kind":"add_label","sourceId":"o/r#1"}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("parses a valid create_event action with optional fields", () => {
        const raw =
            '{"matched":true,"connector":"Calendar","action":{"kind":"create_event","fields":{"summary":"Sync","start":"2026-09-01T10:00:00Z","end":"2026-09-01T10:30:00Z","location":"Room A"}}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "Calendar",
            action: {
                kind: "create_event",
                fields: { summary: "Sync", start: "2026-09-01T10:00:00Z", end: "2026-09-01T10:30:00Z", location: "Room A" },
            },
        });
    });

    it("rejects create_event missing a required field (end)", () => {
        const raw = '{"matched":true,"connector":"Calendar","action":{"kind":"create_event","fields":{"summary":"Sync","start":"2026-09-01T10:00:00Z"}}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("parses a valid create_task action", () => {
        const raw = '{"matched":true,"connector":"Tasks","action":{"kind":"create_task","fields":{"title":"Buy milk","due":"2026-09-01"}}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "Tasks",
            action: { kind: "create_task", fields: { title: "Buy milk", due: "2026-09-01" } },
        });
    });

    it("rejects create_task without a title", () => {
        const raw = '{"matched":true,"connector":"Tasks","action":{"kind":"create_task","fields":{"due":"2026-09-01"}}}';
        expect(parseIntentResponse(raw)).toBeNull();
    });

    it("parses a valid create_issue action", () => {
        const raw = '{"matched":true,"connector":"GitHub","action":{"kind":"create_issue","fields":{"repo":"o/r","title":"Bug"}}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "GitHub",
            action: { kind: "create_issue", fields: { repo: "o/r", title: "Bug" } },
        });
    });

    it("parses a valid open_pr action, rejects one missing head/base", () => {
        const ok = '{"matched":true,"connector":"GitHub","action":{"kind":"open_pr","fields":{"repo":"o/r","title":"Fix","head":"fix","base":"main"}}}';
        expect(parseIntentResponse(ok)).toEqual({
            connector: "GitHub",
            action: { kind: "open_pr", fields: { repo: "o/r", title: "Fix", head: "fix", base: "main" } },
        });
        const missing = '{"matched":true,"connector":"GitHub","action":{"kind":"open_pr","fields":{"repo":"o/r","title":"Fix"}}}';
        expect(parseIntentResponse(missing)).toBeNull();
    });

    it("parses a valid update_event action", () => {
        const raw = '{"matched":true,"connector":"Calendar","action":{"kind":"update_event","sourceId":"primary/ev1","fields":{"title":"New"}}}';
        expect(parseIntentResponse(raw)).toEqual({
            connector: "Calendar",
            action: { kind: "update_event", sourceId: "primary/ev1", fields: { title: "New" } },
        });
    });
});
