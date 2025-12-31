#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3, 5, 10];

const ask = async (q) => {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const a = await new Promise((r) => rl.question(q, r));
	rl.close();
	return String(a).trim();
};

const parseArgs = () => {
	const args = process.argv.slice(2);
	const out = {
		baseDir: path.resolve(process.cwd(), "snapshots"),
		pattern: "frame_%06d.jpg",
		outFile: null,
		recursive: true,
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const v = args[i + 1];
		if (a === "--dir") out.baseDir = path.resolve(v), i++;
		else if (a === "--pattern") out.pattern = v, i++;
		else if (a === "--out") out.outFile = path.resolve(v), i++;
		else if (a === "--recursive") out.recursive = v !== "false", i++;
		else if (a === "-h" || a === "--help") {
			console.log(`
Usage:
	node make-timelapse.mjs [options]

Options:
	--dir        Base snapshots folder (default: ./snapshots)
	--pattern    Input pattern (default: frame_%06d.jpg)
	--out        Output file (default: auto-generated in snapshots/)
	--recursive  Search subfolders (default: true)
`);
			process.exit(0);
		}
	}
	return out;
};

const walkDirs = (startDir) => {
	const results = [];
	const stack = [startDir];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		if (entries.some((e) => e.isFile() && e.name === "_timelapse_meta.json")) results.push(dir);
		for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name));
	}
	return results;
};

const readMeta = (dir) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "_timelapse_meta.json"), "utf8"));
	} catch {
		return {};
	}
};

const countFrames = (dir, prefix = "frame_", ext = ".jpg") => {
	try {
		return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).length;
	} catch {
		return 0;
	}
};

const formatDuration = (seconds) => {
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
};

const askIntDefault = async ({ label, def, min, max }) => {
	for (;;) {
		const a = await ask(`${label} (default ${def}): `);
		if (a === "") return def;

		const n = Number(a);
		if (!Number.isInteger(n)) {
			console.log("Must be an integer.");
			continue;
		}
		if (n < min || n > max) {
			console.log(`Must be between ${min} and ${max}.`);
			continue;
		}
		return n;
	}
};

const showSpeedMenuAndPick = async ({ frames, intervalSeconds, baseFps }) => {
	const realTimeSeconds = frames * intervalSeconds;

	console.log("\nSpeed options (speed ≥ 2x → 60fps):");
	console.log(`- Snapshot interval: ${intervalSeconds}s`);
	console.log(`- Frames: ${frames}`);
	console.log(`- Real print time: ${formatDuration(realTimeSeconds)}`);
	console.log(`- Base FPS: ${baseFps}\n`);

	SPEED_OPTIONS.forEach((speed) => {
		const outFps = speed >= 2 ? 60 : baseFps;
		const videoSeconds = frames / (outFps * speed);
		console.log(
			`  ${String(speed).padStart(4)}x  →  video: ${formatDuration(videoSeconds)}  (fps: ${outFps})`
		);
	});

	for (;;) {
		const a = await ask(`\nChoose speed (${SPEED_OPTIONS.join(", ")}) (default 1): `);
		if (a === "") return 1;

		const n = Number(a);
		if (!SPEED_OPTIONS.includes(n)) {
			console.log("Invalid speed.");
			continue;
		}
		return n;
	}
};

const resolveOutputPath = async (filePath) => {
	if (!fs.existsSync(filePath)) return filePath;

	for (;;) {
		const a = (await ask(
			`\nFile already exists:\n${filePath}\n` +
			"[o] overwrite  [n] create new (auto-suffix)  [q] cancel: "
		)).toLowerCase();

		if (a === "o") return filePath;
		if (a === "q") process.exit(0);
		if (a === "n") {
			const { dir, name, ext } = path.parse(filePath);
			let i = 2;
			let next;
			do {
				next = path.join(dir, `${name}-v${i}${ext}`);
				i++;
			} while (fs.existsSync(next));
			return next;
		}
	}
};

const run = async () => {
	const opts = parseArgs();

	const dirs = opts.recursive
		? walkDirs(opts.baseDir)
		: [opts.baseDir].filter((d) => fs.existsSync(path.join(d, "_timelapse_meta.json")));

	if (!dirs.length) throw new Error("No timelapse folders found.");

	const items = dirs
		.map((dir) => {
			const meta = readMeta(dir);
			const prefix = meta.prefix ?? "frame_";
			const ext = `.${meta.ext ?? "jpg"}`;
			const intervalSeconds = Number(meta.intervalSeconds) || 5;
			return {
				dir,
				prefix,
				ext,
				intervalSeconds,
				frames: countFrames(dir, prefix, ext),
			};
		})
		.sort((a, b) => path.basename(b.dir).localeCompare(path.basename(a.dir)));

	console.log("\nFound prints:\n");
	items.forEach((it, i) => {
		console.log(
			`${String(i + 1).padStart(2)}. ${path.basename(it.dir)} ` +
			`(${it.frames} frames, ${it.intervalSeconds}s interval)`
		);
	});

	let chosen;
	for (;;) {
		const a = await ask("\nChoose a print (number) or 'q': ");
		if (a.toLowerCase() === "q") process.exit(0);
		const n = Number(a);
		if (Number.isInteger(n) && n >= 1 && n <= items.length) {
			chosen = items[n - 1];
			break;
		}
	}

	const baseFps = await askIntDefault({ label: "FPS (<2x speed, max 60)", def: 30, min: 1, max: 60 });
	const crf = await askIntDefault({ label: "CRF (quality)", def: 20, min: 0, max: 51 });

	const speed = await showSpeedMenuAndPick({
		frames: chosen.frames,
		intervalSeconds: chosen.intervalSeconds,
		baseFps,
	});

	const outFps = speed >= 2 ? 60 : baseFps;

	const baseName = `timelapse-${path.basename(chosen.dir)}-${outFps}fps-${crf}crf-${speed}x.mp4`;
	const desiredPath = opts.outFile ?? path.join(opts.baseDir, baseName);
	const outFile = await resolveOutputPath(desiredPath);

	const input = path.join(chosen.dir, opts.pattern);
	const vf = `setpts=PTS/${speed},fps=${outFps}`;

	const ffmpegArgs = [
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-framerate", String(outFps),
		"-i", input,
		"-vf", vf,
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-crf", String(crf),
		outFile,
	];

	console.log("\nRunning:");
	console.log("ffmpeg " + ffmpegArgs.join(" "));

	const p = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
	await new Promise((res, rej) => p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

	console.log(`\n✅ Wrote: ${outFile}`);
};

run().catch((err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
