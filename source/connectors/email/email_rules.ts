import type { AcediaEventPriority } from "../../types/acedia_event.js";

export interface EmailRule {
    senderPattern: string;
    priority: AcediaEventPriority;
    label?: string;
}

export function parseRules(raw: string): EmailRule[] {
    try {
        const parsed = JSON.parse(raw) as unknown[];
        return parsed.filter(
            (r): r is EmailRule =>
                typeof r === "object" && r !== null && "senderPattern" in r && "priority" in r,
        );
    } catch {
        return [];
    }
}
