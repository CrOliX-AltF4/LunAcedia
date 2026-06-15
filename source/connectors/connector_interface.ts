import type { AcediaEvent } from "../types/acedia_event.js";

/** Poll-based connector interface. All LunAcedia connectors implement this. */
export interface IConnector {
    readonly name: string;
    readonly preferredPollIntervalMs?: number;
    poll(): Promise<AcediaEvent[]>;
}
