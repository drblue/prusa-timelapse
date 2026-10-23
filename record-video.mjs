import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

export const recordVideo = (opts, runDir, filter) => new Promise((resolve, reject) => {
	const outFile = path.join(runDir, "recording.mp4");
	const args = ["-hide_banner", "-loglevel", opts.loglevel];
	if (opts.ignoreDecodeErrors) args.push("-fflags", "+discardcorrupt", "-err_detect", "ignore_err");
	if (opts.captureHeader) args.push("-headers", `${opts.captureHeader.replace(/\r?\n$/, "")}\r\n`);
	if (opts.url.startsWith("rtsp://")) args.push("-rtsp_transport", opts.transport);
	args.push("-i", opts.url, "-map", "0:v:0", "-an");
	if (filter) args.push("-vf", filter);
	args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-n", outFile);

	// Keep FFmpeg's stdin separate so terminal keys cannot bypass confirmation.
	const child = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
	const wasRaw = process.stdin.isRaw;
	let confirming = false;
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		console.log("\nFinishing video; please wait...");
		child.stdin.end("q\n");
	};
	const onKeypress = (key, details) => {
		if (stopping) return;
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
	const cleanup = () => {
		process.stdin.removeListener("keypress", onKeypress);
		process.stdin.setRawMode(Boolean(wasRaw));
		process.stdin.pause();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	};
	child.stdin.on("error", (err) => {
		if (err.code !== "EPIPE") console.error(`Video stop failed: ${err.message}`);
	});
	child.once("error", (err) => { cleanup(); reject(err); });
	child.once("close", (code, signal) => {
		cleanup();
		if (code !== 0) return reject(new Error(`Video recording failed (${signal || code}).`));
		console.log(`Video saved in: ${outFile}`);
		resolve();
	});
	readline.emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.on("keypress", onKeypress);
	process.stdin.resume();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	console.log(`Recording continuous video to: ${outFile}`);
	console.log('Press "s", then "y" to stop. Any other key cancels. Ctrl+C also finishes the video.');
});
