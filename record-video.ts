import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

export type VideoOptions = {
	url: string;
	transport: string;
	loglevel: string;
	captureHeader?: string | null;
};

const videoLoglevel = (opts: VideoOptions) => ["quiet", "panic", "fatal"].includes(opts.loglevel) ? "warning" : opts.loglevel;

const videoInputArgs = (opts: VideoOptions) => {
	const args: string[] = [];
	if (opts.captureHeader) args.push("-headers", `${opts.captureHeader.replace(/\r?\n$/, "")}\r\n`);
	if (opts.url.startsWith("rtsp://")) args.push("-rtsp_transport", opts.transport, "-timeout", "5000000",
		"-allowed_media_types", "video", "-analyzeduration", "1000000", "-probesize", "1M");
	else if (/^https?:\/\//.test(opts.url)) args.push("-rw_timeout", "5000000");
	args.push("-i", opts.url);
	return args;
};

// Stream copy starts at a keyframe by default. MPEG-TS supplies current in-band
// H.264 parameters, avoiding the Buddy3D's stale SDP parameters after a mode change.
// This stage neither decodes/re-encodes the pictures nor replaces their timestamps.
export const buildVideoSourceArgs = (opts: VideoOptions) => [
	"-hide_banner", "-nostats", "-loglevel", videoLoglevel(opts), ...videoInputArgs(opts),
	"-map", "0:v:0", "-an", "-c:v", "copy", "-f", "mpegts", "-flush_packets", "1", "pipe:1",
];

// An interrupted decoder must not pass concealed frames into the recording.
export const buildVideoArgs = (opts: VideoOptions, outFile: string, filter?: string | null) => {
	const args = ["-hide_banner", "-nostats", "-loglevel", videoLoglevel(opts), "-xerror",
		"-stats_period", "0.5", "-progress", "pipe:3",
		"-err_detect", "explode", "-threads", "1", ...videoInputArgs(opts), "-map", "0:v:0", "-an"];
	if (filter) args.push("-vf", filter);
	args.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23",
		"-pix_fmt", "yuv420p", "-fps_mode", "vfr", "-g", "25", "-bf", "0",
		"-f", "matroska", "-cluster_time_limit", "1000", "-n", outFile);
	return args;
};

const inspectVideoPart = (file: string): Promise<{ packets: number; duration: number }> => new Promise((resolve, reject) => {
	const probe = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
		"-show_entries", "stream=nb_read_packets:format=duration", "-of", "json", file], { stdio: ["ignore", "pipe", "ignore"] });
	let output = "";
	probe.stdout.on("data", (chunk) => { output += chunk; });
	probe.once("error", reject);
	probe.once("close", (code) => {
		if (code !== 0) return resolve({ packets: 0, duration: 0 });
		try {
			const data = JSON.parse(output);
			resolve({ packets: Number(data.streams?.[0]?.nb_read_packets) || 0, duration: Number(data.format?.duration) || 0 });
		} catch (err) { reject(err); }
	});
});

export type VideoPart = { file: string; packets: number; duration?: number; capturedAt?: number };

