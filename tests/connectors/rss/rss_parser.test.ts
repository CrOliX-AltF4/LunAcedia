import { describe, it, expect } from "vitest";
import { parseFeed } from "../../../source/connectors/rss/rss_parser.js";

const RSS2_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/1</link>
      <guid>https://example.com/1</guid>
      <pubDate>Mon, 15 Jun 2026 10:00:00 +0000</pubDate>
      <description>Hello world</description>
    </item>
    <item>
      <title><![CDATA[Second & Post]]></title>
      <link>https://example.com/2</link>
      <guid>unique-guid-2</guid>
      <pubDate>Mon, 15 Jun 2026 11:00:00 +0000</pubDate>
      <description><![CDATA[<p>Rich <b>content</b></p>]]></description>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry 1</title>
    <link href="https://example.com/a1"/>
    <id>urn:uuid:atom-1</id>
    <updated>2026-06-15T10:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
  <entry>
    <title>Atom Entry 2</title>
    <link href="https://example.com/a2"/>
    <id>urn:uuid:atom-2</id>
    <updated>2026-06-15T11:00:00Z</updated>
  </entry>
</feed>`;

describe("parseFeed — RSS 2.0", () => {
    it("should parse two items", () => {
        const items = parseFeed(RSS2_FEED);
        expect(items).toHaveLength(2);
    });

    it("should extract title, link, guid", () => {
        const [first] = parseFeed(RSS2_FEED);
        expect(first!.title).toBe("First Post");
        expect(first!.link).toBe("https://example.com/1");
        expect(first!.guid).toBe("https://example.com/1");
    });

    it("should handle CDATA in title", () => {
        const items = parseFeed(RSS2_FEED);
        expect(items[1]!.title).toBe("Second & Post");
    });

    it("should parse pubDate into a Date", () => {
        const [first] = parseFeed(RSS2_FEED);
        expect(first!.pubDate).toBeInstanceOf(Date);
        expect(first!.pubDate!.getFullYear()).toBe(2026);
    });

    it("should extract description", () => {
        const [first] = parseFeed(RSS2_FEED);
        expect(first!.description).toBe("Hello world");
    });

    it("should handle CDATA in description", () => {
        const items = parseFeed(RSS2_FEED);
        expect(items[1]!.description).toContain("Rich");
    });
});

describe("parseFeed — Atom", () => {
    it("should parse two entries", () => {
        const items = parseFeed(ATOM_FEED);
        expect(items).toHaveLength(2);
    });

    it("should extract title and link from href attribute", () => {
        const [first] = parseFeed(ATOM_FEED);
        expect(first!.title).toBe("Atom Entry 1");
        expect(first!.link).toBe("https://example.com/a1");
    });

    it("should use id as guid", () => {
        const [first] = parseFeed(ATOM_FEED);
        expect(first!.guid).toBe("urn:uuid:atom-1");
    });

    it("should parse updated date", () => {
        const [first] = parseFeed(ATOM_FEED);
        expect(first!.pubDate).toBeInstanceOf(Date);
    });

    it("should extract summary as description", () => {
        const [first] = parseFeed(ATOM_FEED);
        expect(first!.description).toBe("Atom summary");
    });

    it("should return empty description when absent", () => {
        const items = parseFeed(ATOM_FEED);
        expect(items[1]!.description).toBe("");
    });
});

describe("parseFeed — edge cases", () => {
    it("should return empty array for empty string", () => {
        expect(parseFeed("")).toHaveLength(0);
    });

    it("should return empty array for non-feed XML", () => {
        expect(parseFeed("<html><body>Not a feed</body></html>")).toHaveLength(0);
    });
});
