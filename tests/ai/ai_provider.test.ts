import { describe, it, expect } from "vitest";
import { formatDigestPrompt } from "../../source/ai/ai_provider";
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
