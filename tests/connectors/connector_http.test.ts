import { describe, it, expect } from "vitest";
import { assertHttpOk } from "../../source/connectors/connector_http.js";

function makeResponse(ok: boolean, status: number): Response {
    return { ok, status } as Response;
}

describe("assertHttpOk", () => {
    it("resolves without throwing when the response is ok", async () => {
        await expect(assertHttpOk(makeResponse(true, 200), "[Test] op")).resolves.toBeUndefined();
    });

    it("throws with the label and status when the response isn't ok", async () => {
        await expect(assertHttpOk(makeResponse(false, 401), "[Test] op")).rejects.toThrow(
            "[Test] op returned 401",
        );
    });

    it("does not throw when the status is in the allow list", async () => {
        await expect(
            assertHttpOk(makeResponse(false, 410), "[Test] op", [410]),
        ).resolves.toBeUndefined();
    });

    it("still throws for a not-ok status absent from the allow list", async () => {
        await expect(assertHttpOk(makeResponse(false, 500), "[Test] op", [410])).rejects.toThrow(
            "[Test] op returned 500",
        );
    });
});
