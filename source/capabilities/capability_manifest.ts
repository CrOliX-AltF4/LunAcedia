/**
 * Capability manifests. Each
 * connector that can act declares its actions once, here: what the model is told (description +
 * JSON schema), how the arguments are re-validated, the default autonomy tier and the risk level.
 *
 * Single source of truth for: the tools offered to the agent, argument validation, and
 * DEFAULT_ACTION_TIERS / ACTION_RISK (derived in action_tier.ts). The configuration half of the
 * manifest (instances, config schema, generated forms — K1b) comes with the Discord migration.
 */
import type { ConnectorAction } from "../types/connector_action.js";
import type { ActionKind, ActionRisk, ActionTier } from "../types/action_tier.js";
import { CONNECTOR_REGISTRY, type ConnectorSlug } from "../connectors/connector_registry.js";
import { validateArgs, type ObjectSchema } from "./json_schema.js";

export interface ActionCapability {
    kind: ActionKind;
    /** What it does, in Master's words (French) — the one label the push, the dashboard and the Core show. */
    label: string;
    /** IConnector.name of the connector that executes it (the /api/actions lookup key). */
    connector: string;
    description: string;
    /** The action object without its `kind`. */
    params: ObjectSchema;
    defaultTier: ActionTier;
    risk: ActionRisk;
    /** False = never built from model output, whatever the model says (merge_pr). */
    agentAllowed: boolean;
    /**
     * triage = sorting the inbox (read/unread, archive, trash, GitHub notification read); write =
     * everything that creates or sends something. Writes stay off for the agent until a later v1
     * (CrOliX, 2026-09-25) — AgentService's `writes` setting turns them on.
     */
    category: "triage" | "write";
    /**
     * A write opened to the agent even while the writes switch is off — reply, the first one (CrOliX, 2026-10-06).
     * Still under its tier like any action, and its text is shown with the pending action before anything is sent.
     */
    openWrite?: boolean;
}

/** A write the writes switch holds back (every write but the opened ones). */
export function isGatedWrite(a: Pick<ActionCapability, "category" | "openWrite">): boolean {
    return a.category === "write" && a.openWrite !== true;
}

export interface CapabilityManifest {
    slug: ConnectorSlug;
    actions: Omit<ActionCapability, "connector">[];
}

const id = (description: string) => ({ type: "string" as const, minLength: 1, description });
const sourceOnly = (description: string): ObjectSchema => ({
    type: "object",
    properties: { sourceId: id(description) },
    required: ["sourceId"],
});

const MAIL_ID =
    "Gmail message id, taken from a search_events/get_event result (meta.messageId). Never invented.";
const EVENT_ID =
    '"<meta.calendarId>/<meta.eventId>" of an existing event, from a search result. Never invented.';
const TASK_ID =
    '"<meta.listId>/<meta.taskId>" of an existing task, from a search result. Never invented.';
const labelParams = (description: string): ObjectSchema => ({
    type: "object",
    properties: { sourceId: id(MAIL_ID), label: id(description) },
    required: ["sourceId", "label"],
});
const ISSUE_REF = '"owner/repo#number" of an existing issue or pull request.';

