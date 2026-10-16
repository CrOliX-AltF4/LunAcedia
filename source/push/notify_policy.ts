import type { AcediaEvent, AcediaEventPriority } from "../types/acedia_event.js";

const FILTER_DEFAULT: AcediaEventPriority[] = ["urgent"];

/** The priorities that ring the phone: ACEDIA_FCM_FILTER (comma-separated), urgent only by default. */
export function notifyFilterFromEnv(raw = process.env["ACEDIA_FCM_FILTER"]): AcediaEventPriority[] {
    const filter = (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is AcediaEventPriority => ["urgent", "normal", "info"].includes(s));
    return filter.length > 0 ? filter : FILTER_DEFAULT;
}

/**
 * Whether a new item rings the phone — the one rule, whoever sends the notification: LunAcedia itself when the phone
 * is standalone, the hub when it is wired (it relays this decision, never makes its own).
 */
export function rings(event: AcediaEvent, filter: readonly AcediaEventPriority[]): boolean {
    return event.read !== true && filter.includes(event.priority);
}
