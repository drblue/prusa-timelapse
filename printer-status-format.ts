import { formatVideoTimestamp } from "./video-printer-status.ts";

export type PrinterJob = {
	progress?: number;
	time_printing?: number;
	time_remaining?: number;
};

const formatDuration = (seconds: number | undefined) => {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m`
		: `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
};

export const formatPrinterStatus = (state: unknown, job?: PrinterJob, now = new Date()) => {
	const details: string[] = [];
	if (typeof state === "string" && state.trim().toLowerCase() === "printing") {
		const elapsed = formatDuration(job?.time_printing);
		const remaining = formatDuration(job?.time_remaining);
		if (elapsed) details.push(`elapsed ${elapsed}`);
		if (remaining) {
			details.push(`remaining ${remaining}`);
			const eta = new Date(now.getTime() + job!.time_remaining! * 1000);
			details.push(`ETA ${String(eta.getHours()).padStart(2, "0")}:${String(eta.getMinutes()).padStart(2, "0")}`);
		}
	}
	let suffix = details.length ? ` ${details.join(", ")}` : "";
	if (typeof state === "string" && state.trim().toLowerCase() === "printing" && typeof job?.progress === "number" && Number.isFinite(job.progress)) {
		suffix += ` (${job.progress.toFixed(2)}%)`;
	}
	return `🖨️ ${formatVideoTimestamp(now)} status: ${state ?? "(missing)"}${suffix}`;
};
