import fs from "node:fs";
import path from "node:path";
import type { VideoPart } from "./record-video.ts";

export const appendVideoStatus = (runDir: string, data: unknown, requestStartedAt: Date, fetchedAt = new Date()) => {
	fs.appendFileSync(path.join(runDir, "recording-status.jsonl"), JSON.stringify({
		requestStartedAt: requestStartedAt.toISOString(), fetchedAt: fetchedAt.toISOString(), data,
	}) + "\n");
};

export const writeVideoTimeline = (runDir: string, parts: VideoPart[], stoppedAt: number) => {
	const wallClock = parts.length > 0 && parts.every((part) => part.capturedAt !== undefined);
	const origin = wallClock ? parts[0].capturedAt! : undefined;
	let offset = 0;
	const segments = parts.map((part, index) => {
		const start = wallClock ? (part.capturedAt! - origin!) / 1000 : offset;
		const duration = wallClock
			? Math.max(part.duration || 0, ((parts[index + 1]?.capturedAt ?? stoppedAt) - part.capturedAt!) / 1000)
			: part.duration || 0;
		offset = start + duration;
		return { part: part.file, videoStartSeconds: start, durationSeconds: duration,
			capturedAt: part.capturedAt === undefined ? null : new Date(part.capturedAt).toISOString(),
			// The rest of the segment may hold the final intact picture during an outage.
			capturedDurationSeconds: part.duration || 0 };
	});
	fs.writeFileSync(path.join(runDir, "recording-timeline.json"), JSON.stringify({
		statusFile: "recording-status.jsonl", videoFile: "recording.mp4",
		mapping: wallClock ? "receiver-wall-clock" : "unavailable",
		timelineStartedAt: origin === undefined ? null : new Date(origin).toISOString(),
		stoppedAt: new Date(stoppedAt).toISOString(),
		note: "Receiver timestamps approximate camera time. Status is sampled, not frame-accurate. Held pictures during outages do not represent current printer position.",
		segments,
	}, null, 2) + "\n");
};
