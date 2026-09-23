import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { ConnectorSlug } from "./connector_registry.js";

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
}
