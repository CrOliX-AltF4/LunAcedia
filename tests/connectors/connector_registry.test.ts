import { describe, it, expect } from "vitest";
import { CONNECTOR_REGISTRY } from "../../source/connectors/connector_registry.js";

describe("CONNECTOR_REGISTRY", () => {
    it("keys every entry by its own slug", () => {
        for (const [key, meta] of Object.entries(CONNECTOR_REGISTRY)) {
            expect(meta.slug).toBe(key);
        }
    });

    it("has a non-empty label for every connector", () => {
        for (const meta of Object.values(CONNECTOR_REGISTRY)) {
            expect(meta.label.length).toBeGreaterThan(0);
        }
    });

    it("covers all six connector slugs", () => {
        expect(Object.keys(CONNECTOR_REGISTRY).sort()).toEqual(
            ["calendar", "email", "github", "ha", "rss", "tasks"].sort(),
        );
    });
});
