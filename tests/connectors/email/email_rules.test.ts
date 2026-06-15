import { describe, it, expect } from "vitest";
import { parseRules, classifyEmail } from "../../../source/connectors/email/email_rules.js";

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

describe("classifyEmail", () => {
    const rules = [
        { senderPattern: "boss@corp.com", priority: "urgent" as const },
        { senderPattern: "@corp.com", priority: "normal" as const },
        { senderPattern: "newsletter", priority: "info" as const },
    ];

    it("should match first rule (boss@corp.com → urgent)", () => {
        expect(classifyEmail("Boss <boss@corp.com>", "Hello", rules)).toBe("urgent");
    });

    it("should match second rule (@corp.com → normal)", () => {
        expect(classifyEmail("team@corp.com", "Update", rules)).toBe("normal");
    });

    it("should match by subject (newsletter → info)", () => {
        expect(classifyEmail("promo@store.com", "Weekly Newsletter", rules)).toBe("info");
    });

    it("should fall back to info when no rule matches", () => {
        expect(classifyEmail("unknown@somewhere.com", "Hi", rules)).toBe("info");
    });

    it("should be case-insensitive", () => {
        expect(classifyEmail("BOSS@CORP.COM", "URGENT", rules)).toBe("urgent");
    });

    it("should return info when rules list is empty", () => {
        expect(classifyEmail("anyone@anywhere.com", "Anything", [])).toBe("info");
    });
});
