import { describe, it, expect } from "vitest";
import { computeFreeSlots } from "../../../source/connectors/calendar/free_slots.js";

// Window: 0..1000 (arbitrary ms units for readability)
describe("computeFreeSlots", () => {
    it("returns the whole window as one free slot when there are no busy intervals", () => {
        expect(computeFreeSlots([], 0, 1000, 10)).toEqual([{ start: 0, end: 1000 }]);
    });

    it("returns a gap before, between, and after busy intervals", () => {
        const busy = [
            { start: 100, end: 200 },
            { start: 400, end: 500 },
        ];
        expect(computeFreeSlots(busy, 0, 1000, 10)).toEqual([
            { start: 0, end: 100 },
            { start: 200, end: 400 },
            { start: 500, end: 1000 },
        ]);
    });

    it("merges overlapping busy intervals before computing gaps", () => {
        const busy = [
            { start: 100, end: 300 },
            { start: 250, end: 400 },
        ];
        expect(computeFreeSlots(busy, 0, 1000, 10)).toEqual([
            { start: 0, end: 100 },
            { start: 400, end: 1000 },
        ]);
    });

    it("merges adjacent (touching) busy intervals — no zero-width gap between them", () => {
        const busy = [
            { start: 100, end: 300 },
            { start: 300, end: 500 },
        ];
        expect(computeFreeSlots(busy, 0, 1000, 10)).toEqual([
            { start: 0, end: 100 },
            { start: 500, end: 1000 },
        ]);
    });

    it("drops gaps shorter than minGapMs", () => {
        const busy = [
            { start: 100, end: 195 },
            { start: 205, end: 900 },
        ];
        // gap between the two busy blocks is only 10 units — below the 20 threshold
        expect(computeFreeSlots(busy, 0, 1000, 20)).toEqual([
            { start: 0, end: 100 },
            { start: 900, end: 1000 },
        ]);
    });

    it("clips busy intervals that extend outside the window", () => {
        const busy = [{ start: -500, end: 100 }];
        expect(computeFreeSlots(busy, 0, 1000, 10)).toEqual([{ start: 100, end: 1000 }]);
    });

    it("ignores a busy interval entirely outside the window", () => {
        const busy = [{ start: 2000, end: 3000 }];
        expect(computeFreeSlots(busy, 0, 1000, 10)).toEqual([{ start: 0, end: 1000 }]);
    });

    it("returns nothing when the window is fully busy", () => {
        expect(computeFreeSlots([{ start: 0, end: 1000 }], 0, 1000, 10)).toEqual([]);
    });

    it("returns nothing for an inverted or empty window", () => {
        expect(computeFreeSlots([], 1000, 0, 10)).toEqual([]);
        expect(computeFreeSlots([], 500, 500, 10)).toEqual([]);
    });

    it("returns nothing when minGapMs is zero or negative", () => {
        expect(computeFreeSlots([], 0, 1000, 0)).toEqual([]);
        expect(computeFreeSlots([], 0, 1000, -5)).toEqual([]);
    });
});
