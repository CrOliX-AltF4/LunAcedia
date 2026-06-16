import type { AcediaEvent } from "../types/acedia_event.js";
import type { ConnectorAction } from "../types/connector_action.js";

/** Poll-based connector interface. All LunAcedia connectors implement this. */
export interface IConnector {
    readonly name: string;
    readonly preferredPollIntervalMs?: number;
    poll(): Promise<AcediaEvent[]>;
    /** Optional write operations. Only connectors that support actions implement this. */
    executeAction?(action: ConnectorAction): Promise<void>;
}
