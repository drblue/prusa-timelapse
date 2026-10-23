// Postman's mock runtime requires CommonJS. No real printer credentials are used.
const http = require("node:http");
const sequences = {
	finished: ["IDLE", "PRINTING", "PAUSED", "PRINTING", "FINISHED"],
	"completed-idle": ["IDLE", "PRINTING", "IDLE"],
	canceled: ["IDLE", "PRINTING", "CANCELED"],
	idle: ["IDLE", "IDLE", "IDLE"],
	recovery: ["IDLE", "http-error", "missing", "PRINTING", "PAUSED", "FINISHED"],
	error: ["PRINTING", "ERROR"],
	immediate: ["IDLE", "PRINTING", "FINISHED"],
	timeout: ["IDLE", "IDLE", "IDLE", "PRINTING", "FINISHED"],
	"cli-finished": ["IDLE", "PRINTING", "PRINTING", "FINISHED"],
};
http.createServer(async (req, res) => {
	res.setHeader("Content-Type", "application/json");
	const url = new URL(req.url, "http://localhost");
	if (req.method !== "GET" || url.pathname !== "/api/v1/status") {
		res.writeHead(501); res.end(JSON.stringify({ error: "Endpoint not modeled" })); return;
	}
	if (req.headers["x-api-key"] !== "test-printer-key") {
		res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return;
	}
	const scenario = url.searchParams.get("case") || "finished";
	const key = `printer-status:${scenario}:${url.searchParams.get("run") || "default"}`;
	const index = (await pm.state.get(key)) || 0;
	await pm.state.set(key, index + 1);
	const sequence = sequences[scenario] || sequences.finished;
	const state = sequence[Math.min(index, sequence.length - 1)];
	if (state === "http-error") { res.writeHead(503); res.end(JSON.stringify({ error: "Test outage" })); return; }
	// Shape matches api-responses/status-response when printing.json.
	res.writeHead(200);
	res.end(JSON.stringify({ printer: state === "missing" ? {} : { state } }));
}).listen(process.env.PORT || 4901);
