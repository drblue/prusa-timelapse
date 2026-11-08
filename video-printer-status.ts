import type { PrinterJob } from "./printer-status-format.ts";

export type PrinterLifecycleOptions = {
	readState: (signal: AbortSignal) => Promise<unknown>;
	intervalMs: number;
	doneStates: string[];
};

type PrinterSnapshot = {
	state: unknown;
	job?: PrinterJob;
	printer?: { axis_z?: number; temp_nozzle?: number; target_nozzle?: number; temp_bed?: number; target_bed?: number };
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Network-only estimate for the Core One: preparation also reports PRINTING and an ETA.
// This can include a purge line; it is not a physical extrusion/layer sensor.
const estimatedPrintStarted = ({ job, printer: p }: PrinterSnapshot) => {
	if (!finite(job?.time_remaining) || job.time_remaining < 0) return false;
	// Starting the script after the first layer must not require a low Z position.
	if (finite(job.progress) && job.progress > 0 && job.progress <= 100) return true;
	if (!p) return false;
	if (!finite(p.axis_z) || p.axis_z <= 0 || p.axis_z > 1) return false;
	if (!finite(p.target_nozzle) || p.target_nozzle < 180 || !finite(p.temp_nozzle)) return false;
	if (Math.abs(p.temp_nozzle - p.target_nozzle) > 5) return false;
	return finite(p.target_bed) && p.target_bed >= 0 && finite(p.temp_bed) && p.temp_bed >= p.target_bed - 5;
};

export const formatVideoTimestamp = (date = new Date()) => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const pause = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve) => {
	const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
	const timer = setTimeout(finish, milliseconds);
	signal.addEventListener("abort", finish, { once: true });
	if (signal.aborted) finish();
});

export const watchPrinterLifecycle = async (
	opts: PrinterLifecycleOptions,
	signal: AbortSignal,
	onReady: (start: boolean) => void,
	onDone: (state: string) => void,
	onState: (state: unknown, job?: PrinterJob) => void = () => {},
	onError: (error: unknown) => void = () => {},
) => {
	let ready = false;
	let printingSeen = false;
	const done = new Set(opts.doneStates.map((state) => state.trim().toLowerCase()).filter(Boolean));
	const start = () => { if (!ready && !signal.aborted) { ready = true; onReady(true); } };
	try {
		while (!signal.aborted) {
			try {
				const result = await opts.readState(signal);
				const snapshot = result !== null && typeof result === "object" && "state" in result
					? result as PrinterSnapshot : { state: result };
				const value = snapshot.state;
				if (signal.aborted) break;
				onState(value, snapshot.job);
				const state = typeof value === "string" ? value.trim().toLowerCase() : undefined;
				if (state === "printing") {
					printingSeen = true;
					if (estimatedPrintStarted(snapshot)) start();
				}
				// An idle printer before a job starts is not evidence of job completion.
				if (printingSeen && state && done.has(state)) { onDone(String(value)); return; }
			} catch (error) {
				if (!signal.aborted) onError(error);
			}
			if (!signal.aborted) await pause(ready ? opts.intervalMs : Math.min(opts.intervalMs, 2000), signal);
		}
	} finally {
		if (!ready) onReady(false);
	}
};
