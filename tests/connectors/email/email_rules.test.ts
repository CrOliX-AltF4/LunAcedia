import { describe, it, expect } from "vitest";
import { parseRules } from "../../../source/connectors/email/email_rules.js";

describe("parseRules", () => {
    it("should parse a valid rules array", () => {
        const raw = JSON.stringify([
            { senderPattern: "boss@corp.com", priority: "urgent" },
            { senderPattern: "newsletter", priority: "info" },
        ]);
        expect(parseRules(raw)).toHaveLength(2);
    });

    it("should return empty array for invalid JSON", () => {
        expect(parseRules("not json")).toHaveLength(0);
    });

    it("should return empty array for empty input", () => {
        expect(parseRules("[]")).toHaveLength(0);
    });

    it("should filter out entries missing required fields", () => {
        const raw = JSON.stringify([
            { senderPattern: "valid@a.com", priority: "urgent" },
            { senderPattern: "no-priority" },
            { priority: "info" },
            "not-an-object",
        ]);
        expect(parseRules(raw)).toHaveLength(1);
    });

    it("should preserve optional label field", () => {
        const raw = JSON.stringify([
            { senderPattern: "a@a.com", priority: "normal", label: "Work" },
        ]);
        const rules = parseRules(raw);
        expect(rules[0]!.label).toBe("Work");
    });
});
