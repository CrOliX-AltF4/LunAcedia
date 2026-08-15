import { describe, it, expect } from "vitest";
import { formatDigestPrompt, formatProposalsPrompt } from "../../source/ai/ai_provider";
import type { AcediaEvent } from "../../source/types/acedia_event";

function makeEvent(overrides: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: 1_700_000_000_000,
        source: "email",
        title: "New message",
        priority: "normal",
        dedupeKey: "email-1",
        ...overrides,
    };
}

describe("formatDigestPrompt", () => {
    it("should return fallback string when no events", () => {
        expect(formatDigestPrompt([])).toBe("No pending events.");
    });

    it("should format events with source and title", () => {
        const result = formatDigestPrompt([makeEvent({ source: "email", title: "Invoice" })]);
        expect(result).toContain("[EMAIL]");
        expect(result).toContain("Invoice");
    });

    it("should mark urgent events", () => {
        const result = formatDigestPrompt([
            makeEvent({ priority: "urgent", title: "Server down" }),
        ]);
        expect(result).toContain("[URGENT]");
    });

    it("should include body when present", () => {
        const result = formatDigestPrompt([makeEvent({ body: "Body text here" })]);
        expect(result).toContain("Body text here");
    });

    it("should number events sequentially", () => {
        const events = [makeEvent({ title: "A" }), makeEvent({ title: "B", dedupeKey: "e2" })];
        const result = formatDigestPrompt(events);
        expect(result).toContain("1.");
        expect(result).toContain("2.");
    });

    it("should mention event count in prompt header", () => {
        const events = [makeEvent(), makeEvent({ dedupeKey: "e2" })];
        const result = formatDigestPrompt(events);
        expect(result).toContain("2 events");
    });
});

describe("formatProposalsPrompt", () => {
    it("returns a fallback string when there are no events", () => {
        expect(formatProposalsPrompt([])).toContain("nothing to propose");
    });

    it("marks conflict events distinctly from urgent ones", () => {
        const result = formatProposalsPrompt([
            makeEvent({ type: "calendar.conflict", title: "Overlap", priority: "urgent" }),
        ]);
        expect(result).toContain("[CONFLICT]");
        expect(result).toContain("[URGENT]");
    });

    it("includes the event title and body", () => {
        const result = formatProposalsPrompt([makeEvent({ title: "Server down", body: "prod outage" })]);
        expect(result).toContain("Server down");
        expect(result).toContain("prod outage");
    });

    it("asks for one concrete action per item, not a summary", () => {
        const result = formatProposalsPrompt([makeEvent()]);
        expect(result.toLowerCase()).toContain("propose");
        expect(result.toLowerCase()).toContain("action");
    });

    it("includes free slots in the prompt when a conflict is present", () => {
        const result = formatProposalsPrompt(
            [makeEvent({ type: "calendar.conflict", title: "Overlap" })],
            [{ start: 1_700_000_000_000, end: 1_700_001_800_000 }],
        );
        expect(result).toContain("Open calendar slots");
    });

    it("omits the free-slots block when there is no conflict, even if slots are passed", () => {
        const result = formatProposalsPrompt(
            [makeEvent({ priority: "urgent" })],
            [{ start: 1_700_000_000_000, end: 1_700_001_800_000 }],
        );
        expect(result).not.toContain("Open calendar slots");
    });

    it("omits the free-slots block when there is a conflict but no slots were found", () => {
        const result = formatProposalsPrompt([makeEvent({ type: "calendar.conflict" })], []);
        expect(result).not.toContain("Open calendar slots");
    });
});
