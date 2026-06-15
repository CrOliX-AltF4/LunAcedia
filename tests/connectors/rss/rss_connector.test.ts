import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RssConnector } from "../../../source/connectors/rss/rss_connector.js";

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Fresh Item</title>
    <link>https://example.com/fresh</link>
    <guid>fresh-1</guid>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <description>A fresh item</description>
  </item>
  <item>
    <title>Old Item</title>
    <link>https://example.com/old</link>
    <guid>old-1</guid>
    <pubDate>${new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString()}</pubDate>
    <description>An old item</description>
  </item>
</channel></rss>`;

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(RSS_FEED),
    }));
    process.env["RSS_FEEDS"]    = JSON.stringify(["https://example.com/feed.xml"]);
    process.env["RSS_ENABLED"]  = "true";
    process.env["RSS_MAX_AGE_HOURS"] = "24";
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["RSS_FEEDS"];
    delete process.env["RSS_ENABLED"];
    delete process.env["RSS_MAX_AGE_HOURS"];
});

describe("RssConnector", () => {
    it("should return events for fresh items", async () => {
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events.some((e) => e.title.includes("Fresh Item"))).toBe(true);
    });

    it("should filter out items older than RSS_MAX_AGE_HOURS", async () => {
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events.every((e) => !e.title.includes("Old Item"))).toBe(true);
    });

    it("should use hostname as label when no label configured", async () => {
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events[0]!.title).toMatch(/\[example\.com\]/);
    });

    it("should use custom label when configured", async () => {
        process.env["RSS_FEEDS"] = JSON.stringify([
            { url: "https://example.com/feed.xml", label: "MyFeed" },
        ]);
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events[0]!.title).toMatch(/\[MyFeed\]/);
    });

    it("should use custom priority when configured", async () => {
        process.env["RSS_FEEDS"] = JSON.stringify([
            { url: "https://example.com/feed.xml", priority: "normal" },
        ]);
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events.every((e) => e.priority === "normal")).toBe(true);
    });

    it("should default to info priority", async () => {
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events.every((e) => e.priority === "info")).toBe(true);
    });

    it("should strip HTML tags from description", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(`<rss version="2.0"><channel>
                <item>
                    <title>Test</title><link>https://x.com/1</link><guid>x-1</guid>
                    <pubDate>${new Date().toUTCString()}</pubDate>
                    <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
                </item></channel></rss>`),
        }));
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events[0]!.body).not.toContain("<p>");
        expect(events[0]!.body).toContain("Hello");
    });

    it("should return empty array when RSS_FEEDS is empty", async () => {
        process.env["RSS_FEEDS"] = "[]";
        const connector = new RssConnector();
        expect(await connector.poll()).toHaveLength(0);
    });

    it("should return empty array when feed fetch fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
        const connector = new RssConnector();
        expect(await connector.poll()).toHaveLength(0);
    });

    it("should set source to rss and type to rss.item", async () => {
        const connector = new RssConnector();
        const events = await connector.poll();
        expect(events[0]!.source).toBe("rss");
        expect(events[0]!.type).toBe("rss.item");
    });
});
