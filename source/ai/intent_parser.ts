import type { ConnectorAction } from "../types/connector_action.js";
import { actionFromArgs } from "../capabilities/capability_manifest.js";

export interface ParsedIntent {
    connector: string;
    action: ConnectorAction;
}

/** Must match IConnector.name exactly (CONNECTOR_REGISTRY labels) — the same string
 *  POST /api/actions looks connectors up by. */
const VALID_CONNECTORS = new Set(["Gmail", "Calendar", "Tasks", "GitHub"]);

/**
 * Prompt asking the butler to translate free text ("crée-moi une tâche pour rappeler le
 * rendez-vous demain", a voice command relayed as text) into one structured action, or
 * report no actionable intent. Strict JSON only — parseIntentResponse() re-validates every
 * field against the real ConnectorAction shapes below and refuses anything that doesn't
 * match exactly, so a malformed or hallucinated field never reaches an actual API call.
 */
export function formatIntentPrompt(text: string): string {
    return `You translate a user's request into at most one structured action. Reply with
ONLY a JSON object, no prose, no markdown fences.

If the text does not clearly ask for one of the actions below, reply exactly:
{"matched": false}

If it does, reply with exactly this shape (only ONE action, the most specific match):
{"matched": true, "connector": "<Gmail|Calendar|Tasks|GitHub>", "action": { ... }}

Valid "action" shapes, one per line — "kind" is mandatory and fixed, other fields as shown:
- {"kind":"reply","sourceId":"<message id from context, or empty string if unknown>","body":"<reply text>"}
- {"kind":"archive_email","sourceId":"<message id>"}
- {"kind":"delete_email","sourceId":"<message id>"}
- {"kind":"mark_email_read","sourceId":"<message id>"}
- {"kind":"mark_email_unread","sourceId":"<message id>"}
- {"kind":"create_event","fields":{"summary":"<title>","start":"<ISO datetime>","end":"<ISO datetime>"}}
- {"kind":"update_event","sourceId":"<calendarId/eventId>","fields":{"title":"<new title>"}}
- {"kind":"delete_event","sourceId":"<calendarId/eventId>"}
- {"kind":"create_task","fields":{"title":"<task title>","due":"<ISO date, optional>"}}
- {"kind":"complete_task","sourceId":"<task id>"}
- {"kind":"delete_task","sourceId":"<task id>"}
- {"kind":"comment_issue","sourceId":"<owner/repo#number>","body":"<comment text>"}
- {"kind":"add_label","sourceId":"<owner/repo#number>","label":"<label>"}
- {"kind":"create_issue","fields":{"repo":"<owner/repo>","title":"<title>","body":"<optional>"}}
- {"kind":"close_issue","sourceId":"<owner/repo#number>"}
- {"kind":"open_pr","fields":{"repo":"<owner/repo>","title":"<title>","head":"<branch>","base":"<branch>","body":"<optional>"}}

Never invent an id you don't actually have — leave sourceId as an empty string rather than
guessing. Never output "merge_pr" — merging is never done through this parser.

User said: "${text.replace(/"/g, '\\"')}"`;
}

/**
 * Re-validates the AI's JSON reply against the capability manifest — the prompt is a request, not
 * a guarantee. Returns null for anything that doesn't match exactly (missing field, wrong type,
 * unknown kind, unknown connector, or merge_pr — never trusted from free text regardless of what
 * the model outputs). The connector comes from the manifest: an action kind names its connector.
 */
export function parseIntentResponse(raw: string): ParsedIntent | null {
    let parsed: unknown;
    try {
        // Strip markdown code fences if the model added them despite instructions.
        const cleaned = raw
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/```\s*$/i, "");
        parsed = JSON.parse(cleaned);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj["matched"] !== true) return null;
    const connector = obj["connector"];
    if (typeof connector !== "string" || !VALID_CONNECTORS.has(connector)) return null;

    const action = obj["action"];
    if (typeof action !== "object" || action === null) return null;
    const { kind, ...args } = action as Record<string, unknown>;
    if (typeof kind !== "string") return null;

    const built = actionFromArgs(kind, args);
    return built.ok ? { connector: built.connector, action: built.action } : null;
}
