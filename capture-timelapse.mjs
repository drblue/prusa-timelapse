#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const pad = (n, len = 2) => String(n).padStart(len, "0");
const padIndex = (n, len = 6) => String(n).padStart(len, "0");

const getDefaultFontPath = () => {
	if (process.platform === "darwin") return "/System/Library/Fonts/Supplemental/Arial.ttf";
	if (process.platform === "win32") return "C:/Windows/Fonts/arial.ttf";
	return "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
};

const formatRunStamp = (d = new Date()) => {
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`; // YYYYMMDD-HHMMSS
};

const formatLocalTimestamp = (d = new Date()) => {
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

// drawtext escaping:
// - ":" -> "\:" because ":" is an option separator in drawtext args
// - "\" -> "\\"
// - "'" -> "\'"
const escapeForDrawText = (s) =>
	s
		.replaceAll("\\", "\\\\")
		.replaceAll(":", "\\:")
		.replaceAll("'", "\\'");

const parseArgs = () => {
	const args = process.argv.slice(2);
	const out = {
		url: "rtsp://192.168.1.186/live",
		baseDir: path.resolve(process.cwd(), "snapshots"),
		interval: 5,
		prefix: "frame_",
		ext: "jpg",
		transport: "tcp", // tcp|udp
		quality: 2, // 2-31 (lower = better) for JPEG

		timestamp: true,
		font: getDefaultFontPath(),
		fontsize: 24,
		padding: 10,
		boxOpacity: 0.5,
		boxBorder: 6,

		ignoreDecodeErrors: true,
		loglevel: "fatal",

		statusUrl: null,
		statusInterval: 30,
		statusHeader: null,
		statusPath: "printer.state",
		statusDone: "idle,finished,stopped,canceled,error",
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const v = args[i + 1];

		if (a === "--url") out.url = v, i++;
		else if (a === "--dir") out.baseDir = path.resolve(v), i++;
		else if (a === "--interval") out.interval = Number(v), i++;
		else if (a === "--prefix") out.prefix = v, i++;
		else if (a === "--ext") out.ext = v, i++;
		else if (a === "--transport") out.transport = v, i++;
		else if (a === "--quality") out.quality = Number(v), i++;

		else if (a === "--timestamp") out.timestamp = v !== "false", i++;
		else if (a === "--font") out.font = v, i++;
		else if (a === "--fontsize") out.fontsize = Number(v), i++;

		else if (a === "--ignoreDecodeErrors") out.ignoreDecodeErrors = v !== "false", i++;
		else if (a === "--loglevel") out.loglevel = v, i++;

		else if (a === "--status-url") out.statusUrl = v, i++;
		else if (a === "--status-interval") out.statusInterval = Number(v), i++;
		else if (a === "--status-header") out.statusHeader = v, i++;
		else if (a === "--status-path") out.statusPath = v, i++;
		else if (a === "--status-done") out.statusDone = v, i++;

		else if (a === "-h" || a === "--help") {
			console.log(`
Usage:
	node capture-timelapse.mjs [options]

Options:
	--url         RTSP url (default: rtsp://192.168.1.186/live)
	--dir         Base output folder (default: ./snapshots)
	--interval    Seconds between snapshots (default: 5)
	--prefix      Filename prefix (default: frame_)
	--ext         jpg|png (default: jpg)
	--transport   tcp|udp (default: tcp)
	--quality     JPEG quality 2-31 (default: 2)

Timestamp overlay:
	--timestamp   true|false (default: true)
	--font        Font file path (default: OS-specific)
	--fontsize    Number (default: 24)

Noise/robustness:
	--ignoreDecodeErrors true|false (default: true)
	--loglevel    ffmpeg loglevel (default: fatal)

Printer status polling:
	--status-url      Status endpoint that returns JSON (default: disabled)
	--status-interval Seconds between polls (default: 30)
	--status-header   Optional header in "Key: Value" format
	--status-path     JSON path to status value (default: printer.state)
	--status-done     Comma list of done values (default: idle,finished,stopped,canceled,error)

Controls:
	Press "s" to stop (asks for confirmation).
`);
			process.exit(0);
		}
	}
	if (!Number.isFinite(out.interval) || out.interval <= 0) throw new Error("--interval must be > 0");
	if (out.statusUrl && (!Number.isFinite(out.statusInterval) || out.statusInterval <= 0)) {
		throw new Error("--status-interval must be > 0");
	}
	return out;
};

const readPath = (obj, pathStr) => {
	if (!pathStr) return obj;
	const parts = pathStr.split(".").flatMap((part) => {
		const segments = [];
		let rest = part;
		while (rest.includes("[")) {
			const before = rest.slice(0, rest.indexOf("["));
			if (before) segments.push(before);
			const idxStart = rest.indexOf("[") + 1;
			const idxEnd = rest.indexOf("]");
			if (idxEnd === -1) break;
			segments.push(rest.slice(idxStart, idxEnd));
			rest = rest.slice(idxEnd + 1);
		}
		if (rest) segments.push(rest);
		return segments;
	});
	let cur = obj;
	for (const key of parts) {
		if (cur == null) return undefined;
		const k = /^[0-9]+$/.test(key) ? Number(key) : key;
		cur = cur[k];
	}
	return cur;
};

const buildDrawTextFilter = (opts) => {
	const fontExists = opts.font && fs.existsSync(opts.font);
	const fontPart = fontExists ? `fontfile=${opts.font}:` : "";

	const stamp = escapeForDrawText(formatLocalTimestamp());

	return {
		filter:
			"drawtext=" +
			fontPart +
			`text='${stamp}':` +
			`x=${opts.padding}:y=${opts.padding}:` +
			`fontsize=${opts.fontsize}:` +
			"fontcolor=white:" +
			"box=1:" +
			`boxcolor=black@${opts.boxOpacity}:` +
			`boxborderw=${opts.boxBorder}`,
		fontExists,
	};
};

const run = async () => {
	const opts = parseArgs();

	const runDir = path.join(opts.baseDir, formatRunStamp());
	fs.mkdirSync(runDir, { recursive: true });

	fs.writeFileSync(
		path.join(runDir, "_timelapse_meta.json"),
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				url: opts.url,
				intervalSeconds: opts.interval,
				prefix: opts.prefix,
				ext: opts.ext,
				timestampOverlay: opts.timestamp,
				font: opts.font,
				transport: opts.transport,
			},
			null,
			2
		) + "\n"
	);

	let index = 1;
	let running = true;
	let capturing = false;
	let wantStop = false;
	let warnedFontMissing = false;
	let statusTimer = null;

	const takeSnapshot = () =>
		new Promise((resolve, reject) => {
			const filename = `${opts.prefix}${padIndex(index)}.${opts.ext}`;
			const outFile = path.join(runDir, filename);

			const ffmpegArgs = [
				"-hide_banner",
				"-loglevel",
				opts.loglevel,

				// Helps some RTSP streams (safe / common)
				"-probesize",
				"32M",
				"-analyzeduration",
				"3M",
			];

			if (opts.ignoreDecodeErrors) {
				ffmpegArgs.push("-fflags", "+discardcorrupt", "-err_detect", "ignore_err");
			}

			ffmpegArgs.push("-rtsp_transport", opts.transport, "-i", opts.url, "-an");

			if (opts.timestamp) {
				const { filter, fontExists } = buildDrawTextFilter(opts);
				if (!fontExists && !warnedFontMissing) {
					warnedFontMissing = true;
					console.log(`⚠️  Font not found at: ${opts.font}`);
					console.log("   Continuing without explicit fontfile. If drawtext fails, pass --font /path/to/font.ttf");
				}
				ffmpegArgs.push("-vf", filter);
			}

			ffmpegArgs.push("-frames:v", "1");

			if (opts.ext === "jpg" || opts.ext === "jpeg") {
				ffmpegArgs.push("-q:v", String(opts.quality));
			}

			ffmpegArgs.push("-y", outFile);

			const p = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
			p.on("error", reject);
			p.on("exit", (code) => (code === 0 ? resolve(outFile) : reject(new Error(`ffmpeg exited with code ${code}`))));
		});

	const stopNow = () => {
		running = false;
		clearInterval(timer);
		if (statusTimer) clearInterval(statusTimer);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		console.log("Stopped.");
		console.log(`Snapshots saved in: ${runDir}`);
		process.exit(0);
	};

	const loop = async () => {
		if (!running || capturing) return;
		capturing = true;

		try {
			const outFile = await takeSnapshot();
			// console.log(`✅ ${now.toLocaleTimeString()} 💾 ${path.basename(outFile)}`);
			console.log(`✅ ${formatLocalTimestamp(new Date())} 💾 ${path.basename(outFile)}`);
			index++;
		} catch (err) {
			console.error(`❌ snapshot failed: ${err?.message ?? err}`);
		} finally {
			capturing = false;
			if (wantStop) stopNow();
		}
	};

	console.log(`Capturing every ${opts.interval}s to: ${runDir}`);
	console.log(`Timestamp overlay: ${opts.timestamp ? "on" : "off"}`);
	console.log(`Press "s" to stop (with confirmation).`);

	const timer = setInterval(loop, opts.interval * 1000);
	await loop();

	if (opts.statusUrl) {
		const doneSet = new Set(opts.statusDone.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
		const checkStatus = async () => {
			if (!running) return;
			try {
				const headers = {};
				if (opts.statusHeader) {
					const idx = opts.statusHeader.indexOf(":");
					if (idx !== -1) {
						const key = opts.statusHeader.slice(0, idx).trim();
						const value = opts.statusHeader.slice(idx + 1).trim();
						if (key && value) headers[key] = value;
					}
				}
				const res = await fetch(opts.statusUrl, { headers });
				if (!res.ok) throw new Error(`status ${res.status}`);
				const data = await res.json();
				const value = readPath(data, opts.statusPath);
				if (typeof value === "string" && doneSet.has(value.toLowerCase())) {
					console.log(`Printer status "${value}" detected. Stopping capture...`);
					wantStop = true;
					if (!capturing) stopNow();
				}
			} catch (err) {
				console.error(`❌ status check failed: ${err?.message ?? err}`);
			}
		};

		console.log(`Status polling: ${opts.statusUrl} (${opts.statusInterval}s)`);
		statusTimer = setInterval(checkStatus, opts.statusInterval * 1000);
		await checkStatus();
	}

	if (process.stdin.isTTY) {
		process.stdin.setEncoding("utf8");
		process.stdin.setRawMode(true);
		process.stdin.resume();

		let confirming = false;

		process.stdin.on("data", (key) => {
			if (!running) return;

			if (key === "\u0003") {
				console.log("\nCtrl+C");
				stopNow();
				return;
			}

			if (!confirming && (key === "s" || key === "S")) {
				confirming = true;
				process.stdout.write("\nStop capturing? (y/N) ");
				return;
			}

			if (confirming) {
				const k = key.trim().toLowerCase();
				if (k === "y") {
					wantStop = true;
					process.stdout.write("\nStopping...\n");
					if (!capturing) stopNow();
				} else {
					process.stdout.write("\nContinuing.\n");
				}
				confirming = false;
			}
		});
	}
};

run().catch((err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
