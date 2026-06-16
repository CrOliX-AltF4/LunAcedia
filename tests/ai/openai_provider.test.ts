import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "../../source/ai/openai_provider";
import type { AcediaEvent } from "../../source/types/acedia_event";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeEvent(): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: "Test",
        priority: "normal",
        dedupeKey: "e1",
    };
}

function mockOk(content: string) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
    });
}

describe("OpenAIProvider", () => {
    const provider = new OpenAIProvider("sk-test", "gpt-4o-mini", "You are a butler.");

    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should have mode openai", () => {
        expect(provider.mode).toBe("openai");
    });

    it("should call OpenAI API and return content", async () => {
        mockOk("Summary here.");
        const result = await provider.chat("Hello");
        expect(result).toBe("Summary here.");
        expect(mockFetch).toHaveBeenCalledWith(
            "https://api.openai.com/v1/chat/completions",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("should include authorization header", async () => {
        mockOk("ok");
        await provider.chat("test");
        const [, opts] = mockFetch.mock.calls[0]!;
        expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
    });

    it("should throw on non-ok response", async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
        await expect(provider.chat("test")).rejects.toThrow("OpenAI error: 401");
    });

    it("should call digest with formatted prompt", async () => {
        mockOk("Digest done.");
        const result = await provider.digest([makeEvent()]);
        expect(result).toBe("Digest done.");
        const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as {
            messages: Array<{ content: string }>;
        };
        expect(body.messages[1]!.content).toContain("[EMAIL]");
    });
});
