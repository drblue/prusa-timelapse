import fs from "node:fs";

type SnapshotStatus = {
	job?: { progress?: number; time_printing?: number; time_remaining?: number };
	printer?: { temp_nozzle?: number; target_nozzle?: number; temp_bed?: number; target_bed?: number; axis_z?: number };
};

const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const duration = (seconds: number) => {
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60);
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
		: `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

export const formatSnapshotTelemetry = (status?: SnapshotStatus | null) => {
	if (!status) return "";
	const lines: string[] = [];
	const { job, printer } = status;
	if (numeric(job?.progress)) lines.push(`Progress: ${job.progress.toFixed(1)}%`);
	if (numeric(printer?.temp_nozzle)) lines.push(`Nozzle: ${printer.temp_nozzle.toFixed(1)}/${numeric(printer.target_nozzle) ? printer.target_nozzle.toFixed(1) : "?"}°C`);
	if (numeric(printer?.temp_bed)) lines.push(`Bed: ${printer.temp_bed.toFixed(1)}/${numeric(printer.target_bed) ? printer.target_bed.toFixed(1) : "?"}°C`);
	if (numeric(job?.time_remaining) && numeric(job?.time_printing)) lines.push(`Elapsed: ${duration(job.time_printing)}  Remaining: ${duration(job.time_remaining)}`);
	if (numeric(printer?.axis_z)) lines.push(`Z: ${printer.axis_z.toFixed(2)}mm`);
	return lines.join("\n");
};

type OverlayOptions = {
	font: string; fontsize: number; padding: number; boxOpacity: number; boxBorder: number; timestamp: boolean;
};

export const buildSnapshotTelemetryFilters = (status: SnapshotStatus | null | undefined, opts: OverlayOptions) => {
	const text = formatSnapshotTelemetry(status);
	if (!text) return [];
	const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "'\\''").replaceAll(":", "\\:");
	const font = fs.existsSync(opts.font) ? `fontfile='${escape(opts.font)}':` : "";
	const top = opts.timestamp ? opts.padding + opts.fontsize + opts.boxBorder * 2 + 4 : opts.padding;
	return text.split("\n").map((line, index) =>
		`drawtext=${font}text='${escape(line)}':expansion=none:fontsize=${opts.fontsize}:fontcolor=white:x=${opts.padding}:y=${top + index * (opts.fontsize + 4)}:box=1:boxcolor=black@${opts.boxOpacity}:boxborderw=${opts.boxBorder}`);
};

export const needsTelemetryOverlay = (meta: { telemetryOverlay?: boolean }) => meta.telemetryOverlay !== true;
