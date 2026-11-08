import assert from "node:assert/strict";
import { test } from "node:test";
import { recordVideo } from "../record-video.ts";
import { watchPrinterLifecycle } from "../video-printer-status.ts";

test("video refuses to start without printer status before opening the terminal or camera", async () => {
	await assert.rejects(recordVideo({ url: "rtsp://camera.invalid/live", transport: "tcp", loglevel: "warning" }, "/unused"),
		/printer status endpoint/i);
});

const printing = (printer = {}, job = {}) => ({
	state: "PRINTING",
	printer: { axis_z: 0.2, temp_nozzle: 220, target_nozzle: 220, temp_bed: 50, target_bed: 50, ...printer },
	job: { progress: 0, time_remaining: 14460, ...job },
});

const transitions = async (samples: unknown[]) => {
	const events: unknown[] = [];
	await watchPrinterLifecycle({
		readState: async () => samples.shift(), intervalMs: 1, doneStates: ["finished", "canceled"],
	}, new AbortController().signal, (ready) => events.push(ready), (state) => events.push(state));
	return events;
};

test("PRINTING and time_remaining during heating/calibration do not start video", async () => {
	// Values observed in the Core One status logs; remaining time appears during preparation.
	assert.deepEqual(await transitions([
		printing({ axis_z: 234.5, temp_nozzle: 122.4, target_nozzle: 120, temp_bed: 39.2 }),
		printing({ axis_z: 40, temp_nozzle: 215.6, target_nozzle: 215 }),
		printing({ axis_z: -0.5, temp_nozzle: 170, target_nozzle: 170 }),
		{ state: "FINISHED" },
	]), ["FINISHED", false]);
});

test("cancellation during preparation exits without starting capture", async () => {
	assert.deepEqual(await transitions([printing({ axis_z: 40 }), { state: "CANCELED" }]), ["CANCELED", false]);
});

test("starts at the first eligible zero-progress sample and remains active above first-layer Z", async () => {
	assert.deepEqual(await transitions([
		printing({ axis_z: 40 }), printing(), printing({ axis_z: 10 }), { state: "FINISHED" },
	]), [true, "FINISHED"]);
});

test("starts when launched during an ongoing print above first-layer height", async () => {
	assert.deepEqual(await transitions([
		{ state: "PRINTING", job: { progress: 55, time_remaining: 6120 } },
		printing({ axis_z: 50 }, { progress: 56 }), { state: "FINISHED" },
	]), [true, "FINISHED"]);
});

test("positive progress still requires remaining time and PRINTING", async () => {
	let reads = 0;
	const starts: number[] = [];
	const samples = [
		{ state: "PRINTING", job: { progress: 55 } },
		{ state: "PRINTING", job: { progress: 55, time_remaining: -1 } },
		{ state: "PAUSED", job: { progress: 55, time_remaining: 6120 } },
		{ state: "PRINTING", job: { progress: 55, time_remaining: 6120 } },
		{ state: "FINISHED" },
	];
	await watchPrinterLifecycle({
		readState: async () => { reads++; return samples.shift(); }, intervalMs: 1, doneStates: ["finished"],
	}, new AbortController().signal, (ready) => { if (ready) starts.push(reads); }, () => {});
	assert.deepEqual(starts, [4]);
});

for (const [name, sample] of [
	["missing remaining time", printing({}, { time_remaining: undefined })],
	["invalid remaining time", printing({}, { time_remaining: NaN })],
	["cold nozzle", printing({ temp_nozzle: 190 })],
	["calibration nozzle target", printing({ temp_nozzle: 170, target_nozzle: 170 })],
	["cooling nozzle", printing({ temp_nozzle: 230, target_nozzle: 220 })],
	["cold bed", printing({ temp_bed: 40 })],
	["zero Z", printing({ axis_z: 0 })],
	["invalid Z", printing({ axis_z: Infinity })],
	["missing printer telemetry", { state: "PRINTING", job: { time_remaining: 100 } }],
	["paused at first-layer height", { ...printing(), state: "PAUSED" }],
] as const) {
	test(`waits during ${name}, then starts when the first-layer estimate is satisfied`, async () => {
		const states = [sample, printing({}, { time_remaining: 0 }), { state: "FINISHED" }];
		let reads = 0;
		const starts: number[] = [];
		await watchPrinterLifecycle({
			readState: async () => { reads++; return states.shift(); }, intervalMs: 1, doneStates: ["finished"],
		}, new AbortController().signal, (ready) => { if (ready) starts.push(reads); }, () => {});
		assert.deepEqual(starts, [2]);
	});
}
