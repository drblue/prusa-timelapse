import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildSnapshotTelemetryFilters, formatSnapshotTelemetry, needsTelemetryOverlay } from "../snapshot-telemetry.ts";

const opts = {
	font: process.platform === "darwin" ? "/System/Library/Fonts/Supplemental/Arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	fontsize: 24, padding: 10, boxOpacity: 0.5, boxBorder: 6, timestamp: true,
};

test("snapshot text preserves zero values and skips missing or invalid fields", () => {
	assert.equal(formatSnapshotTelemetry({ job: { progress: 0, time_printing: 0, time_remaining: 3600 },
		printer: { axis_z: 0, temp_nozzle: 20, target_nozzle: 0, temp_bed: 19.5 } }),
		"Progress: 0.0%\nNozzle: 20.0/0.0°C\nBed: 19.5/?°C\nElapsed: 0:00  Remaining: 1:00:00\nZ: 0.00mm");
	assert.equal(formatSnapshotTelemetry({ job: { progress: NaN }, printer: { axis_z: Infinity } }), "");
	assert.deepEqual(buildSnapshotTelemetryFilters(null, opts), []);
	assert.equal(needsTelemetryOverlay({}), true);
	assert.equal(needsTelemetryOverlay({ telemetryOverlay: false }), true);
	assert.equal(needsTelemetryOverlay({ telemetryOverlay: true }), false);
});

test("FFmpeg renders percent, temperatures, times and Z in a single snapshot encode", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-snapshot-overlay-"));
	try {
		const status = JSON.parse(fs.readFileSync(new URL("../api-responses/status-response when printing.json", import.meta.url), "utf8"));
		const filters = buildSnapshotTelemetryFilters(status, opts);
		assert.equal(filters.length, 5);
		assert.ok(filters[0].includes("expansion=none"));
		const timestamp = `drawtext=text='2026-10-27 19\\:30\\:00':fontsize=24:fontcolor=white:x=10:y=10`;
		const file = path.join(dir, "frame.jpg");
		const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			"color=c=0x353535:s=1280x720", "-vf", [timestamp, ...filters].join(","), "-frames:v", "1", "-q:v", "2", file], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.ok(fs.statSync(file).size > 0);
		const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "crop=600:200:0:0", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
		assert.equal(raw.status, 0, raw.stderr.toString());
		// Bright glyphs in every telemetry row prove text was drawn into the JPEG.
		for (let row = 0; row < 5; row++) {
			const top = 50 + row * 28;
			assert.ok(raw.stdout.subarray(top * 600, (top + 24) * 600).some((pixel) => pixel > 180));
		}
		fs.renameSync(file, path.join(dir, "frame_000001.jpg"));
		fs.writeFileSync(path.join(dir, "frame_000001_status.json"), JSON.stringify(status));
		fs.writeFileSync(path.join(dir, "_timelapse_meta.json"), JSON.stringify({ telemetryOverlay: true }));
		const make = spawnSync(process.execPath, ["make-timelapse.mjs", "--folder", dir, "--out", path.join(dir, "result.mp4")], { encoding: "utf8" });
		assert.equal(make.status, 0, make.stderr);
		assert.ok(!make.stdout.includes("Overlaying telemetry"), make.stdout);
		assert.ok(fs.existsSync(path.join(dir, "result.mp4")));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
