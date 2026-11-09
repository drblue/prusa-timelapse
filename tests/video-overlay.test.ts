import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildVideoArgs } from "../record-video.ts";
import { createVideoTelemetryOverlay, videoOverlayTop } from "../video-overlay.ts";

test("video includes telemetry below the timestamp in the encoded pictures", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-video-overlay-"));
	try {
		const special = path.join(root, "path with 'quotes,;[]"); fs.mkdirSync(special);
		const source = path.join(root, "input.mp4"), output = path.join(root, "video.mkv"), text = path.join(special, "status.txt");
		fs.writeFileSync(text, "Progress: 0.0%\nNozzle: 220.0/220.0°C\nBed: 60.0/60.0°C\nElapsed: 0:00  Remaining: 1:00:00\nZ: 0.20mm");
		const fixture = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x353535:s=1280x720:r=25", "-t", "0.2", source], { encoding: "utf8" });
		assert.equal(fixture.status, 0, fixture.stderr);
		const options = { url: source, transport: "tcp", loglevel: "error", telemetryFile: text,
			font: process.platform === "darwin" ? "/System/Library/Fonts/Supplemental/Arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
			fontsize: 24, padding: 10, boxOpacity: 0.5, boxBorder: 6, timestamp: true };
		const timestamp = `drawtext=text='2026-11-08':fontsize=24:fontcolor=white:x=10:y=${videoOverlayTop(options.padding)}`;
		const result = spawnSync("ffmpeg", buildVideoArgs(options, output, timestamp), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
		assert.equal(result.status, 0, result.stderr);
		const pixels = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=700:270:0:0", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]);
		assert.equal(pixels.status, 0, pixels.stderr.toString());
		const hasText = (start: number, end: number) => pixels.stdout.subarray(start * 700, end * 700).some((pixel) => pixel > 180);
		assert.ok(!hasText(0, 58), "The top of the video should have room for the title bar");
		assert.ok(hasText(65, 94), "Timestamp glyphs are missing");
		assert.ok(hasText(100, 126), "Telemetry glyphs are missing just below the timestamp");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("updates telemetry in an already-running encoder and clears failed samples", { timeout: 10000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-video-live-overlay-"));
	try {
		const overlay = createVideoTelemetryOverlay(root);
		assert.equal(fs.readFileSync(overlay.file, "utf8"), "");
		overlay.update({ job: { progress: 0 }, printer: { axis_z: 0 } });
		assert.equal(fs.readFileSync(overlay.file, "utf8"), "Progress: 0.0%\nZ: 0.00mm");
		const source = path.join(root, "input.mp4"), output = path.join(root, "video.mkv");
		const fixture = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=0x353535:s=640x360:r=25", "-t", "2", source], { encoding: "utf8" });
		assert.equal(fixture.status, 0, fixture.stderr);
		const options = { url: source, transport: "tcp", loglevel: "error", telemetryFile: overlay.file, timestamp: false };
		const args = buildVideoArgs(options, output); args.splice(args.indexOf("-i"), 0, "-re");
		const encoder = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe", "pipe"] });
		let changed = false, errors = "";
		encoder.stderr.on("data", (b) => { errors += b; });
		encoder.stdio[3]!.on("data", (b) => {
			if (!changed && [...b.toString().matchAll(/frame=(\d+)/g)].some((m) => Number(m[1]) >= 10)) {
				changed = true; overlay.update({ job: { progress: 88 }, printer: { axis_z: 10 } });
			}
		});
		const deadline = setTimeout(() => encoder.kill("SIGKILL"), 8000);
		try { assert.equal(await new Promise((resolve, reject) => { encoder.once("close", resolve); encoder.once("error", reject); }), 0, errors); }
		finally { clearTimeout(deadline); }
		assert.ok(changed, "Status did not update while FFmpeg was running");
		const whitePixels = (time: string) => {
			const decoded = spawnSync("ffmpeg", ["-v", "error", "-ss", time, "-i", output, "-vf", "crop=350:40:0:36", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]);
			assert.equal(decoded.status, 0, decoded.stderr.toString());
			return decoded.stdout.filter((v) => v > 180).length;
		};
		assert.ok(whitePixels("1.7") > whitePixels("0.1") + 30, "The updated progress did not appear in encoded frames");
		overlay.clear(); assert.equal(fs.readFileSync(overlay.file, "utf8"), "");
		assert.ok(!fs.existsSync(`${overlay.file}.tmp`));
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
