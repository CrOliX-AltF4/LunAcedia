import { describe, it, expect, vi, afterEach } from "vitest";
import { ActionCooldownTracker } from "../../source/actions/action_cooldown.js";

describe("ActionCooldownTracker", () => {
    afterEach(() => {
        vi.useRealTimers();
        delete process.env["ACTION_COOLDOWN_WINDOW_MIN"];
        delete process.env["ACTION_COOLDOWN_MAX"];
    });

    it("allows executions up to maxPerWindow", () => {
        const tracker = new ActionCooldownTracker(5 * 60_000, 3);
        expect(tracker.tryConsume("mark_email_read")).toBe(true);
        expect(tracker.tryConsume("mark_email_read")).toBe(true);
        expect(tracker.tryConsume("mark_email_read")).toBe(true);
    });

    it("refuses the (maxPerWindow + 1)th execution within the window", () => {
        const tracker = new ActionCooldownTracker(5 * 60_000, 3);
        tracker.tryConsume("mark_email_read");
        tracker.tryConsume("mark_email_read");
        tracker.tryConsume("mark_email_read");
        expect(tracker.tryConsume("mark_email_read")).toBe(false);
    });

    it("tracks each kind independently — hitting one kind's cooldown doesn't affect another", () => {
        const tracker = new ActionCooldownTracker(5 * 60_000, 1);
        expect(tracker.tryConsume("delete_email")).toBe(true);
        expect(tracker.tryConsume("delete_email")).toBe(false);
        expect(tracker.tryConsume("delete_task")).toBe(true);
    });

    it("allows again once the window has elapsed", () => {
        vi.useFakeTimers();
        const tracker = new ActionCooldownTracker(60_000, 1);
        expect(tracker.tryConsume("merge_pr")).toBe(true);
        expect(tracker.tryConsume("merge_pr")).toBe(false);

        vi.advanceTimersByTime(61_000);

        expect(tracker.tryConsume("merge_pr")).toBe(true);
    });

    it("a refused attempt doesn't consume a slot", () => {
        const tracker = new ActionCooldownTracker(5 * 60_000, 1);
        tracker.tryConsume("close_issue"); // consumes the only slot
        tracker.tryConsume("close_issue"); // refused
        tracker.tryConsume("close_issue"); // still refused — didn't reset anything
        expect(tracker.tryConsume("close_issue")).toBe(false);
    });

    it("respects ACTION_COOLDOWN_WINDOW_MIN/ACTION_COOLDOWN_MAX when no explicit args are passed", () => {
        process.env["ACTION_COOLDOWN_MAX"] = "2";
        const tracker = new ActionCooldownTracker();
        expect(tracker.tryConsume("add_label")).toBe(true);
        expect(tracker.tryConsume("add_label")).toBe(true);
        expect(tracker.tryConsume("add_label")).toBe(false);
    });
});
