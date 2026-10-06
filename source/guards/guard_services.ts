import type { RuleActionJournal } from "./rule_actor.js";
import type { GuardJournal } from "./guard_journal.js";
import type { GuardPipeline } from "./guard_pipeline.js";
import type { GuardRulesStore } from "./guard_rules_store.js";
import type { GuardStats } from "./guard_stats.js";

/** Everything the HTTP layer needs to expose the ingestion guards — one object, wired once in index.ts. */
export interface GuardServices {
    pipeline: GuardPipeline;
    rules: GuardRulesStore;
    journal: GuardJournal;
    stats: GuardStats;
    /** What rules did at the source (ADR-023 T3) — absent: no such journal on this deployment. */
    ruleActions?: RuleActionJournal;
}
