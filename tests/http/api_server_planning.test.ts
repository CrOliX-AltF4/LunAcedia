import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { AgentService } from "../../source/agent/agent_service.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { PlanningStore } from "../../source/planning/planning_store.js";
import { PlanningSync } from "../../source/planning/planning_sync.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";

// GET /api/planning through the real server: behind the admin secret like every non-device route.

let PORT = 50_600 + Math.floor(Math.random() * 200);
const nextPort = () => PORT++;

describe("AcediaApiServer — planning", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(
        withPlanning: boolean,
        opts: {
            connectors?: IConnector[];
            tiers?: Record<string, string>;
            sync?: PlanningSync;
        } = {},
    ) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-planning-"));
        const store = new PlanningStore();
        store.replaceTasks(
            [
                {
                    id: "l/t1",
                    listId: "l",
                    listTitle: "L",
                    title: "Dossier",
                    status: "open",
                    updatedAt: 1,
                },
            ],
            Date.now(),
        );
        const sync =
            opts.sync ?? new PlanningSync({ store, tasks: { readPlanning: async () => [] } });
        const tiers = new ActionTierStore(
            path.join(dir, "tiers.json"),
            path.join(dir, "overrides.json"),
        );
        if (opts.tiers) await tiers.patch(opts.tiers);
        server = new AcediaApiServer(
            new EventStore(),
            opts.connectors ?? [],
            new IngestionHub([]),
            null,
            new NullAIProvider(),
            "s3cret",
            tiers,
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            undefined,
            new AgentService(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            withPlanning ? { store, sync } : undefined,
        );
        const port = nextPort();
        server.start(port);
        return `http://localhost:${port}`;
    }

    it("serves the planning to the admin secret only", async () => {
        const base = await start(true);
        expect((await fetch(`${base}/api/planning`)).status).toBe(401);
        const res = await fetch(`${base}/api/planning`, {
            headers: { Authorization: "Bearer s3cret" },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(["Dossier"]);
        expect(body.complete).toBe(true);
    });

    it("is not found when the planning is not wired", async () => {
        const base = await start(false);
        const res = await fetch(`${base}/api/planning`, {
            headers: { Authorization: "Bearer s3cret" },
        });
        expect(res.status).toBe(404);
    });

    it("reads the planning again right after a gesture on a task — what Natsume did shows at once", async () => {
        const sync = new PlanningSync({ store: new PlanningStore() });
        const spy = vi.spyOn(sync, "syncNow").mockResolvedValue();
        const tasks: IConnector = {
            slug: "tasks",
            name: "Tasks",
            poll: async () => [],
            executeAction: async () => {},
        };
        const base = await start(true, {
            connectors: [tasks],
            tiers: { create_task: "auto" },
            sync,
        });
        const res = await fetch(`${base}/api/actions`, {
            method: "POST",
            headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
            body: JSON.stringify({
                connector: "Tasks",
                action: { kind: "create_task", fields: { title: "Appeler le garage" } },
            }),
        });
        expect(res.status).toBe(204);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
