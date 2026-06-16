import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "../../source/ai/ollama_provider";
import type { AcediaEvent } from "../../source/types/acedia_event";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEvent(): AcediaEvent {
    return {
        type: "calendar.upcoming",
        ts: Date.now(),
        source: "calendar",
        title: "Standup",
        priority: "urgent",
        dedupeKey: "c1",
    };
}

function mockOk(content: string) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content } }),
    });
}

describe("OllamaProvider", () => {
    const provider = new OllamaProvider("http://localhost:11434", "llama3.2", "You are a butler.");

    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should have mode ollama", () => {
        expect(provider.mode).toBe("ollama");
    });

    it("should call Ollama /api/chat and return content", async () => {
        mockOk("Response from Ollama.");
        const result = await provider.chat("What's up?");
        expect(result).toBe("Response from Ollama.");
        expect(mockFetch).toHaveBeenCalledWith(
            "http://localhost:11434/api/chat",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("should send stream: false", async () => {
        mockOk("ok");
        await provider.chat("test");
        const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
            stream: boolean;
        };
        expect(body.stream).toBe(false);
    });

    it("should throw on non-ok response", async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });
        await expect(provider.chat("test")).rejects.toThrow("Ollama error: 404");
    });

    it("should call digest with formatted prompt including URGENT", async () => {
        mockOk("Digest.");
        await provider.digest([makeEvent()]);
        const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
            messages: Array<{ content: string }>;
        };
        expect(body.messages[1]!.content).toContain("[URGENT]");
    });
});
