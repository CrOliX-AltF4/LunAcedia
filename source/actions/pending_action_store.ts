import type { ConnectorAction } from "../types/connector_action.js";

export interface PendingAction {
    id: string;
    connector: string;
    action: ConnectorAction;
    createdAt: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — long enough for a mobile push round trip or a Natsume voice confirm

/**
 * In-memory only, deliberately — same reasoning as EventStore (ephemeral signal, not
 * durable state). A pending action that outlives a restart is stale by definition (the
 * client that requested it has no way to know it survived), so losing it on restart is
 * correct behavior, not a gap.
 */
export class PendingActionStore {
    private readonly pending = new Map<string, PendingAction>();

    create(connector: string, action: ConnectorAction): PendingAction {
        this.purgeExpired();
        const entry: PendingAction = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            connector,
            action,
            createdAt: Date.now(),
        };
        this.pending.set(entry.id, entry);
        return entry;
    }

    get(id: string): PendingAction | undefined {
        this.purgeExpired();
        return this.pending.get(id);
    }

    consume(id: string): PendingAction | undefined {
        const entry = this.get(id);
        if (entry) this.pending.delete(id);
        return entry;
    }

    list(): PendingAction[] {
        this.purgeExpired();
        return [...this.pending.values()];
    }

    private purgeExpired(): void {
        const cutoff = Date.now() - PENDING_TTL_MS;
        for (const [id, entry] of this.pending) {
            if (entry.createdAt < cutoff) this.pending.delete(id);
        }
    }
}
