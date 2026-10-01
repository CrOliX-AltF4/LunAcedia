import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentService } from "../../source/agent/agent_service.js";
import type { AgentResult } from "../../source/agent/agent_loop.js";

function result(over: Partial<AgentResult> = {}): AgentResult {
    return {
        version: 1,
        status: "done",
        summary: "ok",
        items: [],
        actions: [],
        steps: [],
        ...over,
    };
}

async function tmpFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-settings-"));
    return path.join(dir, "agent_settings.json");
}

describe("AgentService — switch and journal (ADR-017 M5, law 3)", () => {
    it("is on by default", async () => {
        const s = new AgentService(await tmpFile());
        await s.load();
        expect(s.isEnabled()).toBe(true);
    });

    it("persists the switch across restarts", async () => {
        const file = await tmpFile();
        const a = new AgentService(file);
        await a.load();
        await a.setEnabled(false);
        const b = new AgentService(file);
        await b.load();
        expect(b.isEnabled()).toBe(false);
    });

    it("keeps writes off by default and persists the choice", async () => {
        const file = await tmpFile();
        const a = new AgentService(file);
        await a.load();
        expect(a.writesEnabled()).toBe(false);
        await a.setWrites(true);
        const b = new AgentService(file);
        await b.load();
        expect(b.writesEnabled()).toBe(true);
        expect(b.isEnabled()).toBe(true);
    });

    it("keeps working in memory when there is no settings file", async () => {
        const s = new AgentService();
        await s.load();
        await s.setEnabled(false);
        expect(s.isEnabled()).toBe(false);
    });

    it("treats an unreadable settings file as the default instead of failing", async () => {
        const file = await tmpFile();
        await fs.writeFile(file, "{broken", "utf-8");
        const s = new AgentService(file);
        await s.load();
        expect(s.isEnabled()).toBe(true);
    });

    it("journals each run, newest first, with who asked, what, the outcome and how long", async () => {
        let t = 1_000;
        const s = new AgentService(undefined, () => t);
        await s.run({ text: "premier", callerId: "natsume-core" }, async () => {
            t += 250;
            return result({ summary: "a" });
        });
        await s.run({ text: "second" }, async () =>
            result({ status: "limit_reached", limit: "steps" }),
        );
        const j = s.journal();
        expect(j.map((e) => e.text)).toEqual(["second", "premier"]);
        expect(j[1]).toMatchObject({ callerId: "natsume-core", status: "done", ms: 250 });
        expect(j[0]).toMatchObject({ status: "limit_reached", limit: "steps" });
    });

    it("keeps only the 50 most recent runs and truncates long requests", async () => {
        const s = new AgentService();
        for (let i = 0; i < 60; i++) await s.run({ text: `r${i}` }, async () => result());
        await s.run({ text: "x".repeat(1_000) }, async () => result());
        const j = s.journal();
        expect(j).toHaveLength(50);
        expect(j[0]!.text.length).toBeLessThanOrEqual(301);
    });

    it("journals a run that threw, then rethrows it", async () => {
        const s = new AgentService();
        await expect(
            s.run({ text: "boom" }, async () => {
                throw new Error("provider down");
            }),
        ).rejects.toThrow("provider down");
        expect(s.journal()[0]).toMatchObject({
            text: "boom",
            status: "error",
            error: "provider down",
        });
    });
});

describe("AgentService — topics (ADR-020 amendment 1, S1)", () => {
    it("journals the topic a run answered in", async () => {
        const s = new AgentService();
        await s.run({ text: "et le deuxième ?", conversationId: "topic-1" }, async () => ({
            version: 1,
            status: "done",
            summary: "ok",
            items: [],
            actions: [],
            steps: [],
        }));
        expect(s.journal()[0]).toMatchObject({
            conversationId: "topic-1",
            text: "et le deuxième ?",
        });
    });
});
