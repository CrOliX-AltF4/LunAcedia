export interface RssItem {
    title: string;
    link: string;
    guid: string;
    pubDate: Date | null;
    description: string;
}

function text(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (!m) return "";
    const raw = m[1]!.trim();
    // Strip CDATA wrapper — regex literal avoids template-literal double-escape pitfall
    const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return cdata ? cdata[1]!.trim() : raw;
}

function attr(xml: string, tag: string, attribute: string): string {
    const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]*)"`, "i"));
    return m ? m[1]!.trim() : "";
}

function parseDate(raw: string): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

/** Parse RSS 2.0 or Atom feed XML into a flat list of items. */
export function parseFeed(xml: string): RssItem[] {
    const isAtom = /<feed[\s>]/i.test(xml);

    if (isAtom) {
        return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
            const entry = m[1]!;
            const link = attr(entry, "link", "href") || text(entry, "link");
            const guid = text(entry, "id") || link;
            return {
                title: text(entry, "title"),
                link,
                guid,
                pubDate: parseDate(text(entry, "updated") || text(entry, "published")),
                description: text(entry, "summary") || text(entry, "content"),
            };
        });
    }

    // RSS 2.0
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
        const item = m[1]!;
        const link = text(item, "link") || attr(item, "link", "href");
        const guid = text(item, "guid") || link;
        return {
            title: text(item, "title"),
            link,
            guid,
            pubDate: parseDate(text(item, "pubDate") || text(item, "dc:date")),
            description: text(item, "description"),
        };
    });
}
