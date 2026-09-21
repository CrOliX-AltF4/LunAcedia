import type { AcediaEvent } from "../types/acedia_event.js";
import { evaluateGuard, makeVipMatcher } from "./guard_engine.js";
import type { GuardJournal } from "./guard_journal.js";
import type { GuardRulesStore } from "./guard_rules_store.js";
import type { GuardStats } from "./guard_stats.js";
import type { GuardRule } from "./guard_types.js";

export interface GuardOutcome {
    dropped: boolean;
    /** The event to dispatch when not dropped (tags / priority / ruleId applied, input never mutated). */
    event: AcediaEvent;
}

export interface GuardPreview {
    evaluated: number;
    wouldDrop: number;
    wouldTag: number;
    wouldChangePriority: number;
    vipProtected: number;
    /** A few concrete examples so the effect of a rule is visible before it is activated. */
    sample: Array<{ dedupeKey: string; title: string; from: string; outcome: "drop" | "tag" | "priority" | "vip-protected"; ruleId?: string }>;
}

const PREVIEW_SAMPLE = 20;

/**
 * Applies the user's guard rules to events at collection time and remembers what it decided.
 *
 * The verdict cache is the answer to the real cost of a guard (ADR-010 §2): a dropped mail stays
 * unread in the inbox, so without a memory the connector would re-fetch it on every poll. A dropped
 * key is "settled" for as long as the rules have not changed (the cache keys on the rules version),
 * and the hub tells the connector to skip settled keys BEFORE it spends an API call on them.
 */
export class GuardPipeline {
    private readonly dropped = new Map<string, number>(); // dedupeKey → rules version at decision time
    /** A non-urgent event is evaluated by both poll paths; count its rule hits once per rules version. */
    private readonly counted = new Map<string, number>();

    constructor(
        private readonly deps: {
            rules: GuardRulesStore;
            journal: GuardJournal;
            stats: GuardStats;
            /** Read fresh on every call — the VIP list is edited live from the dashboard. */
            vipSenders: () => string[];
        },
    ) {}

    /** True when this key was dropped under the CURRENT rules — no need to fetch or evaluate it again. */
    isSettled(key: string): boolean {
        const version = this.dropped.get(key);
        return version !== undefined && version === this.deps.rules.getVersion();
    }

    process(event: AcediaEvent): GuardOutcome {
        const key = event.dedupeKey;
        // A user-restored event is never evaluated again: the user's decision beats the rules.
        if (this.deps.journal.isRestored(key)) return { dropped: false, event };

        const verdict = evaluateGuard(event, this.deps.rules.peekRules() as GuardRule[], makeVipMatcher(this.deps.vipSenders()));
        const version = this.deps.rules.getVersion();
        if (this.counted.get(key) !== version) {
            if (this.counted.size > 5_000) this.counted.clear();
            this.counted.set(key, version);
            this.deps.stats.hit(verdict.matchedRuleIds);
        }

        if (verdict.drop) {
            this.deps.journal.record(event, verdict.ruleId);
            this.dropped.set(key, this.deps.rules.getVersion());
            return { dropped: true, event };
        }

        // Not dropped (anymore): if a rule edit released it, it leaves the journal.
        this.dropped.delete(key);
        if (this.deps.journal.isFiltered(key)) this.deps.journal.release(key);

        if (verdict.tags.length === 0 && verdict.priority === undefined) return { dropped: false, event };
        const out: AcediaEvent = { ...event };
        if (verdict.priority !== undefined) out.priority = verdict.priority;
        if (verdict.tags.length > 0) out.tags = [...new Set([...(event.tags ?? []), ...verdict.tags])];
        if (verdict.ruleId !== undefined) out.ruleId = verdict.ruleId;
        return { dropped: false, event: out };
    }

    /** User restore: takes the event back out of the journal so the caller can re-dispatch it (bypassing dedup and guard). */
    restore(key: string): AcediaEvent | undefined {
        this.dropped.delete(key);
        return this.deps.journal.restore(key);
    }

    /** Pure what-if: candidate rules against sample events, nothing recorded or counted. */
    preview(candidate: GuardRule[], events: AcediaEvent[]): GuardPreview {
        const isVip = makeVipMatcher(this.deps.vipSenders());
        const result: GuardPreview = { evaluated: events.length, wouldDrop: 0, wouldTag: 0, wouldChangePriority: 0, vipProtected: 0, sample: [] };
        for (const event of events) {
            const v = evaluateGuard(event, candidate, isVip);
            const from = typeof event.meta?.["from"] === "string" ? (event.meta["from"] as string) : "";
            const push = (outcome: GuardPreview["sample"][number]["outcome"]): void => {
                if (result.sample.length < PREVIEW_SAMPLE) result.sample.push({ dedupeKey: event.dedupeKey, title: event.title, from, outcome, ruleId: v.ruleId });
            };
            if (v.drop) { result.wouldDrop += 1; push("drop"); }
            else if (v.vipProtected) { result.vipProtected += 1; push("vip-protected"); }
            if (v.tags.length > 0) { result.wouldTag += 1; if (!v.drop && !v.vipProtected) push("tag"); }
            if (v.priority !== undefined && v.priority !== event.priority) { result.wouldChangePriority += 1; if (!v.drop && v.tags.length === 0) push("priority"); }
        }
        return result;
    }
}
