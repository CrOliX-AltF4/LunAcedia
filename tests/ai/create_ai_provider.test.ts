import { describe, it, expect, afterEach } from "vitest";
import { createAIProvider } from "../../source/ai/create_ai_provider.js";

describe("createAIProvider", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("throws a migration-guidance error for the retired natsume mode, even with its old vars set", () => {
        process.env["AI_PROVIDER"] = "natsume";
        process.env["NATSUME_CORE_URL"] = "http://nas:3333";
        process.env["NATSUME_CORE_SECRET"] = "secret";
        expect(() => createAIProvider()).toThrow(/retired/i);
    });
});
