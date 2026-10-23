import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { H264TcpRepair } from "../rtsp-repair.ts";
import { buildVideoArgs } from "../record-video.ts";

const packet = (seq: number, timestamp: number, payload: Buffer, marker = true) => {
	const b = Buffer.alloc(16 + payload.length);
	b[0] = 36; b.writeUInt16BE(12 + payload.length, 2);
	b[4] = 128; b[5] = 96 | (marker ? 128 : 0); b.writeUInt16BE(seq & 65535, 6);
	b.writeUInt32BE(timestamp >>> 0, 8); b.writeUInt32BE(0x12345678, 12); payload.copy(b, 16);
	return b;
};

test("repair preserves RTSP bodies and packets across arbitrary socket boundaries", () => {
	const response = Buffer.from("RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 4\r\n\r\n$abc");
	const packets = [packet(65535, 100, Buffer.from([0x65, 1])), packet(0, 3700, Buffer.from([0x41, 2]))];
	const output: Buffer[] = [], repair = new H264TcpRepair((b) => output.push(b));
	const wire = Buffer.concat([response, ...packets]);
	for (const byte of wire) repair.push(Buffer.from([byte]));
	repair.finish();
	assert.deepEqual(Buffer.concat(output), wire);
	assert.equal(repair.stats.forwardedFrames, 2);
});

test("drops a cut frame and dependent pictures until a complete IDR, retaining timestamps", () => {
	const output: Buffer[] = [], events: string[] = [];
	const repair = new H264TcpRepair((b) => output.push(b), (message) => events.push(message));
	const first = packet(1, 100, Buffer.from([0x65, 1]));
	const cut = packet(2, 3700, Buffer.from([0x5c, 0x81, ...Array(50).fill(7)]), false);
	const tail = packet(3, 3700, Buffer.from([0x5c, 0x41, 8]));
	const dependent = packet(4, 7300, Buffer.from([0x41, 9]));
	const idr = packet(5, 10900, Buffer.from([0x65, 10]));
	const final = packet(6, 14500, Buffer.from([0x41, 11]));
	const wire = Buffer.concat([first, cut.subarray(0, 24), tail, dependent, idr, final]);
	for (let p = 0; p < wire.length; p += 7) repair.push(wire.subarray(p, p + 7));
	repair.finish();
	assert.deepEqual(output, [first, idr, final]);
	assert.equal(repair.stats.truncated, 1);
	assert.equal(output[1].readUInt32BE(8), 10900);
	assert.match(events.join("\n"), /Truncated RTP packet 2/);
});

test("restores separately marked SPS/PPS before the first whole IDR", () => {
	const packets = [packet(1, 0, Buffer.from([0x67, 1])), packet(2, 0, Buffer.from([0x68, 2])),
		packet(3, 0, Buffer.from([0x41, 3])), packet(4, 3600, Buffer.from([0x65, 4]))];
	const output: Buffer[] = [], repair = new H264TcpRepair((b) => output.push(b));
	repair.push(Buffer.concat(packets)); repair.finish();
	assert.equal(output.length, 3);
	assert.deepEqual(output.map((b) => b.readUInt16BE(6)), [2, 3, 4]);
	assert.deepEqual(output.map((b) => b.readUInt32BE(8)), [3600, 3600, 3600]);
	assert.deepEqual(output.map((b) => b.subarray(16)), [packets[0].subarray(16), packets[1].subarray(16), packets[3].subarray(16)]);
});

test("does not accept an RTP-looking payload with a different SSRC as a packet boundary", () => {
	const fake = packet(2, 0, Buffer.from([0x41, 3])); fake.writeUInt32BE(0x87654321, 12);
	const first = packet(1, 0, Buffer.concat([Buffer.from([0x65]), fake]));
	const second = packet(2, 3600, Buffer.from([0x41, 3]));
	const output: Buffer[] = [], repair = new H264TcpRepair((b) => output.push(b));
	repair.push(Buffer.concat([first, second])); repair.finish();
	assert.deepEqual(output, [first, second]); assert.equal(repair.stats.truncated, 0);
});

