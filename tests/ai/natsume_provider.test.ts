import { describe, it, expect, vi, beforeEach } from "vitest";
import { NatsumeProvider } from "../../source/ai/natsume_provider";
import type { AcediaEvent } from "../../source/types/acedia_event";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEvent(): AcediaEvent {
    return {
        type: "tasks.due",
        ts: Date.now(),
        source: "tasks",
        title: "Submit report",
        priority: "urgent",
        dedupeKey: "t1",
    };
}

function mockOk(response: string) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response }),
    });
}

describe("NatsumeProvider", () => {
    const provider = new NatsumeProvider("http://nas:3333", "secret-token");

    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should have mode natsume", () => {
        expect(provider.mode).toBe("natsume");
    });

    it("should POST to /api/core/synthesize for chat", async () => {
        mockOk("Natsume says hi.");
        const result = await provider.chat("What's new?");
        expect(result).toBe("Natsume says hi.");
        expect(mockFetch).toHaveBeenCalledWith(
            "http://nas:3333/api/core/synthesize",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("should send Bearer auth header", async () => {
        mockOk("ok");
        await provider.chat("test");
        const [, opts] = mockFetch.mock.calls[0]!;
        expect((opts as RequestInit).headers).toMatchObject({
            Authorization: "Bearer secret-token",
        });
    });

    it("should include query in body for chat", async () => {
        mockOk("ok");
        await provider.chat("Summarize my day");
        const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
            query: string;
            events: AcediaEvent[];
        };
        expect(body.query).toBe("Summarize my day");
        expect(body.events).toEqual([]);
    });

    it("should include events in body for digest", async () => {
        mockOk("Digest from Natsume.");
        const events = [makeEvent()];
        const result = await provider.digest(events);
        expect(result).toBe("Digest from Natsume.");
        const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
            events: AcediaEvent[];
        };
        expect(body.events).toHaveLength(1);
        expect(body.events[0]!.title).toBe("Submit report");
    });

    it("should throw on non-ok response", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
        });
        await expect(provider.chat("test")).rejects.toThrow("Natsume synthesize error: 503");
    });
});
