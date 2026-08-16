export interface TimeSlot {
    start: number;
    end: number;
}

/**
 * Deterministic gap-finding over a set of busy intervals within [windowStart, windowEnd) —
 * no LLM (design rule, same as conflict detection). Overlapping/adjacent busy intervals are
 * merged first so two back-to-back or overlapping meetings don't produce a bogus zero-width
 * "free" slot between them. Only gaps of at least minGapMs are returned.
 */
export function computeFreeSlots(
    busyIntervals: TimeSlot[],
    windowStart: number,
    windowEnd: number,
    minGapMs: number,
): TimeSlot[] {
    if (windowStart >= windowEnd || minGapMs <= 0) return [];

    const clipped = busyIntervals
        .filter((b) => b.end > windowStart && b.start < windowEnd)
        .map((b) => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }))
        .sort((a, b) => a.start - b.start);

    const merged: TimeSlot[] = [];
    for (const b of clipped) {
        const last = merged[merged.length - 1];
        if (last && b.start <= last.end) {
            last.end = Math.max(last.end, b.end);
        } else {
            merged.push({ ...b });
        }
    }

    const free: TimeSlot[] = [];
    let cursor = windowStart;
    for (const b of merged) {
        if (b.start - cursor >= minGapMs) free.push({ start: cursor, end: b.start });
        cursor = Math.max(cursor, b.end);
    }
    if (windowEnd - cursor >= minGapMs) free.push({ start: cursor, end: windowEnd });
    return free;
}
