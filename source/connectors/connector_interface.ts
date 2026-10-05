import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { ConnectorSlug } from "./connector_registry.js";

/**
 * Where an item we hold stands at its source: still in the inbox unread or read, or gone
 * (archived, trashed, deleted, marked done — elsewhere or by us). Drives the sync rule: an item never
 * outlives its linked object.
 */
export type SourceState = "unread" | "read" | "gone";

/** Master's own gestures on an item of the box — never offered to the agent as tools. */
export type InboxGesture = "open" | "read" | "unread" | "archive" | "trash" | "done";

/** What the gesture changed at the source (null: nothing), and the full text for "open". */
export interface InboxGestureResult {
    change: "removed" | "read" | "unread" | null;
    body?: string;
}

/** Poll-based connector interface. All LunAcedia connectors implement this. */
export interface IConnector {
    readonly slug: ConnectorSlug;
    readonly name: string;
    readonly preferredPollIntervalMs?: number;
    poll(): Promise<AcediaEvent[]>;
    /**
     * Optional. The hub hands the connector a predicate telling it which event keys are already settled
     * (dispatched, or dropped by a guard under the current rules) so it can skip the per-item API call
     * for them — an unread mail stays in the inbox and would otherwise be re-fetched on every poll.
     */
    setSettledFilter?(isSettled: (dedupeKey: string) => boolean): void;
    /** Optional write operations. Only connectors that support actions implement this. */
    executeAction?(action: ConnectorAction): Promise<void>;
    /**
     * Optional: the source state of the given events this connector can judge. Events it
     * cannot judge are simply absent from the map; null means the source could not be asked — the caller
     * must then change nothing (never remove on uncertainty).
     */
    sourceState?(events: AcediaEvent[]): Promise<Map<string, SourceState> | null>;
    /**
     * Optional: applies one of Master's gestures at the source. Throws for a gesture that has
     * no meaning for this connector, or an item it cannot address.
     */
    inboxGesture?(gesture: InboxGesture, event: AcediaEvent): Promise<InboxGestureResult>;
}
