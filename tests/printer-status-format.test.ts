import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrinterStatus } from "../printer-status-format.ts";
import { watchPrinterLifecycle } from "../video-printer-status.ts";

const now = new Date(2026, 9, 27, 10, 38, 54);

test("printer status includes progress and times with one space after the emoji", () => {
	assert.equal(formatPrinterStatus("PRINTING", { time_printing: 8820, time_remaining: 6120, progress: 55 }, now),
		"🖨️ 2026-10-27 10:38:54 status: PRINTING elapsed 2h 27m, remaining 1h 42m, ETA 12:20 (55.00%)");
	assert.equal(formatPrinterStatus("PRINTING", { time_printing: 0, time_remaining: 0, progress: 0 }, now),
		"🖨️ 2026-10-27 10:38:54 status: PRINTING elapsed 0m 00s, remaining 0m 00s, ETA 10:38 (0.00%)");
});

test("missing and invalid telemetry is omitted", () => {
	assert.equal(formatPrinterStatus("PRINTING", { time_printing: -1, time_remaining: NaN, progress: Infinity }, now),
		"🖨️ 2026-10-27 10:38:54 status: PRINTING");
	assert.equal(formatPrinterStatus("IDLE", { progress: 55 }, now), "🖨️ 2026-10-27 10:38:54 status: IDLE");
	assert.equal(formatPrinterStatus(undefined, undefined, now), "🖨️ 2026-10-27 10:38:54 status: (missing)");
});

test("video monitoring forwards job data while retaining start and stop transitions", async () => {
	const controller = new AbortController();
	const job = { time_printing: 8820, time_remaining: 6120, progress: 55 };
	const snapshots = [{ state: "PRINTING", job }, { state: "FINISHED" }];
	const events: unknown[] = [];
	await watchPrinterLifecycle({
		readState: async () => snapshots.shift(), intervalMs: 1, doneStates: ["finished"],
		waitForPrinting: true, waitTimeoutMs: 0,
	}, controller.signal, (ready) => events.push(ready), (state) => events.push(state), (state, details) => {
		if (state === "PRINTING") assert.deepEqual(details, job);
	});
	assert.deepEqual(events, [true, "FINISHED"]);
});
