import type { IAIProvider } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";

interface SynthesizeResponse {
    response: string;
}

export class NatsumeProvider implements IAIProvider {
    readonly mode = "natsume";

    constructor(
        private readonly natsumeUrl: string,
        private readonly natsumeSecret: string,
    ) {}

    async chat(query: string): Promise<string> {
        return this.callSynthesize([], query);
    }

    async digest(events: AcediaEvent[]): Promise<string> {
        return this.callSynthesize(events);
    }

    private async callSynthesize(events: AcediaEvent[], query?: string): Promise<string> {
        const body: { events: AcediaEvent[]; query?: string } = { events };
        if (query) body.query = query;

        const res = await fetch(`${this.natsumeUrl}/api/core/synthesize`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.natsumeSecret}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Natsume synthesize error: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as SynthesizeResponse;
        return data.response;
    }
}
