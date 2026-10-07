/**
 * The small subset of JSON Schema the capability manifest uses. The same schema is sent
 * to the model as a tool's `parameters` and used here to re-validate whatever the model returns —
 * a tool call is a request, never a guarantee. No dependency: the subset is deliberately tiny.
 *
 * Validation returns a *new* value holding only declared properties, so an undeclared field the
 * model slipped in never reaches a connector.
 */

export interface StringSchema {
    type: "string";
    description?: string;
    minLength?: number;
    enum?: readonly string[];
    /** The form the string must have (a composite id): refused with its description, so the model can correct it. */
    pattern?: string;
}
export interface IntegerSchema {
    type: "integer";
    description?: string;
    minimum?: number;
    maximum?: number;
}
export interface BooleanSchema {
    type: "boolean";
    description?: string;
}
export interface ObjectSchema {
    type: "object";
    description?: string;
    properties?: Record<string, Schema>;
    required?: readonly string[];
    /** A schema here makes the object a free-form map whose values must match it. */
    additionalProperties?: Schema;
}
export type Schema = StringSchema | IntegerSchema | BooleanSchema | ObjectSchema;

export type Validation =
    { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function check(
    schema: Schema,
    value: unknown,
    path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
    switch (schema.type) {
        case "string": {
            if (typeof value !== "string") return { ok: false, error: `${path} must be a string` };
            if (schema.minLength !== undefined && value.length < schema.minLength)
                return { ok: false, error: `${path} must not be empty` };
            if (schema.enum && !schema.enum.includes(value))
                return { ok: false, error: `${path} must be one of ${schema.enum.join(", ")}` };
            if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
                return {
                    ok: false,
                    error: `${path} must be ${schema.description ?? `of the form ${schema.pattern}`}`,
                };
            return { ok: true, value };
        }
        case "integer": {
            if (typeof value !== "number" || !Number.isInteger(value))
                return { ok: false, error: `${path} must be an integer` };
            if (schema.minimum !== undefined && value < schema.minimum)
                return { ok: false, error: `${path} must be at least ${schema.minimum}` };
            if (schema.maximum !== undefined && value > schema.maximum)
                return { ok: false, error: `${path} must be at most ${schema.maximum}` };
            return { ok: true, value };
        }
        case "boolean":
            return typeof value === "boolean"
                ? { ok: true, value }
                : { ok: false, error: `${path} must be a boolean` };
        case "object": {
            if (!isPlainObject(value)) return { ok: false, error: `${path} must be an object` };
            const out: Record<string, unknown> = {};
            for (const key of schema.required ?? []) {
                if (value[key] === undefined)
                    return { ok: false, error: `${path}.${key} is required` };
            }
            for (const [key, sub] of Object.entries(schema.properties ?? {})) {
                if (value[key] === undefined) continue;
                const r = check(sub, value[key], `${path}.${key}`);
                if (!r.ok) return r;
                out[key] = r.value;
            }
            if (schema.additionalProperties) {
                for (const [key, v] of Object.entries(value)) {
                    if (schema.properties && key in schema.properties) continue;
                    const r = check(schema.additionalProperties, v, `${path}.${key}`);
                    if (!r.ok) return r;
                    out[key] = r.value;
                }
            }
            return { ok: true, value: out };
        }
    }
}

export function validateArgs(schema: ObjectSchema, value: unknown): Validation {
    const r = check(schema, value, "arguments");
    if (!r.ok) return r;
    return { ok: true, value: r.value as Record<string, unknown> };
}
