import type { AcediaEventPriority } from "../../types/acedia_event.js";

export interface EmailRule {
    senderPattern: string;
    priority:      AcediaEventPriority;
    label?:        string;
}

export function parseRules(raw: string): EmailRule[] {
    try {
        const parsed = JSON.parse(raw) as unknown[];
        return parsed.filter(
            (r): r is EmailRule =>
                typeof r === "object" && r !== null &&
                "senderPattern" in r && "priority" in r,
        );
    } catch {
        return [];
    }
}

/**
 * Classify an email by sender + subject against a rule list.
 * First matching rule wins; falls back to "info".
 * Rule: substring match (case-insensitive) — never regex, never LLM.
 */
export function classifyEmail(
    from:    string,
    subject: string,
    rules:   EmailRule[],
): AcediaEventPriority {
    const haystack = `${from} ${subject}`.toLowerCase();
    for (const rule of rules) {
        if (haystack.includes(rule.senderPattern.toLowerCase())) return rule.priority;
    }
    return "info";
}