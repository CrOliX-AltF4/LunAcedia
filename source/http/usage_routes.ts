/**
 * LunAcedia's LLM usage — it reports, it never caps (D2).
 *
 *   GET /api/usage?days=30          { days: [{ day, totalUsd, byCaller, calls, unpricedCalls }] (newest first, every day of
 *                                    the range), rows: [{ day, caller, purpose, model, calls, tokensIn, tokensOut, costUsd }],
 *                                    callers, lastHourUsd, usualHourlyUsd, alerts: settings, fired: alerts of the week }
 *   GET /api/config/usage-alerts    the alert settings
 *   PUT /api/config/usage-alerts    { dailyUsd, perCallerUsd, spikeFactor, spikeMinUsd } → the settings
 *
 * The Core reads GET /api/usage for Pilotage and relays `fired` to its own alerts (the hub carries, it does not
 * recompute). Contract: `UsageReport` below, mirrored by the Core (tests/…/acedia_usage_contract.test.ts there).
 */
import type http from "node:http";
import {
    USAGE_CALLERS,
    localDay,
    type UsageCaller,
    type UsageDay,
    type UsageLedger,
    type UsageRow,
} from "../usage/llm_usage.js";
import {
    validateSettings,
    type FiredAlert,
    type UsageAlertSettings,
    type UsageAlerts,
} from "../usage/usage_alerts.js";

const DAYS_MAX = 90;
const HOUR_MS = 60 * 60 * 1000;

export interface UsageReport {
    days: UsageDay[];
    rows: UsageRow[];
    callers: readonly UsageCaller[];
    lastHourUsd: number;
    usualHourlyUsd: number;
    alerts: UsageAlertSettings;
    fired: FiredAlert[];
}

export interface UsageRouteDeps {
    ledger: UsageLedger;
    alerts: UsageAlerts;
    readBody: (req: http.IncomingMessage) => Promise<unknown>;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export function usageReport(
    ledger: UsageLedger,
    alerts: UsageAlerts,
    days: number,
    now = Date.now(),
): UsageReport {
    return {
        days: Array.from({ length: days }, (_, i) => ledger.day(localDay(now - i * 86_400_000))),
        rows: ledger.list(days),
        callers: USAGE_CALLERS,
        lastHourUsd: ledger.spentSince(HOUR_MS),
        usualHourlyUsd: ledger.hourlyBaseline(),
        alerts: alerts.getSettings(),
        fired: alerts.recent(),
    };
}

export class UsageRoutes {
    constructor(private readonly deps: UsageRouteDeps) {}

    /** Handles the request if it is a usage route; returns false otherwise. */
    async handle(
        method: string,
        path: string,
        url: URL,
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<boolean> {
        const { json, ledger, alerts } = this.deps;
        if (method === "GET" && path === "/api/usage") {
            const days = Math.min(
                DAYS_MAX,
                Math.max(1, Number(url.searchParams.get("days")) || 30),
            );
            json(res, 200, usageReport(ledger, alerts, days));
            return true;
        }
        if (path === "/api/config/usage-alerts") {
            if (method === "GET") {
                json(res, 200, alerts.getSettings());
                return true;
            }
            if (method === "PUT") {
                let body: unknown;
                try {
                    body = await this.deps.readBody(req);
                } catch {
                    json(res, 400, { error: "Invalid JSON" });
                    return true;
                }
                const valid = validateSettings(body);
                if ("error" in valid) {
                    json(res, 400, { error: valid.error });
                    return true;
                }
                await alerts.setSettings(valid);
                json(res, 200, alerts.getSettings());
                return true;
            }
        }
        return false;
    }
}