export const CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = [
    {
        slug: "email",
        actions: [
            {
                kind: "reply",
                label: "Répondre à un mail",
                description: "Reply to an email thread with a plain-text body.",
                params: {
                    type: "object",
                    properties: {
                        sourceId: id(MAIL_ID),
                        body: { type: "string", description: "Reply text." },
                    },
                    required: ["sourceId", "body"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
                openWrite: true,
            },
            {
                kind: "archive_email",
                label: "Archiver un mail",
                description: "Archive an email (removes it from the inbox, reversible).",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "delete_email",
                label: "Mettre un mail à la corbeille",
                // Gmail's trash, kept 30 days and restorable — not a permanent delete (CrOliX, 2026-10-06).
                description: "Move an email to the trash (Gmail keeps it 30 days, restorable).",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "mark_email_read",
                label: "Marquer un mail lu",
                description: "Mark an email as read.",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "mark_email_unread",
                label: "Marquer un mail non lu",
                description: "Mark an email as unread.",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "mark_spam",
                label: "Mettre un mail en indésirable",
                description: "Report an email as spam (moves it to Spam, out of the inbox).",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "unmark_spam",
                label: "Sortir un mail des indésirables",
                description: "Take an email out of Spam, back to the inbox.",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "star_email",
                label: "Suivre un mail (étoile)",
                description: "Star an email (to follow up).",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "unstar_email",
                label: "Ne plus suivre un mail",
                description: "Remove an email's star.",
                params: sourceOnly(MAIL_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "label_email",
                label: "Ajouter un libellé Gmail",
                description: "Add a Gmail label to an email, by the label's name (created if it does not exist).",
                params: labelParams('Label name, e.g. "Factures".'),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
            {
                kind: "unlabel_email",
                label: "Retirer un libellé Gmail",
                description: "Remove a Gmail label from an email, by the label's name.",
                params: labelParams("Label name, as shown in Gmail."),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
        ],
    },
    {
        slug: "calendar",
        actions: [
            {
                kind: "create_event",
                label: "Créer un événement",
                description: "Create a calendar event. Times are ISO 8601 with a timezone offset.",
                params: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: {
                                summary: {
                                    type: "string",
                                    minLength: 1,
                                    description: "Event title.",
                                },
                                start: {
                                    type: "string",
                                    minLength: 1,
                                    description: "ISO 8601 start.",
                                },
                                end: { type: "string", minLength: 1, description: "ISO 8601 end." },
                                description: { type: "string" },
                                location: { type: "string" },
                                calendarId: { type: "string" },
                            },
                            required: ["summary", "start", "end"],
                        },
                    },
                    required: ["fields"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "update_event",
                label: "Modifier un événement",
                description: "Change fields of an existing calendar event (e.g. its title).",
                params: {
                    type: "object",
                    properties: {
                        sourceId: id(EVENT_ID),
                        fields: {
                            type: "object",
                            description: "Fields to change.",
                            additionalProperties: { type: "string" },
                        },
                    },
                    required: ["sourceId", "fields"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "delete_event",
                label: "Supprimer un événement",
                description: "Delete a calendar event.",
                params: sourceOnly(EVENT_ID),
                defaultTier: "confirm",
                risk: "high",
                agentAllowed: true,
                category: "write",
            },
        ],
    },
    {
        slug: "tasks",
        actions: [
            {
                kind: "create_task",
                label: "Créer une tâche",
                description: "Create a task. `due` is an ISO date (optional).",
                params: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: {
                                title: { type: "string", minLength: 1, description: "Task title." },
                                due: { type: "string" },
                                notes: { type: "string" },
                                listId: { type: "string" },
                            },
                            required: ["title"],
                        },
                    },
                    required: ["fields"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "complete_task",
                label: "Terminer une tâche",
                description: "Mark a task as completed.",
                params: sourceOnly(TASK_ID),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "delete_task",
                label: "Supprimer une tâche",
                description: "Delete a task.",
                params: sourceOnly(TASK_ID),
                defaultTier: "confirm",
                risk: "high",
                agentAllowed: true,
                category: "write",
            },
        ],
    },
    {
        slug: "github",
        actions: [
            {
                kind: "comment_issue",
                label: "Commenter sur GitHub",
                description: "Comment on an issue or pull request.",
                params: {
                    type: "object",
                    properties: {
                        sourceId: id(ISSUE_REF),
                        body: { type: "string", description: "Comment text." },
                    },
                    required: ["sourceId", "body"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "add_label",
                label: "Ajouter un label GitHub",
                description: "Add a label to an issue or pull request.",
                params: {
                    type: "object",
                    properties: {
                        sourceId: id(ISSUE_REF),
                        label: { type: "string", minLength: 1 },
                    },
                    required: ["sourceId", "label"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "create_issue",
                label: "Créer un ticket GitHub",
                description: "Open a new issue in a repository.",
                params: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: {
                                repo: { type: "string", minLength: 1, description: "owner/repo" },
                                title: { type: "string", minLength: 1 },
                                body: { type: "string" },
                            },
                            required: ["repo", "title"],
                        },
                    },
                    required: ["fields"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "close_issue",
                label: "Fermer un ticket GitHub",
                description: "Close an issue.",
                params: sourceOnly(ISSUE_REF),
                defaultTier: "confirm",
                risk: "high",
                agentAllowed: true,
                category: "write",
            },
            {
                kind: "open_pr",
                label: "Ouvrir une PR GitHub",
                description: "Open a pull request from `head` into `base`.",
                params: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: {
                                repo: { type: "string", minLength: 1, description: "owner/repo" },
                                title: { type: "string", minLength: 1 },
                                head: { type: "string", minLength: 1 },
                                base: { type: "string", minLength: 1 },
                                body: { type: "string" },
                            },
                            required: ["repo", "title", "head", "base"],
                        },
                    },
                    required: ["fields"],
                },
                defaultTier: "confirm",
                risk: "medium",
                agentAllowed: true,
                category: "write",
            },
            // "ouvrir une PR peut être auto ou confirmation, mais merger reste toujours humain" (CrOliX).
            {
                kind: "merge_pr",
                label: "Fusionner une PR GitHub",
                description: "Merge a pull request.",
                params: sourceOnly(ISSUE_REF),
                defaultTier: "manual",
                risk: "high",
                agentAllowed: false,
                category: "write",
            },
            {
                kind: "mark_notification_read",
                label: "Marquer une notification GitHub lue",
                description: "Mark a GitHub notification thread as read.",
                params: sourceOnly(
                    'dedupeKey of the GitHub notification event ("gh-<reason>-<threadId>").',
                ),
                defaultTier: "confirm",
                risk: "low",
                agentAllowed: true,
                category: "triage",
            },
        ],
    },
];

export function actionCapabilities(): ActionCapability[] {
    return CAPABILITY_MANIFESTS.flatMap((m) =>
        m.actions.map((a) => ({ ...a, connector: CONNECTOR_REGISTRY[m.slug].label })),
    );
}

export type ActionFromArgs =
    { ok: true; connector: string; action: ConnectorAction } | { ok: false; error: string };

/** Tool call → ConnectorAction, re-validated against the manifest. The kind names its connector. */
export function actionFromArgs(kind: string, args: unknown): ActionFromArgs {
    const cap = actionCapabilities().find((a) => a.kind === kind);
    if (!cap) return { ok: false, error: `unknown action '${kind}'` };
    if (!cap.agentAllowed)
        return { ok: false, error: `'${kind}' is never executed from model output` };
    const v = validateArgs(cap.params, args);
    if (!v.ok) return v;
    return {
        ok: true,
        connector: cap.connector,
        action: { kind: cap.kind, ...v.value } as ConnectorAction,
    };
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: ObjectSchema;
}

/** The actions offered to the model as tools (merge_pr and any other non-agent action left out). */
export function actionToolDefinitions(options: { includeWrites?: boolean } = {}): ToolDefinition[] {
    const includeWrites = options.includeWrites ?? true;
    return actionCapabilities()
        .filter((a) => a.agentAllowed && (includeWrites || !isGatedWrite(a)))
        .map((a) => ({
            name: a.kind,
            description: `${a.description} [${a.connector}]`,
            parameters: a.params,
        }));
}
