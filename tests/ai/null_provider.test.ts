import { describe, it, expect } from "vitest";
import { NullAIProvider } from "../../source/ai/null_provider";
import type { AcediaEvent } from "../../source/types/acedia_event";

describe("NullAIProvider", () => {
    const p = new NullAIProvider();

    it("should have mode none", () => {
        expect(p.mode).toBe("none");
    });

    it("should return empty string from chat", async () => {
        expect(await p.chat("hello")).toBe("");
    });

    it("should return empty string from digest", async () => {
        expect(await p.digest([] as AcediaEvent[])).toBe("");
    });
});
