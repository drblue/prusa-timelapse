import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendVideoStatus, writeVideoTimeline } from "../video-telemetry.ts";

test("preserves full status responses, Z=0 and request timing across samples", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-telemetry-"));
	try {
		const began = new Date("2026-10-27T10:00:00Z");
		const data = { printer: { axis_z: 0, state: "PRINTING" }, job: { progress: 0 } };
		appendVideoStatus(dir, data, began, new Date(began.getTime() + 100));
		appendVideoStatus(dir, { printer: { axis_z: 0.2 } }, new Date(began.getTime() + 30000), new Date(began.getTime() + 30100));
		const samples = fs.readFileSync(path.join(dir, "recording-status.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(samples.length, 2);
		assert.deepEqual(samples[0].data, data);
		assert.equal(samples[0].requestStartedAt, began.toISOString());
		assert.equal(samples[0].fetchedAt, "2026-10-27T10:00:00.100Z");
		assert.equal(samples[1].data.printer.axis_z, 0.2);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("timeline maps receiver time to video offsets including reconnect and trailing holds", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-timeline-meta-"));
	try {
		const origin = Date.parse("2026-10-27T10:00:00Z");
		writeVideoTimeline(dir, [
			{ file: "part_1.mkv", packets: 25, duration: 1, capturedAt: origin },
			{ file: "part_2.mkv", packets: 25, duration: 1, capturedAt: origin + 4000 },
		], origin + 8000);
		const data = JSON.parse(fs.readFileSync(path.join(dir, "recording-timeline.json"), "utf8"));
		assert.equal(data.timelineStartedAt, "2026-10-27T10:00:00.000Z");
		assert.equal(data.mapping, "receiver-wall-clock");
		assert.deepEqual(data.segments.map((part: { videoStartSeconds: number }) => part.videoStartSeconds), [0, 4]);
		assert.deepEqual(data.segments.map((part: { durationSeconds: number }) => part.durationSeconds), [4, 4]);
		assert.equal(data.segments[0].capturedDurationSeconds, 1);
		writeVideoTimeline(dir, [{ file: "local.mkv", packets: 25, duration: 1 }], origin + 8000);
		const local = JSON.parse(fs.readFileSync(path.join(dir, "recording-timeline.json"), "utf8"));
		assert.equal(local.mapping, "unavailable");
		assert.equal(local.timelineStartedAt, null);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
