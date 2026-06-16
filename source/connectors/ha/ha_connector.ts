import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";

interface HaStateResponse {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
}

function parseEntities(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === "string")
            : [];
    } catch {
        return [];
    }
}

/**
 * Polls Home Assistant entity states and emits an event on each state transition.
 *
 * Config:
 *   HA_URL=http://192.168.1.x:8123     — HA base URL (no trailing slash)
 *   HA_TOKEN=<long-lived access token>
 *   HA_ENTITIES='["sensor.cpu_temp","binary_sensor.motion","light.living_room"]'
 *   HA_POLL_INTERVAL_MIN=1             — default 1 min
 *   HA_PRIORITY=normal                 — urgent|normal|info applied to all events
 *
 * Rule: state-change detection in the connector — never emits the same state twice in a row.
 */
export class HaConnector implements IConnector {
    readonly name = "HomeAssistant";
    readonly preferredPollIntervalMs: number;

    private readonly baseUrl: string;
    private readonly token: string;
    private readonly entities: string[];
    private readonly defaultPriority: AcediaEventPriority;
    private readonly lastState = new Map<string, string>();

    constructor() {
        this.baseUrl = (process.env["HA_URL"] ?? "").replace(/\/$/, "");
        this.token = process.env["HA_TOKEN"] ?? "";
        this.entities = parseEntities(process.env["HA_ENTITIES"] ?? "[]");

        const intervalMin = parseInt(process.env["HA_POLL_INTERVAL_MIN"] ?? "1", 10);
        this.preferredPollIntervalMs = Math.max(1, intervalMin) * 60_000;

        const raw = process.env["HA_PRIORITY"] ?? "normal";
        this.defaultPriority = (
            ["urgent", "normal", "info"].includes(raw) ? raw : "normal"
        ) as AcediaEventPriority;
    }

    async poll(): Promise<AcediaEvent[]> {
        if (!this.baseUrl || !this.token || this.entities.length === 0) return [];

        const results = await Promise.allSettled(
            this.entities.map((id) => this.pollEntity(id)),
        );

        return results.flatMap((r) =>
            r.status === "fulfilled" && r.value ? [r.value] : [],
        );
    }

    private async pollEntity(entityId: string): Promise<AcediaEvent | null> {
        let resp: Response;
        try {
            resp = await fetch(`${this.baseUrl}/api/states/${entityId}`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                },
            });
        } catch (e) {
            console.error(`[HA] fetch error for ${entityId}:`, (e as Error).message);
            return null;
        }

        if (!resp.ok) {
            console.warn(`[HA] ${entityId} returned ${resp.status}`);
            return null;
        }

        const data = (await resp.json()) as HaStateResponse;
        const newState = data.state;
        const prevState = this.lastState.get(entityId);

        if (prevState === newState) return null;
        this.lastState.set(entityId, newState);

        const ts = data.last_changed ? new Date(data.last_changed).getTime() : Date.now();

        return {
            type: "ha.state_changed",
            ts,
            source: "ha",
            title: `${entityId}: ${newState}`,
            body: prevState !== undefined ? `${prevState} → ${newState}` : newState,
            priority: this.defaultPriority,
            dedupeKey: `ha-${entityId}-${newState}-${ts}`,
            meta: { entityId, state: newState, prevState, attributes: data.attributes },
        };
    }
}
