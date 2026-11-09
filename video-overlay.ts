import fs from "node:fs";
import path from "node:path";
import { formatSnapshotTelemetry } from "./snapshot-telemetry.ts";

export type VideoOverlayOptions = {
	font?: string;
	fontsize?: number;
	padding?: number;
	boxOpacity?: number;
	boxBorder?: number;
	timestamp?: boolean;
};

// Leave room for a player title bar, scaled to the height of the video.
export const videoOverlayTop = (padding = 10) => `h*0.08+${padding}`;

// Escape the AVOption value first, then the surrounding filtergraph syntax.
const filterValue = (value: string) => value.replace(/['\\:]/g, "\\$&").replace(/['\\,\[\];]/g, "\\$&");

export const buildVideoTelemetryFilter = (file: string, opts: VideoOverlayOptions) => {
	const font = opts.font && fs.existsSync(opts.font) ? `fontfile=${filterValue(opts.font)}:` : "";
	const size = opts.fontsize ?? 24, padding = opts.padding ?? 10, border = opts.boxBorder ?? 6;
	const top = videoOverlayTop(padding) + (opts.timestamp ? `+${size + border * 2 - Math.min(2, border)}` : "");
	return `drawtext=${font}textfile=${filterValue(path.resolve(file))}:reload=1:expansion=none:fontsize=${size}:line_spacing=4:fontcolor=white:x=${padding}:y=${top}:box=1:boxcolor=black@${opts.boxOpacity ?? 0.5}:boxborderw=${border}`;
};

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
