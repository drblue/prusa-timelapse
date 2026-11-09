import fs from "node:fs";
import path from "node:path";
import { formatSnapshotTelemetry } from "./snapshot-telemetry.ts";

export const DEFAULT_VIDEO_FONT_SIZE = 18;
export const videoOverlayPositions = ["top-left", "bottom-left", "top-right", "bottom-right"] as const;

export type VideoOverlayOptions = {
	font?: string;
	fontsize?: number;
	padding?: number;
	boxOpacity?: number;
	boxBorder?: number;
	timestamp?: boolean;
	videoOverlayPosition?: typeof videoOverlayPositions[number];
};

// Escape the AVOption value first, then the surrounding filtergraph syntax.
const filterValue = (value: string) => value.replace(/['\\:]/g, "\\$&").replace(/['\\,\[\];]/g, "\\$&");

const buildVideoTextFilter = (content: string, opts: VideoOverlayOptions, isTimestamp: boolean) => {
	const font = opts.font && fs.existsSync(opts.font) ? `fontfile=${filterValue(opts.font)}:` : "";
	const size = opts.fontsize ?? DEFAULT_VIDEO_FONT_SIZE;
	const padding = opts.padding ?? 10;
	const border = opts.boxBorder ?? 6;
	const position = opts.videoOverlayPosition ?? "top-left";
	const bottom = position.startsWith("bottom");
	const x = position.endsWith("right") ? `w-tw-${padding}` : String(padding);
	// Anchor the clock nearest the edge so it stays in place when telemetry gains or loses lines.
	const offset = !isTimestamp && opts.timestamp ? size + border * 2 - Math.min(2, border) : 0;
	const y = bottom ? `h-th-${padding + offset}` : `h*0.08+${padding + offset}`;
	return `drawtext=${font}${content}:fontsize=${size}:line_spacing=4:fontcolor=white:x=${x}:y=${y}:box=1:boxcolor=black@${opts.boxOpacity ?? 0.5}:boxborderw=${border}`;
};

export const buildVideoTimestampFilter = (opts: VideoOverlayOptions) =>
	buildVideoTextFilter("text='%{localtime}'", opts, true);

export const buildVideoTelemetryFilter = (file: string, opts: VideoOverlayOptions) =>
	buildVideoTextFilter(`textfile=${filterValue(path.resolve(file))}:reload=1:expansion=none`, opts, false);

export const createVideoTelemetryOverlay = (runDir: string) => {
	const file = path.resolve(runDir, "recording-telemetry.txt");
	const temporary = `${file}.tmp`;
	const write = (text: string) => {
		fs.writeFileSync(temporary, text);
		fs.renameSync(temporary, file);
	};
	write("");
	return {
		file,
		update: (status: Parameters<typeof formatSnapshotTelemetry>[0]) => write(formatSnapshotTelemetry(status)),
		clear: () => write(""),
	};
};
