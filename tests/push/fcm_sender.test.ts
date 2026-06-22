import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// ── Firebase mocks (hoisted) ──────────────────────────────────────────────────

const h = vi.hoisted(() => ({
    mockSend: vi.fn().mockResolvedValue("msg-id"),
    mockGetApps: vi.fn().mockReturnValue([]),
    mockInit: vi.fn(),
    mockCert: vi.fn().mockReturnValue({}),
    mockReadFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("firebase-admin/app", () => ({
    initializeApp: h.mockInit,
    cert: h.mockCert,
    getApps: h.mockGetApps,
}));

vi.mock("firebase-admin/messaging", () => ({
    getMessaging: () => ({ send: h.mockSend }),
}));

vi.mock("node:fs/promises", () => ({
    default: {
        readFile: h.mockReadFile,
        writeFile: h.mockWriteFile,
        unlink: h.mockUnlink,
        mkdir: h.mockMkdir,
    },
    readFile: h.mockReadFile,
    writeFile: h.mockWriteFile,
    unlink: h.mockUnlink,
    mkdir: h.mockMkdir,
}));

import { FcmSender } from "../../source/push/fcm_sender.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SA_KEY = Buffer.from(JSON.stringify({ type: "service_account" })).toString("base64");

function makeEvent(overrides: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: "New mail",
        body: "From Alice",
        priority: "urgent",
        dedupeKey: "email-1",
        ...overrides,
    };
}

// ── FcmSender.fromEnv ─────────────────────────────────────────────────────────

describe("FcmSender.fromEnv", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockGetApps.mockReturnValue([]);
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockUnlink.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
        delete process.env["FIREBASE_PROJECT_ID"];
        delete process.env["FIREBASE_SERVICE_ACCOUNT_KEY"];
        delete process.env["ACEDIA_FCM_FILTER"];
    });

    it("should return null when FIREBASE_PROJECT_ID is absent", () => {
        expect(FcmSender.fromEnv()).toBeNull();
    });

    it("should return null when FIREBASE_SERVICE_ACCOUNT_KEY is absent", () => {
        process.env["FIREBASE_PROJECT_ID"] = "proj";
        expect(FcmSender.fromEnv()).toBeNull();
    });

    it("should return a FcmSender when both env vars are present", () => {
        process.env["FIREBASE_PROJECT_ID"] = "proj";
        process.env["FIREBASE_SERVICE_ACCOUNT_KEY"] = SA_KEY;
        expect(FcmSender.fromEnv()).not.toBeNull();
    });

    it("should return null when FIREBASE_SERVICE_ACCOUNT_KEY is invalid base64 JSON", () => {
        process.env["FIREBASE_PROJECT_ID"] = "proj";
        process.env["FIREBASE_SERVICE_ACCOUNT_KEY"] = "not-valid!!!";
        expect(FcmSender.fromEnv()).toBeNull();
    });

    it("should not re-initialize Firebase when app already exists", () => {
        h.mockGetApps.mockReturnValue([{}]);
        process.env["FIREBASE_PROJECT_ID"] = "proj";
        process.env["FIREBASE_SERVICE_ACCOUNT_KEY"] = SA_KEY;
        FcmSender.fromEnv();
        expect(h.mockInit).not.toHaveBeenCalled();
    });
});

// ── FcmSender.send ────────────────────────────────────────────────────────────

describe("FcmSender.send", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockGetApps.mockReturnValue([]);
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockUnlink.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
        process.env["FIREBASE_PROJECT_ID"] = "proj";
        process.env["FIREBASE_SERVICE_ACCOUNT_KEY"] = SA_KEY;
    });

    it("should not send when no device token is set", async () => {
        const sender = FcmSender.fromEnv()!;
        await sender.send(makeEvent());
        expect(h.mockSend).not.toHaveBeenCalled();
    });

    it("should send for urgent events when token is set", async () => {
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("device-token");
        await sender.send(makeEvent({ priority: "urgent" }));
        expect(h.mockSend).toHaveBeenCalledOnce();
    });

    it("should not send for normal events (default filter is urgent only)", async () => {
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("device-token");
        await sender.send(makeEvent({ priority: "normal" }));
        expect(h.mockSend).not.toHaveBeenCalled();
    });

    it("should send for normal events when filter includes normal", async () => {
        process.env["ACEDIA_FCM_FILTER"] = "urgent,normal";
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("device-token");
        await sender.send(makeEvent({ priority: "normal" }));
        delete process.env["ACEDIA_FCM_FILTER"];
        expect(h.mockSend).toHaveBeenCalledOnce();
    });

    it("should build correct FCM payload", async () => {
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("token-xyz");
        await sender.send(
            makeEvent({ title: "Mail", body: "From Bob", source: "email", dedupeKey: "email-99" }),
        );
        const payload = h.mockSend.mock.calls[0]![0];
        expect(payload.token).toBe("token-xyz");
        expect(payload.notification.title).toContain("email");
        expect(payload.notification.body).toBe("From Bob");
        expect(payload.data.dedupeKey).toBe("email-99");
        expect(payload.android.priority).toBe("high");
    });

    it("should use title as body when event.body is absent", async () => {
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("tok");
        const event: AcediaEvent = {
            type: "tasks.due",
            ts: Date.now(),
            source: "tasks",
            title: "Do laundry",
            priority: "urgent",
            dedupeKey: "task-1",
        };
        await sender.send(event);
        const payload = h.mockSend.mock.calls[0]![0];
        expect(payload.notification.body).toBe("Do laundry");
    });

    it("should not throw when FCM send fails", async () => {
        h.mockSend.mockRejectedValueOnce(new Error("FCM down"));
        const sender = FcmSender.fromEnv()!;
        await sender.setToken("tok");
        await expect(sender.send(makeEvent())).resolves.toBeUndefined();
    });
});

// ── FcmSender token management ────────────────────────────────────────────────

describe("FcmSender token management", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockUnlink.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("should return null by default", () => {
        const sender = new FcmSender();
        expect(sender.getToken()).toBeNull();
    });

    it("should store and return token", async () => {
        const sender = new FcmSender();
        await sender.setToken("my-token");
        expect(sender.getToken()).toBe("my-token");
    });

    it("should persist token to disk on setToken", async () => {
        const sender = new FcmSender();
        await sender.setToken("persist-me");
        expect(h.mockWriteFile).toHaveBeenCalledWith(expect.any(String), "persist-me", "utf-8");
    });

    it("should clear token on setToken(null)", async () => {
        const sender = new FcmSender();
        await sender.setToken("tok");
        await sender.setToken(null);
        expect(sender.getToken()).toBeNull();
    });

    it("should delete disk file on setToken(null)", async () => {
        const sender = new FcmSender();
        await sender.setToken("tok");
        await sender.setToken(null);
        expect(h.mockUnlink).toHaveBeenCalled();
    });
});

// ── FcmSender.load ────────────────────────────────────────────────────────────

describe("FcmSender.load", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockUnlink.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("should restore token from disk when file exists", async () => {
        h.mockReadFile.mockResolvedValueOnce("restored-token\n");
        const sender = new FcmSender();
        await sender.load();
        expect(sender.getToken()).toBe("restored-token");
    });

    it("should leave token null when file does not exist", async () => {
        const sender = new FcmSender();
        await sender.load();
        expect(sender.getToken()).toBeNull();
    });

    it("should not throw when file read fails", async () => {
        h.mockReadFile.mockRejectedValueOnce(new Error("permission denied"));
        const sender = new FcmSender();
        await expect(sender.load()).resolves.toBeUndefined();
    });
});
