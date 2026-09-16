/**
 * Throws when a fetch response isn't ok, unless its status is explicitly allowed (e.g. 410
 * "already gone" treated as success for a delete). Connectors used to log-and-swallow this
 * (console.warn + return) instead — dispatchAction's own try/catch never saw the failure, so
 * a broken action silently reported success to the caller. Throwing lets that existing catch
 * do its job.
 */
export async function assertHttpOk(
    resp: Response,
    label: string,
    allow: number[] = [],
): Promise<void> {
    if (resp.ok || allow.includes(resp.status)) return;
    throw new Error(`${label} returned ${resp.status}`);
}
