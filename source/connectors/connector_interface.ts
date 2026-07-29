import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";
import type { ConnectorSlug } from "./connector_registry.js";

/** Poll-based connector interface. All LunAcedia connectors implement this. */
export interface IConnector {
    readonly slug: ConnectorSlug;
    readonly name: string;
    readonly preferredPollIntervalMs?: number;
    poll(): Promise<AcediaEvent[]>;
    /** Optional write operations. Only connectors that support actions implement this. */
    executeAction?(action: ConnectorAction): Promise<void>;
}
