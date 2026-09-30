/**
 * What a paired device may reach (ADR-020 M3) — an explicit allowlist: everything else needs the admin secret
 * (configuration, guards, OAuth, action tiers, direct actions, the raw agent, spend settings, device management).
 * Adding a mobile feature means adding its route here, on purpose.
 */
const DEVICE_ROUTES: { method: string; pattern: RegExp }[] = [
    { method: "GET", pattern: /^\/api\/identity$/ },
    // The box (ADR-018) and its gestures
    { method: "GET", pattern: /^\/api\/inbox$/ },
    { method: "GET", pattern: /^\/api\/inbox\/trash$/ },
    { method: "POST", pattern: /^\/api\/inbox\/trash\/[^/]+\/restore$/ },
    { method: "POST", pattern: /^\/api\/inbox\/[^/]+\/[^/]+$/ },
    // The legacy event list and chat, until the app has moved to the box and the topics
    { method: "GET", pattern: /^\/api\/events$/ },
    { method: "POST", pattern: /^\/api\/events\/read-all$/ },
    { method: "POST", pattern: /^\/api\/events\/.+\/read$/ },
    { method: "POST", pattern: /^\/api\/chat$/ },
    // Topics (ADR-020 amendment 1)
    { method: "GET", pattern: /^\/api\/conversations$/ },
    { method: "POST", pattern: /^\/api\/conversations$/ },
    { method: "GET", pattern: /^\/api\/conversations\/[^/]+$/ },
    { method: "POST", pattern: /^\/api\/conversations\/[^/]+\/messages$/ },
    { method: "PATCH", pattern: /^\/api\/conversations\/[^/]+$/ },
    { method: "DELETE", pattern: /^\/api\/conversations\/[^/]+$/ },
    // Actions waiting for Master
    { method: "GET", pattern: /^\/api\/actions\/pending$/ },
    { method: "POST", pattern: /^\/api\/actions\/[^/]+\/(confirm|cancel)$/ },
    { method: "GET", pattern: /^\/api\/digest$/ },
    // Its own notifications
    { method: "POST", pattern: /^\/api\/devices\/push-token$/ },
    { method: "DELETE", pattern: /^\/api\/devices\/push-token$/ },
    // The agent's switch — read, and turn OFF only (law 3; turning it back on is the dashboard's or the panel's)
    { method: "GET", pattern: /^\/api\/agent\/settings$/ },
    { method: "PUT", pattern: /^\/api\/agent\/settings$/ },
];

export function isDeviceRoute(method: string, path: string): boolean {
    return DEVICE_ROUTES.some((r) => r.method === method && r.pattern.test(path));
}
