import type { IAIProvider } from "./ai_provider.js";
import type { AcediaEvent } from "../types/acedia_event.js";

export class NullAIProvider implements IAIProvider {
    readonly mode = "none";
    async chat(_query: string): Promise<string> {
        return "";
    }
    async digest(_events: AcediaEvent[]): Promise<string> {
        return "";
    }
}
