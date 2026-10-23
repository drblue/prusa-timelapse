#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import kleur from "kleur";

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3, 5, 10];

const ask = async (q) => {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const a = await new Promise((r) => rl.question(q, r));
	rl.close();
	return String(a).trim();
};

const askKey = async (question, choices, defaultChoice) => {
	if (!process.stdin.isTTY) {
		for (;;) {
			const answer = (await ask(question)).toLowerCase() || defaultChoice;
			if (choices.includes(answer)) return answer;
		}
	}

	readline.emitKeypressEvents(process.stdin);
	const wasRaw = process.stdin.isRaw;
	const wasPaused = process.stdin.isPaused();
	process.stdout.write(question);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	return new Promise((resolve) => {
		const onKey = (text, key) => {
			const interrupted = key?.ctrl && key.name === "c";
			const answer = ["return", "enter"].includes(key?.name)
				? defaultChoice
				: (text ?? "").toLowerCase();
			if (!interrupted && !choices.includes(answer)) return;
			process.stdin.removeListener("keypress", onKey);
			process.stdin.setRawMode(wasRaw);
			if (wasPaused) process.stdin.pause();
			process.stdout.write(`${interrupted ? "^C" : answer}\n`);
			if (interrupted) process.exit(130);
			resolve(answer);
		};
		process.stdin.on("keypress", onKey);
	});
};

