/**
 * Discriminated union of write operations connectors can execute.
 *
 * Kind names are globally unique across connectors (not just per-connector) because
 * ActionTierStore keys autonomy tiers by kind alone — "delete_email" and "delete_event"
 * must never collide the way a bare "delete" would.
 */
/** The sorting a batch may apply (bulk_email) — the Core mirrors this list as is. */
export type BulkEmailKind =
    | "archive_email"
    | "delete_email"
    | "mark_email_read"
    | "mark_email_unread"
    | "mark_spam"
    | "star_email"
    | "label_email";

/** What a rule may do at the source, on each mail it matches at collection — the Core mirrors this list as is. */
export type RuleSourceKind =
    | "archive_email"
    | "delete_email"
    | "mark_spam"
    | "mark_email_read"
    | "star_email"
    | "label_email";

export type ConnectorAction =
    // Gmail
    | { kind: "reply"; sourceId: string; body: string }
    | { kind: "archive_email"; sourceId: string }
    | { kind: "delete_email"; sourceId: string }
    | { kind: "mark_email_read"; sourceId: string }
    | { kind: "mark_email_unread"; sourceId: string }
    | { kind: "mark_spam"; sourceId: string }
    | { kind: "unmark_spam"; sourceId: string }
    | { kind: "star_email"; sourceId: string }
    | { kind: "unstar_email"; sourceId: string }
    // `label` is the Gmail label's name, as Master writes it — created on first use.
    | { kind: "label_email"; sourceId: string; label: string }
    | { kind: "unlabel_email"; sourceId: string; label: string }
    // Every mail of the box that matches (criteria ANDed, at least one). LunAcedia computes the selection and freezes
    // `sourceIds` (and how many `matched`) when the batch is proposed — a caller's ids are never kept.
    | {
          kind: "bulk_email";
          action: BulkEmailKind;
          match: { from?: string; fromContains?: string; fromDomain?: string; subjectContains?: string };
          label?: string;
          sourceIds?: string[];
          matched?: number;
      }
    // A sorting rule for the mails to come (a guard rule acting at the source), added once Master confirms.
    | {
          kind: "create_rule";
          name: string;
          match: { from?: string; fromContains?: string; fromDomain?: string; subjectContains?: string };
          action: RuleSourceKind;
          label?: string;
      }
    // Google Calendar
    | {
          kind: "create_event";
          fields: {
              summary: string;
              start: string;
              end: string;
              description?: string;
              location?: string;
              calendarId?: string;
          };
      }
    | { kind: "update_event"; sourceId: string; fields: Record<string, string> }
    | { kind: "delete_event"; sourceId: string }
    // Google Tasks
    | {
          kind: "create_task";
          fields: { title: string; due?: string; notes?: string; listId?: string };
      }
    | { kind: "complete_task"; sourceId: string }
    | { kind: "delete_task"; sourceId: string }
    // GitHub — sourceId is always "{owner}/{repo}#{number}" for existing issues/PRs
    | { kind: "comment_issue"; sourceId: string; body: string }
    | { kind: "add_label"; sourceId: string; label: string }
    | { kind: "create_issue"; fields: { repo: string; title: string; body?: string } }
    | { kind: "close_issue"; sourceId: string }
    | {
          kind: "open_pr";
          fields: { repo: string; title: string; head: string; base: string; body?: string };
      }
    // merge_pr's tier is hardcoded to "manual" in ActionTierStore and cannot be relaxed —
    // "ouvrir une PR peut être auto ou confirmation, mais merger reste toujours humain."
    | { kind: "merge_pr"; sourceId: string }
    // GitHub notification thread — sourceId is the *dedupeKey* of the originating
    // github.formatThread() event ("gh-{reason}-{threadId}"), not "{owner}/{repo}#{number}"
    // like every other GitHub action: a notification thread has no issue/PR number of its
    // own (it can point at a push, a commit, a whole repo), only a thread id, and that id is
    // always the dedupeKey's last "-"-separated segment (reason values never contain a dash).
    // Encoding sourceId as the full dedupeKey rather than the bare thread id lets
    // event_sync.ts map straight back to the EventStore entry with zero extra bookkeeping.
    | { kind: "mark_notification_read"; sourceId: string };