export const joinParts = (partsDir: string, parts: VideoPart[], outFile: string, stoppedAt?: number): Promise<void> => new Promise((resolve, reject) => {
	const listFile = path.join(partsDir, "parts.ffconcat");
	const preserveTimeline = stoppedAt !== undefined && parts.every((part) => part.capturedAt !== undefined);
	// Generated relative filenames keep the concat list safe even when the run path contains quotes.
	fs.writeFileSync(listFile, "ffconcat version 1.0\n" + parts.map((part, i) => {
		const duration = preserveTimeline && i + 1 < parts.length
			? `duration ${Math.max(part.duration || 0, (parts[i + 1].capturedAt! - part.capturedAt!) / 1000)}\n` : "";
		return `file ${part.file}\n${duration}`;
	}).join(""));
	const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-f", "concat", "-safe", "1",
		"-i", listFile, "-map", "0:v:0", "-c:v", "copy"];
	if (preserveTimeline) {
		const lastPacket = parts.reduce((total, part) => total + part.packets, 0) - 1;
		const duration = (stoppedAt! - parts[0].capturedAt!) / 1000;
		// Extend the final picture's display duration through any trailing outage.
		// Together with concat offsets, this holds intact pictures without re-encoding.
		args.push("-bsf:v", `setts=duration='if(eq(N,${lastPacket}),max(DURATION,${duration}/TB-PTS),DURATION)'`);
	}
	args.push("-movflags", "+faststart", "-n", outFile);
	const child = spawn("ffmpeg", args,
		{ stdio: ["ignore", "ignore", "inherit"] });
	child.once("error", reject);
	child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Video assembly failed (${code}); parts kept in ${partsDir}`)));
});

export const captureVideo = async (
	opts: VideoOptions,
	runDir: string,
	filter: string | null | undefined,
	signal: AbortSignal,
) => {
	const outFile = path.join(runDir, "recording.mp4");
	const partsDir = path.join(runDir, "recording-parts");
	fs.mkdirSync(partsDir); // Never mix a previous recording into this run.
	const logFile = path.join(runDir, "recording.log");
	const log = (message: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
	const redact = (message: string) => {
		let safe = message.replaceAll(opts.url, "[camera URL]");
		if (opts.captureHeader) {
			const secret = opts.captureHeader.slice(opts.captureHeader.indexOf(":") + 1).trim();
			if (secret) safe = safe.replaceAll(secret, "[redacted]");
		}
		return safe.replace(/(rtsps?|https?):\/\/[^\s]+/g, "[camera URL]");
	};
	const parts: VideoPart[] = [];
	let attempt = 0;
	let failure: unknown;
	let stoppedAt: number | undefined;
	const markStopped = () => { stoppedAt ??= Date.now(); };
	signal.addEventListener("abort", markStopped, { once: true });
	if (signal.aborted) markStopped();
	try {
		while (!signal.aborted) {
			const name = `part_${String(++attempt).padStart(6, "0")}.mkv`;
			const file = path.join(partsDir, name);
			log(`Connecting (attempt ${attempt}).`);
			const result = await new Promise<{ code: number | null; reason: string; fatal: boolean; capturedAt?: number }>((resolve, reject) => {
				const source = opts.url.startsWith("rtsp://")
					? spawn("ffmpeg", buildVideoSourceArgs(opts), { stdio: ["pipe", "pipe", "pipe"] }) : null;
				const input = source ? { ...opts, url: "pipe:0", captureHeader: null } : opts;
				const child = spawn("ffmpeg", buildVideoArgs(input, file, filter), { stdio: ["pipe", "ignore", "pipe", "pipe"] });
				let capturedAt: number | undefined;
				if (source) {
					source.stdout.once("data", () => {
						capturedAt = Date.now();
						log("First keyframe received; starting timeline for this connection.");
					});
					source.stdout.pipe(child.stdin!);
				}
				let lastFrameAt = Date.now();
				let frames = 0;
				let pending = "";
				const diagnosticPending = new Map<string, string>();
				let reason = "Stream ended or decoding failed";
				let fatal = false;
				let terminating = false;
				let sourceClosed = !source;
				let decoderClosed = false;
				let decoderCode: number | null = null;
				let forceTimer: ReturnType<typeof setTimeout> | undefined;
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				const finish = (why: string) => {
					if (terminating) return;
					terminating = true;
					reason = why;
					const receiver = source && !sourceClosed ? source : !source ? child : null;
					receiver?.stdin!.end("q\n");
					forceTimer = setTimeout(() => {
						if (source && !sourceClosed) source.kill("SIGINT");
						if (!decoderClosed && (!source || sourceClosed)) child.kill("SIGINT");
					}, 1000);
					killTimer = setTimeout(() => {
						if (source && !sourceClosed) source.kill("SIGKILL");
						if (!decoderClosed) child.kill("SIGKILL");
					}, 3000);
				};
				const onAbort = () => finish("Stopped by user");
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
				const watchdog = setInterval(() => {
					// Allow probing and the first keyframe longer than an established stream.
					if (Date.now() - lastFrameAt > (frames ? 5000 : 15000)) finish("No complete frames received; reconnecting");
				}, 500);
				const cleanup = () => {
					clearInterval(watchdog);
					clearTimeout(forceTimer);
					clearTimeout(killTimer);
					signal.removeEventListener("abort", onAbort);
				};
				const onStdinError = (err: NodeJS.ErrnoException) => {
					if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") log(`Stop failed: ${err.message}`);
				};
				child.stdin!.on("error", onStdinError);
				source?.stdin.on("error", onStdinError);
				const writeDiagnostics = (line: string) => {
					const message = redact(line);
					fs.appendFileSync(logFile, message);
					if (/No space left on device|Permission denied|Unknown encoder|Unrecognized option/.test(message)) fatal = true;
				};
				const onDiagnostics = (label: string, chunk: Buffer) => {
					const lines = ((diagnosticPending.get(label) || "") + chunk.toString()).split("\n");
					diagnosticPending.set(label, lines.pop()!);
					for (const line of lines) writeDiagnostics(`${label}: ${line}\n`);
				};
				child.stderr!.on("data", (chunk: Buffer) => onDiagnostics("decoder", chunk));
				source?.stderr.on("data", (chunk: Buffer) => onDiagnostics("source", chunk));
				child.stdio[3]!.on("data", (chunk: Buffer) => {
					pending += chunk.toString();
					const lines = pending.split(/\r?\n/);
					pending = lines.pop()!;
					for (const line of lines) {
						if (!line.startsWith("frame=")) continue;
						const next = Number(line.slice(6));
						if (next > frames) { frames = next; lastFrameAt = Date.now(); }
					}
				});
				const onSpawnError = (err: Error) => {
					child.kill("SIGKILL");
					source?.kill("SIGKILL");
					cleanup();
					reject(err);
				};
				const settle = () => {
					if (!decoderClosed || !sourceClosed) return;
					cleanup();
					for (const [label, pending] of diagnosticPending) if (pending) writeDiagnostics(`${label}: ${pending}\n`);
					resolve({ code: decoderCode, reason, fatal, capturedAt });
				};
				child.once("error", onSpawnError);
				source?.once("error", onSpawnError);
				source?.once("close", () => { sourceClosed = true; settle(); });
				child.once("close", (code) => {
					decoderClosed = true;
					decoderCode = code;
					if (!sourceClosed) finish(reason);
					settle();
				});
			});
			const { packets, duration } = fs.existsSync(file) ? await inspectVideoPart(file) : { packets: 0, duration: 0 };
			const usable = packets > 0;
			if (usable) parts.push({ file: name, packets, duration, capturedAt: result.capturedAt });
			else fs.rmSync(file, { force: true });
			log(`${result.reason} (exit ${result.code}); ${usable ? "saved complete frames" : "no video packets"}.`);
			if (result.fatal) throw new Error(`Recording failed; see ${logFile}`);
			if (signal.aborted) break;
			console.log(`Video interrupted; reconnecting. Details: ${logFile}`);
			// Brief backoff prevents a tight retry loop; stopping also cancels this wait.
			await new Promise<void>((resolve) => {
				const onAbort = () => { clearTimeout(timer); resolve(); };
				const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 500);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) { signal.removeEventListener("abort", onAbort); onAbort(); }
			});
		}
	} catch (err) {
		failure = err;
	} finally {
		signal.removeEventListener("abort", markStopped);
		if (parts.length) {
			console.log("Finishing video; please wait...");
			await joinParts(partsDir, parts, outFile, stoppedAt ?? Date.now());
			if (!failure) fs.rmSync(partsDir, { recursive: true });
			console.log(`Video saved in: ${outFile}`);
		}
	}
	if (failure) throw failure;
	if (!parts.length) throw new Error(`No complete video frames captured; see ${logFile}`);
};

export const recordVideo = async (opts: VideoOptions, runDir: string, filter?: string | null) => {
	const controller = new AbortController();
	const wasRaw = process.stdin.isRaw;
	let confirming = false;
	const stop = () => {
		if (controller.signal.aborted) return;
		console.log("\nStopping video capture...");
		controller.abort();
	};
	const onKeypress = (key: string, details: readline.Key) => {
		if (controller.signal.aborted) return;
		if (details?.ctrl && details.name === "c") return stop();
		if (confirming) {
			confirming = false;
			if (key?.toLowerCase() === "y") stop();
			else console.log("\nContinuing recording.");
		} else if (key?.toLowerCase() === "s") {
			confirming = true;
			process.stdout.write("\nStop recording? (y/N) ");
		}
	};
	readline.emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.on("keypress", onKeypress);
	process.stdin.resume();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	console.log(`Recording continuous video to: ${path.join(runDir, "recording.mp4")}`);
	console.log('Press "s", then "y" to stop. Any other key cancels. Ctrl+C also finishes the video.');
	try {
		await captureVideo(opts, runDir, filter, controller.signal);
	} finally {
		process.stdin.removeListener("keypress", onKeypress);
		process.stdin.setRawMode(Boolean(wasRaw));
		process.stdin.pause();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
};
