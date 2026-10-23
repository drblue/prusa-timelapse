export type PrinterLifecycleOptions = {
	readState: (signal: AbortSignal) => Promise<unknown>;
	intervalMs: number;
	doneStates: string[];
	waitForPrinting: boolean;
	waitTimeoutMs: number;
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
	onState: (state: unknown) => void = () => {},
	onError: (error: unknown) => void = () => {},
) => {
	let ready = false;
	let printingSeen = false;
	const beganAt = Date.now();
	const done = new Set(opts.doneStates.map((state) => state.trim().toLowerCase()).filter(Boolean));
	const start = () => { if (!ready && !signal.aborted) { ready = true; onReady(true); } };
	if (!opts.waitForPrinting) start();
	try {
		while (!signal.aborted) {
			try {
				const value = await opts.readState(signal);
				if (signal.aborted) break;
				onState(value);
				const state = typeof value === "string" ? value.trim().toLowerCase() : undefined;
				if (state === "printing") { printingSeen = true; start(); }
				// An idle printer before a job starts is not evidence of job completion.
				if (printingSeen && state && done.has(state)) { onDone(String(value)); return; }
			} catch (error) {
				if (!signal.aborted) onError(error);
			}
			if (!ready && opts.waitTimeoutMs > 0 && Date.now() - beganAt >= opts.waitTimeoutMs) start();
			if (!signal.aborted) await pause(opts.intervalMs, signal);
		}
	} finally {
		if (!ready) onReady(false);
	}
};