const parseArgs = () => {
	const args = process.argv.slice(2);
	const out = {
		baseDir: path.resolve(process.cwd(), "snapshots"),
		pattern: "frame_%06d.jpg",
		outFile: null,
		recursive: true,
		folder: null,
		fps: null,
		quality: null,
		speed: null,
	};
	const positionals = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const v = args[i + 1];
		if (a === "--dir") out.baseDir = path.resolve(v), i++;
		else if (a === "--folder") out.folder = path.resolve(v), i++;
		else if (a === "--pattern") out.pattern = v, i++;
		else if (a === "--out") out.outFile = path.resolve(v), i++;
		else if (a === "--recursive") out.recursive = v !== "false", i++;
		else if (a === "--fps") out.fps = Number(v), i++;
		else if (a === "--quality" || a === "--crf") out.quality = Number(v), i++;
		else if (a === "--speed") out.speed = Number(v), i++;
		else if (a === "-h" || a === "--help") {
			console.log(`
Usage:
	node make-timelapse.mjs [options] [folder]

Options:
	--dir        Base snapshots folder (default: ./snapshots)
	--folder     Specific snapshot folder to process (skips interactive selection)
	--pattern    Input pattern (default: frame_%06d.jpg)
	--out        Output file (default: auto-generated in snapshots/)
	--recursive  Search subfolders (default: true)
	--fps        Base FPS for video (default: 30, max 60)
	--quality    CRF quality value (default: 20, range: 0-51, lower is better)
	--speed      Speed multiplier (default: 1, options: 0.5, 1, 1.5, 2, 3, 5, 10)

Positional Arguments:
	folder       Snapshot folder path (alternative to --folder)

Examples:
	node make-timelapse.mjs --folder ./snapshots/20260113-113436 --fps 30 --quality 20 --speed 2
	node make-timelapse.mjs --fps 30 --quality 20 --speed 2 ./snapshots/20260113-113436
`);
			process.exit(0);
		}
		else if (!a.startsWith("-")) {
			positionals.push(a);
		}
	}

	// Use last positional argument as folder if --folder wasn't specified
	if (!out.folder && positionals.length > 0) {
		out.folder = path.resolve(positionals[positionals.length - 1]);
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

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const escapeForDrawText = (s) =>
	s
		.replaceAll("\\", "\\\\")
		.replaceAll(":", "\\:")
		.replaceAll("'", "\\'");

const readStatusFile = (dir, prefix, index) => {
	const statusFileName = `${prefix}${String(index).padStart(6, "0")}_status.json`;
	const statusPath = path.join(dir, statusFileName);
	try {
		return JSON.parse(fs.readFileSync(statusPath, "utf8"));
	} catch {
		return null;
	}
};

const formatTelemetry = (statusData) => {
	if (!statusData) return "";

	const lines = [];

	// Job progress
	if (statusData.job?.progress !== undefined) {
		lines.push(`Progress: ${statusData.job.progress.toFixed(1)}%`);
	}

	// Temperatures
	if (statusData.printer?.temp_nozzle !== undefined) {
		const nozzle = statusData.printer.temp_nozzle.toFixed(1);
		const target = statusData.printer.target_nozzle?.toFixed(1) ?? "?";
		lines.push(`Nozzle: ${nozzle}/${target}°C`);
	}

	if (statusData.printer?.temp_bed !== undefined) {
		const bed = statusData.printer.temp_bed.toFixed(1);
		const target = statusData.printer.target_bed?.toFixed(1) ?? "?";
		lines.push(`Bed: ${bed}/${target}°C`);
	}

	// Time info
	if (statusData.job?.time_remaining !== undefined && statusData.job?.time_printing !== undefined) {
		const elapsed = Math.round(statusData.job.time_printing);
		const remaining = Math.round(statusData.job.time_remaining);
		const elapsedStr = formatDuration(elapsed);
		const remainingStr = formatDuration(remaining);
		lines.push(`Elapsed: ${elapsedStr}  Remaining: ${remainingStr}`);
	}

	// Z position
	if (statusData.printer?.axis_z !== undefined) {
		lines.push(`Z: ${statusData.printer.axis_z.toFixed(2)}mm`);
	}

	return lines.join("\n");
};

const listFrameNumbers = (dir, prefix, ext) => {
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${escapeRegex(prefix)}(\\d+)${escapeRegex(ext)}$`);
	const numbers = [];
	for (const name of entries) {
		const match = re.exec(name);
		if (!match) continue;
		const n = Number(match[1]);
		if (!Number.isInteger(n)) continue;
		numbers.push(n);
	}
	return numbers.sort((a, b) => a - b);
};

const chooseStartNumber = async (chosen, frameNumbers) => {
	const firstNumber = frameNumbers[0];
	const statuses = frameNumbers.map((number) => readStatusFile(chosen.dir, chosen.prefix, number));
	// Missing or unreadable status files do not establish that time_remaining was unset.
	const requireProgress = statuses.some((status) => status !== null && status.job?.time_remaining == null);
	for (let index = 0; index < frameNumbers.length; index++) {
		const number = frameNumbers[index];
		const status = statuses[index];
		if (status?.job?.time_remaining == null) continue;
		if (requireProgress && !(status.job.progress > 0)) continue;

		const elapsed = Math.round((number - firstNumber) * chosen.intervalSeconds);
		const startNumber = frameNumbers[Math.max(0, index - 10)];
		const frameLabel = (n) => String(n);
		console.log(`\nPrint detected starting at frame ${frameLabel(number)} (after ${Math.floor(elapsed / 60)} min ${elapsed % 60} sec).`);
		for (;;) {
			const answer = (await ask(
				`Start at frame ${frameLabel(startNumber)} instead of frame ${frameLabel(firstNumber)}? [Y/n] `
			)).toLowerCase();
			if (["", "y", "yes"].includes(answer)) return startNumber;
			if (["n", "no"].includes(answer)) return firstNumber;
			console.log("Please enter yes (Y) or no (N), or press Enter for yes.");
		}
	}
	return firstNumber;
};

const parseFolderStamp = (name) => {
	const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
	if (!match) return null;
	const [, yyyy, mm, dd, hh, mi, ss] = match;
	const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return {
		dateKey: `${yyyy}-${mm}-${dd}`,
		timeOnly: `${hh}:${mi}:${ss}`,
		timestamp: date.getTime(),
	};
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
		const a = await askKey(
			`\nFile already exists:\n${filePath}\n` +
			"[o] overwrite  [C] create new (auto-suffix, default)  [q] cancel: ",
			["o", "c", "q"], "c"
		);

		if (a === "o") return filePath;
		if (a === "q") process.exit(0);
		if (a === "c") {
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
			const baseName = path.basename(dir);
			const parsed = parseFolderStamp(baseName);
			return {
				dir,
				prefix,
				ext,
				intervalSeconds,
				frames: countFrames(dir, prefix, ext),
				baseName,
				displayName: parsed?.timeOnly ?? baseName,
				jobDisplayName: meta.job?.display_name ?? meta.job?.file?.display_name,
				dateKey: parsed?.dateKey ?? "Other",
				timestamp: parsed?.timestamp ?? null,
			};
		})
		.sort((a, b) => {
			const aKnown = a.timestamp !== null;
			const bKnown = b.timestamp !== null;
			if (aKnown && bKnown) return a.timestamp - b.timestamp;
			if (aKnown !== bKnown) return aKnown ? -1 : 1;
			return a.baseName.localeCompare(b.baseName);
		});

	let chosen;

	if (opts.folder) {
		// Use specified folder directly
		const folderPath = opts.folder;
		const meta = readMeta(folderPath);
		const prefix = meta.prefix ?? "frame_";
		const ext = `.${meta.ext ?? "jpg"}`;
		const intervalSeconds = Number(meta.intervalSeconds) || 5;
		const baseName = path.basename(folderPath);
		const parsed = parseFolderStamp(baseName);
		chosen = {
			dir: folderPath,
			prefix,
			ext,
			intervalSeconds,
			frames: countFrames(folderPath, prefix, ext),
			baseName,
			displayName: parsed?.timeOnly ?? baseName,
			dateKey: parsed?.dateKey ?? "Other",
			timestamp: parsed?.timestamp ?? null,
		};
		console.log(`\n${kleur.cyan("📸 Processing:")} ${chosen.displayName} (${chosen.frames} frames, ${chosen.intervalSeconds}s interval)`);
	} else {
		// Interactive selection
		console.log(`\n${kleur.bold().cyan("📸 Found prints")}\n`);
		let currentDateKey = null;
		items.forEach((it, i) => {
			if (it.dateKey !== currentDateKey) {
				currentDateKey = it.dateKey;
				if (i !== 0) console.log("");
				console.log(kleur.bold().yellow(`📅 ${currentDateKey}`));
			}
			const nameColor = it.timestamp ? kleur.white : kleur.gray;
			console.log(
				`${kleur.magenta(String(i + 1).padStart(2) + ".")} ${nameColor(`🕒 ${it.displayName}`)} ` +
				(it.jobDisplayName ? `${kleur.cyan(it.jobDisplayName)} ` : "") +
				`${kleur.dim(`(${it.frames} frames, ${it.intervalSeconds}s interval)`)}`
			);
		});

		for (;;) {
			const a = await ask("\nChoose a print (number) or 'q': ");
			if (a.toLowerCase() === "q") process.exit(0);
			const n = Number(a);
			if (Number.isInteger(n) && n >= 1 && n <= items.length) {
				chosen = items[n - 1];
				break;
			}
		}
	}

	const frameNumbers = listFrameNumbers(chosen.dir, chosen.prefix, chosen.ext);
	if (!frameNumbers.length) throw new Error("No frames found in the selected folder.");
	const startNumber = await chooseStartNumber(chosen, frameNumbers);
	const selectedFrames = frameNumbers.filter((number) => number >= startNumber);

	const baseFps = opts.fps !== null
		? (Number.isFinite(opts.fps) && opts.fps >= 1 && opts.fps <= 60 ? opts.fps : 30)
		: (opts.folder ? 30 : await askIntDefault({ label: "FPS (<2x speed, max 60)", def: 30, min: 1, max: 60 }));

	const crf = opts.quality !== null
		? (Number.isFinite(opts.quality) && opts.quality >= 0 && opts.quality <= 51 ? opts.quality : 20)
		: (opts.folder ? 20 : await askIntDefault({ label: "CRF (quality)", def: 20, min: 0, max: 51 }));

	const speed = opts.speed !== null
		? (SPEED_OPTIONS.includes(opts.speed) ? opts.speed : 1)
		: (opts.folder ? 1 : await showSpeedMenuAndPick({
				frames: selectedFrames.length,
				intervalSeconds: chosen.intervalSeconds,
				baseFps,
		  }));

	const outFps = speed >= 2 ? 60 : baseFps;

	const baseName = `timelapse-${path.basename(chosen.dir)}-${outFps}fps-${crf}crf-${speed}x.mp4`;
	const desiredPath = opts.outFile ?? path.join(opts.baseDir, baseName);
	const outFile = await resolveOutputPath(desiredPath);

	const input = path.join(chosen.dir, opts.pattern);

	// Check if status files exist to decide whether to show telemetry
	const hasTelemetry = selectedFrames.some((number) =>
		fs.existsSync(path.join(chosen.dir, `${chosen.prefix}${String(number).padStart(6, "0")}_status.json`))
	);

	// Pre-process frames with telemetry overlay if available
	let processedInput = input;
	if (hasTelemetry) {
		console.log(`\n${kleur.cyan("📊 Overlaying telemetry on frames...")}`);
		const tempDir = path.join(chosen.dir, "_temp_telemetry");
		fs.mkdirSync(tempDir, { recursive: true });

		// Process each frame with telemetry overlay
		for (const [frameIndex, i] of selectedFrames.entries()) {
			const statusData = readStatusFile(chosen.dir, chosen.prefix, i);
			const telemetryLines = formatTelemetry(statusData).split("\n");

			const inputFrame = path.join(chosen.dir, `${chosen.prefix}${String(i).padStart(6, "0")}${chosen.ext}`);
			const outputFrame = path.join(tempDir, `${chosen.prefix}${String(i).padStart(6, "0")}${chosen.ext}`);

			// Build multiple drawtext filters, one per line
			let filterChain = "";
			telemetryLines.forEach((line, idx) => {
				const escapedLine = line
					.replace(/\\/g, "\\\\")
					.replace(/%/g, "\\\\%")
					.replace(/:/g, "\\:")
					.replace(/'/g, "'\\''");
				const yPos = 50 + (idx * 28);
				if (idx > 0) filterChain += ",";
				filterChain += `drawtext=text='${escapedLine}':fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:fontsize=24:fontcolor=white:x=10:y=${yPos}:box=1:boxcolor=black@0.5:boxborderw=6`;
			});

			const ffmpegOverlayArgs = [
				"-hide_banner",
				"-loglevel", "error",
				"-i", inputFrame,
				"-vf", filterChain,
				"-q:v", "2",
				"-y",
				outputFrame,
			];

			const p = spawn("ffmpeg", ffmpegOverlayArgs, { stdio: "inherit" });
			await new Promise((res, rej) => p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg overlay failed on frame ${i}`)))));

			if ((frameIndex + 1) % 50 === 0) {
				console.log(`  Processed ${frameIndex + 1}/${selectedFrames.length} frames...`);
			}
		}

		processedInput = path.join(tempDir, opts.pattern);
		console.log(`${kleur.cyan("📊 Telemetry overlay complete")}`);
	}

	// Build video filter
	const vf = `setpts=PTS/${speed},fps=${outFps}`;

	const ffmpegArgs = [
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		...(Number.isInteger(startNumber) ? ["-start_number", String(startNumber)] : []),
		"-framerate", String(outFps),
		"-i", processedInput,
		"-vf", vf,
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-crf", String(crf),
		outFile,
	];

	console.log(`\n${kleur.bold().cyan("🎬 Running")}:`);
	console.log(kleur.dim("ffmpeg " + ffmpegArgs.join(" ")));

	const p = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
	await new Promise((res, rej) => p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

	// Clean up temporary telemetry frames directory
	if (hasTelemetry) {
		const tempDir = path.join(chosen.dir, "_temp_telemetry");
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}

	console.log(`\n${kleur.green("✅ Wrote:")} ${outFile}`);
};

run().catch((err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
