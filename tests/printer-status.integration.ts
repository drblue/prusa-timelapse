import assert from "node:assert/strict";
import { test } from "node:test";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { formatVideoTimestamp, watchPrinterLifecycle } from "../video-printer-status.ts";

const base = process.env.PRINTER_STATUS_SIMULATION_URL || "http://127.0.0.1:4901/printer";

for (const [scenario, terminal] of [["finished", "FINISHED"], ["warming-up", "FINISHED"], ["late-print", "FINISHED"], ["completed-idle", "IDLE"], ["canceled", "CANCELED"], ["recovery", "FINISHED"], ["error", "ERROR"], ["immediate", "FINISHED"], ["timeout", "FINISHED"]]) {
	test(`printer lifecycle via HTTP: ${scenario}`, { timeout: 8000 }, async () => {
		const controller = new AbortController();
		const states: unknown[] = [], order: string[] = [], errors: unknown[] = [];
		const startReads: number[] = [];
		const timer = setTimeout(() => controller.abort(), 5000);
		const run = randomUUID();
		try {
			const options = {
				readState: async (signal: AbortSignal) => {
					const { data } = await axios.get(`${base}/api/v1/status?case=${scenario}&run=${run}`, {
						headers: { "X-Api-Key": "test-printer-key" }, timeout: 1000, signal,
					});
					return { state: data.printer?.state, printer: data.printer, job: data.job };
				},
				intervalMs: 20,
				doneStates: ["idle", "finished", "stopped", "canceled", "error"],
				waitForPrinting: scenario !== "immediate",
				waitTimeoutMs: scenario === "timeout" ? 1 : 0,
			};
			await watchPrinterLifecycle(options, controller.signal, (start) => {
				if (start) startReads.push(states.length);
				order.push(start ? "start" : "canceled");
			},
				(state) => { order.push(state); controller.abort(); }, (state) => states.push(state), (error) => errors.push(error));
			assert.deepEqual(order, ["start", terminal]);
			assert.equal(states[startReads[0] - 1], "PRINTING");
			assert.equal(startReads.length, 1);
			if (scenario === "warming-up") assert.deepEqual(startReads, [7], "Heating and calibration must not start video even with an ETA");
			if (scenario === "late-print") assert.deepEqual(startReads, [1], "An ongoing print starts immediately at high Z");
			assert.ok(states.includes("PRINTING"));
			if (scenario === "recovery") { assert.equal(errors.length, 1); assert.ok(states.includes(undefined)); }
			else assert.equal(errors.length, 0);
		} finally { clearTimeout(timer); controller.abort(); }
	});
}

test("idle printer can be canceled before recording begins", { timeout: 5000 }, async () => {
	const controller = new AbortController();
	const ready: boolean[] = [];
	await watchPrinterLifecycle({
		readState: async (signal) => (await axios.get(`${base}/api/v1/status?case=idle`, {
			headers: { "X-Api-Key": "test-printer-key" }, timeout: 1000, signal,
		})).data.printer.state,
		intervalMs: 20, doneStates: ["idle", "finished"],
	}, controller.signal, (start) => ready.push(start), () => assert.fail("Initial IDLE must not finish a job"), () => controller.abort());
	assert.deepEqual(ready, [false]);
});

test("reconnect timestamp uses local date and time at the beginning of the line", () => {
	assert.equal(formatVideoTimestamp(new Date(2026, 9, 23, 20, 12, 39)), "2026-10-23 20:12:39");
});
