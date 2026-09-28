import { describe, it, expect } from "vitest";
import { validateArgs, type ObjectSchema } from "../../source/capabilities/json_schema.js";

const schema: ObjectSchema = {
    type: "object",
    properties: {
        sourceId: { type: "string", minLength: 1, description: "id" },
        body: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 50 },
        unread: { type: "boolean" },
        priority: { type: "string", enum: ["urgent", "normal", "info"] },
        fields: {
            type: "object",
            properties: { title: { type: "string", minLength: 1 } },
            required: ["title"],
        },
        extra: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["sourceId"],
};

describe("validateArgs — the subset of JSON Schema the capability manifest uses", () => {
    it("accepts a valid object and returns only declared properties", () => {
        const r = validateArgs(schema, { sourceId: "a", body: "b", sneaky: "x" });
        expect(r).toEqual({ ok: true, value: { sourceId: "a", body: "b" } });
    });

    it("rejects a missing required property, naming it", () => {
        const r = validateArgs(schema, { body: "b" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("sourceId");
    });

    it("rejects an empty string where minLength is 1", () => {
        expect(validateArgs(schema, { sourceId: "" }).ok).toBe(false);
    });

    it("rejects a wrong type", () => {
        expect(validateArgs(schema, { sourceId: 3 }).ok).toBe(false);
        expect(validateArgs(schema, { sourceId: "a", unread: "yes" }).ok).toBe(false);
    });

    it("checks integers and their bounds", () => {
        expect(validateArgs(schema, { sourceId: "a", count: 10 }).ok).toBe(true);
        expect(validateArgs(schema, { sourceId: "a", count: 1.5 }).ok).toBe(false);
        expect(validateArgs(schema, { sourceId: "a", count: 0 }).ok).toBe(false);
        expect(validateArgs(schema, { sourceId: "a", count: 51 }).ok).toBe(false);
    });

    it("checks enums", () => {
        expect(validateArgs(schema, { sourceId: "a", priority: "urgent" }).ok).toBe(true);
        expect(validateArgs(schema, { sourceId: "a", priority: "critical" }).ok).toBe(false);
    });

    it("validates nested objects and strips their undeclared properties too", () => {
        expect(validateArgs(schema, { sourceId: "a", fields: { title: "t", x: 1 } })).toEqual({
            ok: true,
            value: { sourceId: "a", fields: { title: "t" } },
        });
        expect(validateArgs(schema, { sourceId: "a", fields: {} }).ok).toBe(false);
    });

    it("accepts a free-form string map when additionalProperties is a schema", () => {
        expect(validateArgs(schema, { sourceId: "a", extra: { k: "v" } })).toEqual({
            ok: true,
            value: { sourceId: "a", extra: { k: "v" } },
        });
        expect(validateArgs(schema, { sourceId: "a", extra: { k: 1 } }).ok).toBe(false);
    });

    it("rejects anything that is not a plain object at the top", () => {
        expect(validateArgs(schema, null).ok).toBe(false);
        expect(validateArgs(schema, ["a"]).ok).toBe(false);
        expect(validateArgs(schema, "a").ok).toBe(false);
    });
});