test("recovered real H.264 decodes strictly without concealed pictures", { timeout: 15000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-rtp-repair-"));
	const run = (args: string[]) => {
		const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, "");
	};
	try {
		const original = path.join(root, "original.h264"), recovered = path.join(root, "recovered.h264");
		run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "3", "-c:v", "libx264",
			"-g", "25", "-bf", "0", "-bsf:v", "h264_metadata=aud=insert", original]);
		const data = fs.readFileSync(original), nals: Buffer[] = [];
		let start = -1;
		for (let p = 0; p < data.length - 3; p++) {
			const size = data[p] === 0 && data[p + 1] === 0 ? data[p + 2] === 1 ? 3 : data[p + 2] === 0 && data[p + 3] === 1 ? 4 : 0 : 0;
			if (size) { if (start >= 0) nals.push(data.subarray(start, p)); start = p + size; p += size - 1; }
		}
		nals.push(data.subarray(start));
		const frames: Buffer[][] = [];
		for (const nal of nals) { if ((nal[0] & 31) === 9) frames.push([]); frames.at(-1)!.push(nal); }
		const wire: Buffer[] = []; let seq = 65490;
		for (const [index, frame] of frames.entries()) {
			const payloads: Buffer[] = [];
			for (const nal of frame) {
				if (nal.length <= 400) payloads.push(nal);
				else for (let p = 1; p < nal.length; p += 398) payloads.push(Buffer.concat([
					Buffer.from([(nal[0] & 224) | 28, (nal[0] & 31) | (p === 1 ? 128 : 0) | (p + 398 >= nal.length ? 64 : 0)]), nal.subarray(p, p + 398)]));
			}
			for (const [p, payload] of payloads.entries()) {
				const b = packet(seq++, index * 3600, payload, p === payloads.length - 1);
				wire.push(index === 35 && p === 1 ? b.subarray(0, 25) : b);
			}
		}
		const output: Buffer[] = []; let fragments: Buffer[] = [];
		const nal = (b: Buffer) => output.push(Buffer.from([0, 0, 0, 1]), b);
		const repair = new H264TcpRepair((packet) => {
			const payload = packet.subarray(16), type = payload[0] & 31;
			if (type !== 28) nal(payload);
			else {
				if (payload[1] & 128) fragments = [Buffer.from([(payload[0] & 224) | (payload[1] & 31)])];
				fragments.push(payload.subarray(2));
				if (payload[1] & 64) { nal(Buffer.concat(fragments)); fragments = []; }
			}
		});
		const bytes = Buffer.concat(wire);
		for (let p = 0; p < bytes.length; p += 997) repair.push(bytes.subarray(p, p + 997));
		repair.finish(); fs.writeFileSync(recovered, Buffer.concat(output));
		assert.equal(repair.stats.truncated, 1); assert.equal(repair.stats.forwardedFrames, 60);
		run(["-xerror", "-err_detect", "explode", "-threads", "1", "-i", recovered, "-f", "null", "-"]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repair mode retains a twelve-second gap within a single MPEG-TS connection", { timeout: 15000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prusa-repair-gap-"));
	try {
		const source = path.join(root, "gap.ts"), output = path.join(root, "gap.mkv");
		const fixture = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
			"-frames:v", "50", "-vf", "setpts='PTS+if(gte(N,25),12/TB,0)'", "-fps_mode", "passthrough", "-c:v", "libx264", "-g", "25", "-bf", "0", source], { encoding: "utf8" });
		assert.equal(fixture.status, 0, fixture.stderr);
		const decode = spawnSync("ffmpeg", buildVideoArgs({ url: source, transport: "tcp", loglevel: "warning", repairRtsp: true }, output),
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
		assert.equal(decode.status, 0, decode.stderr);
		const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames:format=duration",
			"-of", "json", output], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		const result = JSON.parse(probe.stdout);
		assert.equal(Number(result.streams[0].nb_read_frames), 50);
		assert.ok(Math.abs(Number(result.format.duration) - 14) < 0.02, probe.stdout);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
