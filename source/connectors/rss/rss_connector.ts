import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";
import { parseFeed } from "./rss_parser.js";

interface FeedConfig {
    url: string;
    label?: string;
    priority?: AcediaEventPriority;
}

function parseFeedConfigs(raw: string): FeedConfig[] {
    try {
        const parsed = JSON.parse(raw) as unknown[];
        return parsed.map((item) =>
            typeof item === "string" ? { url: item } : (item as FeedConfig),
        );
    } catch {
        return [];
    }
}

/**
 * Polls a configurable list of RSS 2.0 / Atom feeds.
 *
 * Config (in .env):
 *   RSS_FEEDS='["https://hnrss.org/frontpage", {"url":"https://lobste.rs/rss","label":"Lobsters","priority":"info"}]'
 *   RSS_MAX_AGE_HOURS=24   — ignore items older than N hours (default 24, prevents flooding on first run)
 *   RSS_POLL_INTERVAL_MIN=30
 *
 * Rule: classification by recency and feed config only — never by LLM.
 */
export class RssConnector implements IConnector {
    readonly name = "RSS";
    readonly preferredPollIntervalMs: number;

    private readonly feeds: FeedConfig[];
    private readonly maxAgeMs: number;

    constructor() {
        this.feeds = parseFeedConfigs(process.env["RSS_FEEDS"] ?? "[]");

        const intervalMin = parseInt(process.env["RSS_POLL_INTERVAL_MIN"] ?? "30", 10);
        this.preferredPollIntervalMs = Math.max(5, intervalMin) * 60_000;

        const maxAgeHours = parseInt(process.env["RSS_MAX_AGE_HOURS"] ?? "24", 10);
        this.maxAgeMs = Math.max(1, maxAgeHours) * 60 * 60_000;
    }

    async poll(): Promise<AcediaEvent[]> {
        if (this.feeds.length === 0) return [];

        const results = await Promise.allSettled(this.feeds.map((feed) => this.pollFeed(feed)));

        return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }

    private async pollFeed(feed: FeedConfig): Promise<AcediaEvent[]> {
        let xml: string;
        try {
            const resp = await fetch(feed.url, {
                headers: { "User-Agent": "LunAcedia/0.1 RSS reader" },
            });
            if (!resp.ok) {
                console.warn(`[RSS] ${feed.url} returned ${resp.status}`);
                return [];
            }
            xml = await resp.text();
        } catch (e) {
            console.error(`[RSS] fetch error for ${feed.url}:`, (e as Error).message);
            return [];
        }

        const items = parseFeed(xml);
        const cutoff = Date.now() - this.maxAgeMs;
        const label = feed.label ?? new URL(feed.url).hostname;

        return items
            .filter((item) => {
                if (!item.title || !item.link) return false;
                if (item.pubDate && item.pubDate.getTime() < cutoff) return false;
                return true;
            })
            .map((item) => ({
                type: "rss.item" as const,
                ts: item.pubDate?.getTime() ?? Date.now(),
                source: "rss" as const,
                title: `[${label}] ${item.title}`,
                body: item.description
                    ? item.description
                          .replace(/<[^>]+>/g, "")
                          .slice(0, 200)
                          .trim()
                    : undefined,
                url: item.link,
                priority: feed.priority ?? "info",
                dedupeKey: `rss-${Buffer.from(item.guid).toString("base64").slice(0, 32)}`,
            }));
    }
}
