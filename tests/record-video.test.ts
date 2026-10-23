import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildVideoArgs, buildVideoSourceArgs, captureVideo, joinParts } from "../record-video.ts";

const ffmpeg = (args: string[]) => {
	const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
};

const countFrames = (file: string) => {
	const result = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return Number(result.stdout.trim());
};

test("keeps reconnect and trailing outage time without dropping or re-encoding pictures", { timeout: 15000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-timeline-test-"));
	try {
		for (const name of ["one.mkv", "two.mkv"]) {
			ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "1", "-c:v", "libx264",
				"-preset", "veryfast", "-g", "25", "-bf", "0", path.join(root, name)]);
		}
		const output = path.join(root, "recording.mp4");
		await joinParts(root, [{ file: "one.mkv", packets: 25, capturedAt: 100000 },
			{ file: "two.mkv", packets: 25, capturedAt: 104000 }], output, 108000);
		assert.equal(countFrames(output), 50);
		const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:packet=pts_time,duration_time",
			"-of", "json", output], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const data = JSON.parse(result.stdout);
		assert.ok(Math.abs(Number(data.format.duration) - 8) < 0.01, result.stdout);
		assert.equal(Number(data.packets[25].pts_time), 4);
		assert.ok(Number(data.packets.at(-1).duration_time) > 3);
		ffmpeg(["-xerror", "-err_detect", "explode", "-i", output, "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "null", "-"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("starts strict decoding at a complete keyframe when joining mid-GOP", { timeout: 15000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-keyframe-test-"));
	try {
		const clean = path.join(root, "clean.ts");
		const partial = path.join(root, "partial.ts");
		const output = path.join(root, "recording.mkv");
		ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "3", "-c:v", "libx264",
			"-preset", "veryfast", "-g", "25", "-bf", "0", clean]);
		ffmpeg(["-ss", "0.4", "-i", clean, "-c:v", "copy", "-copyinkf", partial]);
		const packets = spawnSync("ffprobe", ["-v", "quiet", "-select_streams", "v:0", "-show_entries",
			"packet=flags", "-of", "csv=p=0", partial], { encoding: "utf8" });
		assert.equal(packets.status, 0);
		assert.ok(!packets.stdout.split("\n")[0].includes("K"), "The fixture must start before a keyframe");
		const opts = { url: partial, transport: "tcp", loglevel: "warning" };
		const source = spawn("ffmpeg", buildVideoSourceArgs(opts), { stdio: ["ignore", "pipe", "ignore"] });
		const decoder = spawn("ffmpeg", buildVideoArgs({ ...opts, url: "pipe:0" }, output),
			{ stdio: ["pipe", "ignore", "pipe", "pipe"] });
		decoder.stdio[3]!.on("data", () => {});
		source.stdout.pipe(decoder.stdin);
		decoder.stdin.on("error", () => {});
		let diagnostics = "";
		decoder.stderr.on("data", (chunk) => { diagnostics += chunk; });
		const finished = (child: typeof source | typeof decoder) => new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const timer = setTimeout(() => { source.kill("SIGKILL"); decoder.kill("SIGKILL"); }, 10000);
		try {
			const codes = await Promise.all([finished(source), finished(decoder)]);
			assert.deepEqual(codes, [0, 0], diagnostics);
			assert.doesNotMatch(diagnostics, /error while decoding|corrupt decoded frame|Error submitting packet/i);
			assert.equal(countFrames(output), 50);
		} finally {
			clearTimeout(timer);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("reconnects after a damaged frame and joins only the usable prefixes", { timeout: 15000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-recovery-test-"));
	const controller = new AbortController();
	const clean = path.join(root, "clean.ts");
	const damaged = path.join(root, "damaged.ts");
	const runDir = path.join(root, "run with ' quotes");
	fs.mkdirSync(runDir);
	ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "3", "-c:v", "libx264",
		"-preset", "veryfast", "-g", "25", "-bf", "0", clean]);
	// Damage packet 35, leaving a known-good prefix in each attempt.
	ffmpeg(["-i", clean, "-c:v", "copy", "-bsf:v", "noise=amount='if(eq(n,35),-1,0)'", damaged]);
	const timer = setInterval(() => {
		const log = path.join(runDir, "recording.log");
		if (fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("Connecting (attempt 3)")) controller.abort();
	}, 20);
	const deadline = setTimeout(() => controller.abort(), 10000);
	try {
		await captureVideo({ url: damaged, transport: "tcp", loglevel: "fatal" }, runDir,
			"hflip", controller.signal);
		const output = path.join(runDir, "recording.mp4");
		const frames = countFrames(output);
		// Two prefixes must survive; none of the frames after the damaged packet may be encoded.
		assert.ok(frames > 35 && frames <= 105, `Unexpected frame count: ${frames}`);
		const log = fs.readFileSync(path.join(runDir, "recording.log"), "utf8");
		assert.match(log, /decoding failed \(exit (?!0\))/);
		assert.match(log, /attempt 3/);
		assert.ok(!log.includes(damaged), "The source URL/path must be redacted");
		assert.ok(!fs.existsSync(path.join(runDir, "recording-parts")));
		ffmpeg(["-xerror", "-err_detect", "explode", "-i", output, "-f", "null", "-"]);
	} finally {
		clearInterval(timer);
		clearTimeout(deadline);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("stopping during reconnection reports no frames without creating an empty MP4", { timeout: 8000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-stop-test-"));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 300);
	try {
		await assert.rejects(captureVideo({ url: path.join(root, "missing.mp4"), transport: "tcp", loglevel: "fatal" },
			root, null, controller.signal), /No complete video frames/);
		assert.ok(!fs.existsSync(path.join(root, "recording.mp4")));
	} finally {
		clearTimeout(timer);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
