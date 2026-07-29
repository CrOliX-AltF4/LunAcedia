import type { AcediaEventSource } from "../types/acedia_event.js";

/** Every connector-producing AcediaEventSource except "system" (not a real connector). */
export type ConnectorSlug = Exclude<AcediaEventSource, "system">;

export interface ConnectorMeta {
    slug: ConnectorSlug;
    label: string;
}

/**
 * Single source of truth for connector slug → human label. Each connector's `name`
 * getter reads from here, so the dashboard filter chips, IConnector.name (used for
 * logging and /api/actions lookup), and /api/health can never drift from each other
 * the way "Gmail" (health) vs "Email" (dashboard) vs "email" (event.source) used to.
 */
export const CONNECTOR_REGISTRY: Record<ConnectorSlug, ConnectorMeta> = {
    email: { slug: "email", label: "Gmail" },
    calendar: { slug: "calendar", label: "Calendar" },
    tasks: { slug: "tasks", label: "Tasks" },
    github: { slug: "github", label: "GitHub" },
    rss: { slug: "rss", label: "RSS" },
    ha: { slug: "ha", label: "Home Assistant" },
};
