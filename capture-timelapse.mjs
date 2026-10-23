#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import axios from "axios";
import dotenv from "dotenv";
import readline from "node:readline";
import { recordVideo, validateVideoAspect } from "./record-video.ts";

const pad = (n, len = 2) => String(n).padStart(len, "0");
const padIndex = (n, len = 6) => String(n).padStart(len, "0");

dotenv.config();

const getDefaultFontPath = () => {
	if (process.platform === "darwin") return "/System/Library/Fonts/Supplemental/Arial.ttf";
	if (process.platform === "win32") return "C:/Windows/Fonts/arial.ttf";
	return "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
};

const formatRunStamp = (d = new Date()) => {
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`; // YYYYMMDD-HHMMSS
};

const formatLocalTimestamp = (d = new Date()) => {
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

// drawtext escaping:
// - ":" -> "\:" because ":" is an option separator in drawtext args
// - "\" -> "\\"
// - "'" -> "\'"
const escapeForDrawText = (s) =>
	s
		.replaceAll("\\", "\\\\")
		.replaceAll(":", "\\:")
		.replaceAll("'", "\\'");

const ffmpegHasFilter = (name) => {
	const res = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
	if (res.error) throw res.error;
	if (res.status !== 0) {
		const err = res.stderr?.trim() || res.stdout?.trim() || `ffmpeg -filters exited with code ${res.status}`;
		throw new Error(err);
	}

	const filterPattern = new RegExp(`^\\s*.{3}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`, "m");
	return filterPattern.test(res.stdout || "");
};

const parseBoolean = (value) => {
	if (typeof value === "boolean") return value;
	if (value == null) return undefined;
	const s = String(value).trim().toLowerCase();
	if (["true", "1", "yes", "y"].includes(s)) return true;
	if (["false", "0", "no", "n"].includes(s)) return false;
	return undefined;
};

const parseNumber = (value) => {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (value == null) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
};

const parseConfigFile = (filePath) => {
	const raw = fs.readFileSync(filePath, "utf8");
	if (path.extname(filePath).toLowerCase() === ".json") {
		const data = JSON.parse(raw);
		if (!data || typeof data !== "object") throw new Error("config JSON must be an object");
		return { type: "json", data };
	}
	return { type: "env", data: dotenv.parse(raw) };
};

const configDisplayName = (filePath, parsed) => {
	if (parsed?.type === "json") {
		const name = parsed.data?.name || parsed.data?.printerName;
		if (typeof name === "string" && name.trim()) return `${path.basename(filePath)} (${name.trim()})`;
	}
	return path.basename(filePath);
};

const listConfigCandidates = () => {
	const roots = [
		path.resolve(process.cwd(), "configs"),
		path.resolve(process.cwd(), "config"),
	];
	const out = [];
	for (const dir of roots) {
		if (!fs.existsSync(dir)) continue;
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (name.endsWith(".json") || name === ".env" || name.startsWith(".env.")) {
				out.push(path.join(dir, name));
			}
		}
	}
	return out;
};

const promptForConfig = (candidates) =>
	new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question("Select a config number: ", (answer) => {
			rl.close();
			const idx = Number(answer);
			if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) {
				resolve(null);
				return;
			}
			resolve(candidates[idx - 1]);
		});
	});

const selectConfig = async (configPaths) => {
	const resolved = configPaths.map((p) => path.resolve(process.cwd(), p));
	const candidates = resolved.length > 0 ? resolved : listConfigCandidates();
	if (candidates.length === 0) return null;
	if (candidates.length === 1) {
		const candidate = candidates[0];
		let label = path.basename(candidate);
		try {
			label = configDisplayName(candidate, parseConfigFile(candidate));
		} catch (err) {
			label = `${path.basename(candidate)} (unreadable)`;
		}
		console.log(`Only one config found; using ${label}`);
		return candidate;
	}

	if (!process.stdin.isTTY) {
		throw new Error("Multiple configs available; rerun in a TTY or pass --config <path>.");
	}

	const parsed = candidates.map((candidate) => {
		try {
			const cfg = parseConfigFile(candidate);
			return { path: candidate, parsed: cfg, label: configDisplayName(candidate, cfg) };
		} catch (err) {
			return { path: candidate, parsed: null, label: `${path.basename(candidate)} (unreadable)` };
		}
	});

	console.log("Available configs:");
	for (let i = 0; i < parsed.length; i++) {
		console.log(`  ${i + 1}) ${parsed[i].label}`);
	}

	const chosen = await promptForConfig(parsed.map((entry) => entry.path));
	if (!chosen) throw new Error("No config selected.");
	return chosen;
};

const applyConfigToOpts = (opts, config) => {
	if (!config) return;
	const setIfDefined = (key, value) => {
		if (value === undefined || value === null || value === "") return;
		opts[key] = value;
	};
	const setBool = (key, value) => {
		const v = parseBoolean(value);
		if (v === undefined) return;
		opts[key] = v;
	};
	const setNumber = (key, value) => {
		const v = parseNumber(value);
		if (v === undefined) return;
		opts[key] = v;
	};

	if (config.type === "json") {
		const data = config.data;
		setIfDefined("url", data.url);
		setIfDefined("baseDir", data.baseDir ? path.resolve(data.baseDir) : undefined);
		setNumber("interval", data.interval);
		setBool("intervalLocked", data.intervalLocked);
		setIfDefined("prefix", data.prefix);
		setIfDefined("ext", data.ext);
		setIfDefined("transport", data.transport);
		setNumber("quality", data.quality);

		setBool("timestamp", data.timestamp);
		setBool("video", data.video);
		setBool("repairRtsp", data.repairRtsp);
		setIfDefined("videoAspect", data.videoAspect);
		setIfDefined("font", data.font);
		setNumber("fontsize", data.fontsize);
		setNumber("padding", data.padding);
		setNumber("boxOpacity", data.boxOpacity);
		setNumber("boxBorder", data.boxBorder);

		setBool("ignoreDecodeErrors", data.ignoreDecodeErrors);
		setIfDefined("loglevel", data.loglevel);

		setIfDefined("prusaLinkIp", data.prusaLinkIp);
		setIfDefined("prusaLinkUrl", data.prusaLinkUrl);
		setIfDefined("prusaLinkApiKey", data.prusaLinkApiKey);
		setIfDefined("statusUrl", data.statusUrl);
		setNumber("statusInterval", data.statusInterval);
		setIfDefined("statusHeader", data.statusHeader);
		setIfDefined("statusPath", data.statusPath);
		setIfDefined("statusDone", data.statusDone);
		setBool("waitForPrinting", data.waitForPrinting);
		setNumber("waitTimeout", data.waitTimeout);
		setIfDefined("captureHeader", data.captureHeader);
		setBool("discoverCamera", data.discoverCamera);
		setBool("probeCamera", data.probeCamera);
		setIfDefined("cameraId", data.cameraId);
		setNumber("cameraIndex", data.cameraIndex);
		setIfDefined("cameraName", data.cameraName);
	} else {
		const data = config.data;
		setIfDefined("url", data.RTSP_URL || data.URL);
		setIfDefined("baseDir", data.BASE_DIR ? path.resolve(data.BASE_DIR) : undefined);
		setNumber("interval", data.INTERVAL);
		setIfDefined("prefix", data.PREFIX);
		setIfDefined("ext", data.EXT);
		setIfDefined("transport", data.TRANSPORT);
		setNumber("quality", data.QUALITY);

		setBool("timestamp", data.TIMESTAMP);
		setBool("video", data.VIDEO);
		setBool("repairRtsp", data.REPAIR_RTSP);
		setIfDefined("videoAspect", data.VIDEO_ASPECT);
		setIfDefined("font", data.FONT);
		setNumber("fontsize", data.FONTSIZE);
		setNumber("padding", data.PADDING);
		setNumber("boxOpacity", data.BOX_OPACITY);
		setNumber("boxBorder", data.BOX_BORDER);

		setBool("ignoreDecodeErrors", data.IGNORE_DECODE_ERRORS);
		setIfDefined("loglevel", data.LOGLEVEL);

		setIfDefined("prusaLinkIp", data.PRUSALINK_IP);
		setIfDefined("prusaLinkUrl", data.PRUSALINK_URL);
		setIfDefined("prusaLinkApiKey", data.PRUSALINK_API_KEY);
		setIfDefined("statusUrl", data.STATUS_URL);
		setNumber("statusInterval", data.STATUS_INTERVAL);
		setIfDefined("statusHeader", data.STATUS_HEADER);
		setIfDefined("statusPath", data.STATUS_PATH);
		setIfDefined("statusDone", data.STATUS_DONE);
		setBool("waitForPrinting", data.WAIT_FOR_PRINTING);
		setNumber("waitTimeout", data.WAIT_TIMEOUT);
		setIfDefined("captureHeader", data.CAPTURE_HEADER);
		setBool("discoverCamera", data.DISCOVER_CAMERA);
		setBool("probeCamera", data.PROBE_CAMERA);
		setIfDefined("cameraId", data.CAMERA_ID);
		setNumber("cameraIndex", data.CAMERA_INDEX);
		setIfDefined("cameraName", data.CAMERA_NAME);
	}
};

const parseArgs = async () => {
	const args = process.argv.slice(2);
	const env = process.env;
	const configPaths = [];
	const overrides = {};
	const out = {
		url: env.RTSP_URL || "rtsp://192.168.1.186/live",
		baseDir: path.resolve(process.cwd(), "snapshots"),
		interval: 10,
		video: false,
		repairRtsp: false,
		videoAspect: null,
		intervalLocked: false,
		prefix: "frame_",
		ext: "jpg",
		transport: "tcp", // tcp|udp
		quality: 2, // 2-31 (lower = better) for JPEG

		timestamp: true,
		font: getDefaultFontPath(),
		fontsize: 24,
		padding: 10,
		boxOpacity: 0.5,
		boxBorder: 6,

		ignoreDecodeErrors: true,
		loglevel: "fatal",

		prusaLinkIp: env.PRUSALINK_IP || null,
		prusaLinkUrl: env.PRUSALINK_URL || null,
		prusaLinkApiKey: env.PRUSALINK_API_KEY || null,

		statusUrl: null,
		statusInterval: 30,
		statusHeader: null,
		statusPath: "printer.state",
		statusDone: "idle,finished,stopped,canceled,error",
		waitForPrinting: true,
		waitTimeout: 0,

		captureHeader: env.CAPTURE_HEADER || null,

		discoverCamera: false,
		probeCamera: true,
		cameraId: null,
		cameraIndex: null,
		cameraName: null,
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const v = args[i + 1];

		if (a === "--config" || a === "-c") {
			if (!v) throw new Error("--config requires a path");
			const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
			configPaths.push(...parts);
			i++;
		}

		else if (a === "--video") overrides.video = true;
		else if (a === "--repair-rtsp") overrides.repairRtsp = v !== "false", i++;
		else if (a === "--video-aspect") overrides.videoAspect = v, i++;
		else if (a === "--url") overrides.url = v, i++;
		else if (a === "--dir") overrides.baseDir = path.resolve(v), i++;
		else if (a === "--interval") overrides.interval = Number(v), overrides.intervalLocked = true, i++;
		else if (a === "--prefix") overrides.prefix = v, i++;
		else if (a === "--ext") overrides.ext = v, i++;
		else if (a === "--transport") overrides.transport = v, i++;
		else if (a === "--quality") overrides.quality = Number(v), i++;

		else if (a === "--timestamp") overrides.timestamp = v !== "false", i++;
		else if (a === "--font") overrides.font = v, i++;
		else if (a === "--fontsize") overrides.fontsize = Number(v), i++;

		else if (a === "--ignoreDecodeErrors") overrides.ignoreDecodeErrors = v !== "false", i++;
		else if (a === "--loglevel") overrides.loglevel = v, i++;

		else if (a === "--prusalink-ip") overrides.prusaLinkIp = v, i++;
		else if (a === "--prusalink-key") overrides.prusaLinkApiKey = v, i++;
		else if (a === "--prusalink-url") overrides.prusaLinkUrl = v, i++;

		else if (a === "--discover-camera") overrides.discoverCamera = v !== "false", i++;
		else if (a === "--probe-camera") overrides.probeCamera = v !== "false", i++;
		else if (a === "--camera-id") overrides.cameraId = v, i++;
		else if (a === "--camera-index") overrides.cameraIndex = Number(v), i++;
		else if (a === "--camera-name") overrides.cameraName = v, i++;

		else if (a === "--status-url") overrides.statusUrl = v, i++;
		else if (a === "--status-interval") overrides.statusInterval = Number(v), i++;
		else if (a === "--status-header") overrides.statusHeader = v, i++;
		else if (a === "--status-path") overrides.statusPath = v, i++;
		else if (a === "--status-done") overrides.statusDone = v, i++;
		else if (a === "--wait-for-printing") overrides.waitForPrinting = v !== "false", i++;
		else if (a === "--wait-timeout") overrides.waitTimeout = Number(v), i++;

		else if (a === "--capture-header") overrides.captureHeader = v, i++;

		else if (!a.startsWith("-")) {
			configPaths.push(a);
		}

		else if (a === "-h" || a === "--help") {
			console.log(`
Usage:
	node capture-timelapse.mjs [options]

Options:
	--video       Record MP4; stop on printer completion when status is configured
	--repair-rtsp true|false (default: false); Buddy3D H.264/TCP packet recovery
	--video-aspect Display ratio such as 16:9 (default: source ratio)
	--config      Path(s) to config files (repeat or comma-separated)
	              (positional config paths are also accepted)
	--url         Input URL (rtsp://... or http(s)://...) (default: rtsp://192.168.1.186/live)
	--dir         Base output folder (default: ./snapshots)
	--interval    Seconds between snapshots (default: 5)
	--prefix      Filename prefix (default: frame_)
	--ext         jpg|png (default: jpg)
	--transport   tcp|udp (default: tcp)
	--quality     JPEG quality 2-31 (default: 2)

Timestamp overlay:
	--timestamp   true|false (default: true)
	--font        Font file path (default: OS-specific)
	--fontsize    Number (default: 24)

Noise/robustness:
	--ignoreDecodeErrors true|false (default: true)
	--loglevel    ffmpeg loglevel (default: fatal)
	Video mode always uses strict decoding, reconnects on errors, and logs at warning level or higher.

PrusaLink (local API):
	--prusalink-ip   Printer IP address (or set PRUSALINK_IP in .env)
	--prusalink-key  API key (or set PRUSALINK_API_KEY in .env)
	--prusalink-url  Base URL (http://host:port) if not using IP

Capture input:
	--capture-header Optional header in "Key: Value" format for the capture URL

PrusaLink camera discovery:
	--discover-camera true|false (default: false)
	--probe-camera    true|false (default: true)
	--camera-id       Camera id to select
	--camera-index    Camera index to select (0-based)
	--camera-name     Camera name to select

Printer status polling:
	--status-url      Status endpoint that returns JSON (default: disabled)
	--status-interval Seconds between polls (default: 30)
	--status-header   Optional header in "Key: Value" format
	--status-path     JSON path to status value (default: printer.state)
	--status-done     Comma list of done values (default: idle,finished,stopped,canceled,error)
	--wait-for-printing true|false (default: true)
	--wait-timeout    Seconds to wait for PRINTING before starting anyway (default: 0 = never)

Controls:
	Press "s" to stop (asks for confirmation).
`);
			process.exit(0);
		}
	}

	const selectedConfig = await selectConfig(configPaths);
	if (selectedConfig) {
		const parsed = parseConfigFile(selectedConfig);
		applyConfigToOpts(out, parsed);
	}
	applyConfigToOpts(out, { type: "json", data: overrides });
	if (out.videoAspect) validateVideoAspect(out.videoAspect);

	if (out.statusUrl && (!Number.isFinite(out.statusInterval) || out.statusInterval <= 0)) {
		throw new Error("--status-interval must be > 0");
	}
	if (out.waitTimeout && (!Number.isFinite(out.waitTimeout) || out.waitTimeout < 0)) {
		throw new Error("--wait-timeout must be >= 0");
	}
	if (!out.statusUrl && (out.prusaLinkIp || out.prusaLinkUrl) && out.prusaLinkApiKey) {
		const baseUrl = out.prusaLinkUrl
			? out.prusaLinkUrl.replace(/\/+$/, "")
			: `http://${out.prusaLinkIp}`;
		out.statusUrl = `${baseUrl}/api/v1/status`;
		out.statusHeader = `X-Api-Key: ${out.prusaLinkApiKey}`;
	}
	return out;
};

const readPath = (obj, pathStr) => {
	if (!pathStr) return obj;
	const parts = pathStr.split(".").flatMap((part) => {
		const segments = [];
		let rest = part;
		while (rest.includes("[")) {
			const before = rest.slice(0, rest.indexOf("["));
			if (before) segments.push(before);
			const idxStart = rest.indexOf("[") + 1;
			const idxEnd = rest.indexOf("]");
			if (idxEnd === -1) break;
			segments.push(rest.slice(idxStart, idxEnd));
			rest = rest.slice(idxEnd + 1);
		}
		if (rest) segments.push(rest);
		return segments;
	});
	let cur = obj;
	for (const key of parts) {
		if (cur == null) return undefined;
		const k = /^[0-9]+$/.test(key) ? Number(key) : key;
		cur = cur[k];
	}
	return cur;
};

const buildStatusHeaders = (opts) => {
	const headers = {};
	const headerValue = opts.statusHeader;
	if (headerValue) {
		const idx = headerValue.indexOf(":");
		if (idx !== -1) {
			const key = headerValue.slice(0, idx).trim();
			const value = headerValue.slice(idx + 1).trim();
			if (key && value) headers[key] = value;
		}
	}
	return headers;
};

const getPrusaLinkBaseUrl = (opts) => {
	if (opts.prusaLinkUrl) return opts.prusaLinkUrl.replace(/\/+$/, "");
	if (opts.prusaLinkIp) return `http://${opts.prusaLinkIp}`;
	return null;
};

const normalizeCameraList = (data) => {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.camera_list)) return data.camera_list;
	if (Array.isArray(data?.cameras)) return data.cameras;
	if (Array.isArray(data?.data)) return data.data;
	return [];
};

const resolveMaybeRelativeUrl = (baseUrl, value) => {
	if (!value) return null;
	if (/^https?:\/\//i.test(value) || /^rtsp:\/\//i.test(value)) return value;
	if (!baseUrl) return value;
	if (!value.startsWith("/")) return `${baseUrl}/${value}`;
	return `${baseUrl}${value}`;
};

const appendQueryParam = (url, key, value) => {
	if (!url || value == null || value === "") return url;
	const sep = url.includes("?") ? "&" : "?";
	return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

const buildSnapshotUrlCandidates = (camera, baseUrl) => {
	const rawCandidates = [
		camera?.snapshot_url,
		camera?.snapshotUrl,
		camera?.snapshot,
		camera?.snapshotURL,
		camera?.urls?.snapshot,
		camera?.endpoints?.snapshot,
		camera?.links?.snapshot,
		camera?.snapshot_path,
	];
	const candidates = [];
	for (const candidate of rawCandidates) {
		const resolved = resolveMaybeRelativeUrl(baseUrl, candidate);
		if (resolved) candidates.push(resolved);
	}

	const id = camera?.camera_id ?? camera?.id ?? camera?.uuid;
	if (id && baseUrl) {
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snapshot`);
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snapshot.jpg`);
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snapshot.png`);
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snap`);
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snap.jpg`);
		candidates.push(`${baseUrl}/api/v1/cameras/${id}/snap.png`);
	}

	const token = camera?.config?.token;
	if (token) {
		const extra = candidates.map((url) => appendQueryParam(url, "token", token));
		candidates.push(...extra);
	}

	return Array.from(new Set(candidates));
};

const getCameraSnapshotUrl = (camera, baseUrl) => {
	const candidates = buildSnapshotUrlCandidates(camera, baseUrl);
	return candidates[0] || null;
};

const probeSnapshotUrl = async (opts, candidates) => {
	const headers = {};
	if (opts.prusaLinkApiKey) headers["X-Api-Key"] = opts.prusaLinkApiKey;
	if (opts.captureHeader) {
		const idx = opts.captureHeader.indexOf(":");
		if (idx !== -1) {
			const key = opts.captureHeader.slice(0, idx).trim();
			const value = opts.captureHeader.slice(idx + 1).trim();
			if (key && value) headers[key] = value;
		}
	}

	for (const url of candidates) {
		try {
			const res = await axios.get(url, {
				headers,
				responseType: "arraybuffer",
				timeout: 8000,
				validateStatus: (status) => status >= 200 && status < 300,
			});
			if (res.status >= 200 && res.status < 300) return url;
		} catch (err) {
			if (err?.response?.status === 404) continue;
		}
	}
	return null;
};

const getCameraInterval = (camera) => {
	const candidates = [
		camera?.interval,
		camera?.snapshot_interval,
		camera?.snapshotInterval,
		camera?.configuration?.interval,
		camera?.configuration?.snapshot_interval,
		camera?.settings?.interval,
		camera?.config?.interval,
	];
	for (const candidate of candidates) {
		const n = parseNumber(candidate);
		if (n !== undefined) return n;
	}
	const trigger = camera?.config?.trigger_scheme;
	if (typeof trigger === "string") {
		const match = trigger.match(/([0-9]+)\s*SEC/i);
		if (match) {
			const n = Number(match[1]);
			if (Number.isFinite(n) && n > 0) return n;
		}
		const wordMap = {
			ONE: 1,
			TWO: 2,
			THREE: 3,
			FIVE: 5,
			TEN: 10,
			FIFTEEN: 15,
			TWENTY: 20,
			THIRTY: 30,
			SIXTY: 60,
		};
		const wordMatch = trigger.match(/([A-Z]+)_SEC/i);
		if (wordMatch && wordMap[wordMatch[1]]) return wordMap[wordMatch[1]];
	}
	return null;
};

const cameraDisplayName = (camera, index) => {
	const name = camera?.name || camera?.title || camera?.config?.name;
	const id = camera?.camera_id ?? camera?.id ?? camera?.uuid;
	if (name && id !== undefined) return `${name} (id ${id})`;
	if (name) return name;
	if (id !== undefined) return `Camera ${id}`;
	return `Camera ${index + 1}`;
};

const promptForCamera = (cameras) =>
	new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question("Select a camera number: ", (answer) => {
			rl.close();
			const idx = Number(answer);
			if (!Number.isFinite(idx) || idx < 1 || idx > cameras.length) {
				resolve(null);
				return;
			}
			resolve(cameras[idx - 1]);
		});
	});

const selectCamera = async (opts, cameras) => {
	if (opts.cameraIndex != null) {
		const idx = Number(opts.cameraIndex);
		if (Number.isFinite(idx) && idx >= 0 && idx < cameras.length) return cameras[idx];
	}
	if (opts.cameraId != null) {
		const id = String(opts.cameraId);
		const match = cameras.find((camera) => String(camera?.camera_id ?? camera?.id ?? camera?.uuid) === id);
		if (match) return match;
	}
	if (opts.cameraName) {
		const name = String(opts.cameraName).toLowerCase();
		const match = cameras.find((camera) => String(camera?.name ?? camera?.title ?? "").toLowerCase() === name);
		if (match) return match;
	}
	if (cameras.length === 1) return cameras[0];
	if (!process.stdin.isTTY) return cameras[0];

	console.log("Available cameras:");
	for (let i = 0; i < cameras.length; i++) {
		console.log(`  ${i + 1}) ${cameraDisplayName(cameras[i], i)}`);
	}
	const chosen = await promptForCamera(cameras);
	if (!chosen) throw new Error("No camera selected.");
	return chosen;
};

const discoverPrusaLinkCamera = async (opts) => {
	if (!opts.discoverCamera) return;
	const baseUrl = getPrusaLinkBaseUrl(opts);
	if (!baseUrl) throw new Error("discoverCamera requires prusaLinkIp or prusaLinkUrl");
	if (!opts.prusaLinkApiKey) throw new Error("discoverCamera requires prusaLinkApiKey");

	const res = await axios.get(`${baseUrl}/api/v1/cameras`, {
		headers: { "X-Api-Key": opts.prusaLinkApiKey },
		timeout: 10000,
	});
	const cameras = normalizeCameraList(res.data);
	if (cameras.length === 0) {
		console.log("⚠️  No cameras found on PrusaLink");
		console.log("Queried URL:", `${baseUrl}/api/v1/cameras`);
		console.log("Response data:", JSON.stringify(res.data, null, 2));
		throw new Error("No cameras returned from PrusaLink")
	};

	const camera = await selectCamera(opts, cameras);
	const candidates = buildSnapshotUrlCandidates(camera, baseUrl);
	const snapshotUrl = opts.probeCamera ? await probeSnapshotUrl(opts, candidates) : candidates[0] || null;
	if (!snapshotUrl) throw new Error("Selected camera has no snapshot URL");

	opts.url = snapshotUrl;
	if (!opts.captureHeader) {
		opts.captureHeader = `X-Api-Key: ${opts.prusaLinkApiKey}`;
	}

	const interval = getCameraInterval(camera);
	if (interval != null && interval > 0 && !opts.intervalLocked) {
		opts.interval = interval;
	}
	opts.cameraInfo = {
		id: camera?.camera_id ?? camera?.id ?? camera?.uuid ?? null,
		name: camera?.name ?? camera?.title ?? camera?.config?.name ?? null,
		interval,
		url: snapshotUrl,
	};
};

const formatDuration = (totalSeconds) => {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
	const s = Math.round(totalSeconds);
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	const seconds = s % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

const formatEtaTime = (remainingSeconds) => {
	if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) return null;
	const eta = new Date(Date.now() + remainingSeconds * 1000);
	return `${String(eta.getHours()).padStart(2, "0")}:${String(eta.getMinutes()).padStart(2, "0")}`;
};

const buildDrawTextFilter = (opts) => {
	const fontExists = opts.font && fs.existsSync(opts.font);
	const fontPart = fontExists ? `fontfile=${opts.font}:` : "";

	const stamp = opts.video
		? "%{localtime}"
		: escapeForDrawText(formatLocalTimestamp());

	return {
		filter:
			"drawtext=" +
			fontPart +
			`text='${stamp}':` +
			`x=${opts.padding}:y=${opts.padding}:` +
			`fontsize=${opts.fontsize}:` +
			"fontcolor=white:" +
			"box=1:" +
			`boxcolor=black@${opts.boxOpacity}:` +
			`boxborderw=${opts.boxBorder}`,
		fontExists,
	};
};

const fetchStatusData = async (opts, signal) => {
	const headers = buildStatusHeaders(opts);
	const res = await axios.get(opts.statusUrl, { headers, timeout: 10000, signal });
	return res.data;
};

const fetchJobData = async (opts) => {
	const baseUrl = getPrusaLinkBaseUrl(opts);
	if (!baseUrl || !opts.prusaLinkApiKey) return null;

	const headers = { "X-Api-Key": opts.prusaLinkApiKey };
	try {
		const res = await axios.get(`${baseUrl}/api/v1/job`, { headers, timeout: 10000 });
		return res.data;
	} catch (err) {
		console.error(`⚠️  job fetch failed: ${err?.message ?? "(no error message)"}`);
		return null;
	}
};

const run = async () => {
	const opts = await parseArgs();
	if (opts.video && !process.stdin.isTTY) {
		throw new Error("--video requires an interactive terminal for stop confirmation.");
	}
	if (opts.video && opts.discoverCamera) {
		throw new Error("--video requires a video stream URL; disable snapshot discovery with --discover-camera false and pass --url.");
	}

	if (opts.discoverCamera) {
		try {
			await discoverPrusaLinkCamera(opts);
			if (opts.cameraInfo) {
				const details = [
					opts.cameraInfo.name ? `name: ${opts.cameraInfo.name}` : null,
					opts.cameraInfo.id != null ? `id: ${opts.cameraInfo.id}` : null,
					opts.cameraInfo.interval != null ? `interval: ${opts.cameraInfo.interval}s` : null,
				].filter(Boolean);
				console.log(`📷 PrusaLink camera selected (${details.join(", ")})`);
			}
		} catch (err) {
			console.error(`❌ camera discovery failed: ${err?.message ?? err}`);
			process.exit(1);
		}
	}

	if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
		throw new Error("--interval must be > 0");
	}

	if (opts.timestamp) {
		try {
			if (!ffmpegHasFilter("drawtext")) {
				console.log("⚠️  ffmpeg does not include the drawtext filter; disabling timestamp overlay.");
				console.log("   Install an ffmpeg build with drawtext support, or pass --timestamp false to silence this warning.");
				opts.timestamp = false;
			}
		} catch (err) {
			console.log(`⚠️  Could not inspect ffmpeg filters: ${err?.message ?? err}`);
			console.log("   Continuing with timestamp overlay enabled.");
		}
	}

	const runDir = path.join(opts.baseDir, formatRunStamp());
	fs.mkdirSync(runDir, { recursive: true });
	if (opts.video) {
		const printer = opts.statusUrl ? {
			readState: async (signal) => readPath(await fetchStatusData(opts, signal), opts.statusPath),
			intervalMs: opts.statusInterval * 1000,
			doneStates: opts.statusDone.split(","),
			waitForPrinting: opts.waitForPrinting,
			waitTimeoutMs: opts.waitTimeout * 1000,
		} : undefined;
		await recordVideo(opts, runDir, opts.timestamp ? buildDrawTextFilter(opts).filter : null, printer);
		return;
	}

	let statusSnapshot = null;
	if (opts.statusUrl) {
		try {
			const resData = await fetchStatusData(opts);
			statusSnapshot = {
				fetchedAt: new Date().toISOString(),
				url: opts.statusUrl,
				path: opts.statusPath,
				data: resData,
			};
		} catch (err) {
			console.error(`⚠️  initial status fetch failed: ${err?.message ?? "(no error message)"}`);
			console.error(err);
		}
	}

	const writeMetaFile = (jobInfo = null) => {
		fs.writeFileSync(
			path.join(runDir, "_timelapse_meta.json"),
			JSON.stringify(
				{
					createdAt: new Date().toISOString(),
					url: opts.url,
					intervalSeconds: opts.interval,
					prefix: opts.prefix,
					ext: opts.ext,
					timestampOverlay: opts.timestamp,
					font: opts.font,
					transport: opts.transport,
					status: opts.statusUrl
						? {
								url: opts.statusUrl,
								path: opts.statusPath,
								intervalSeconds: opts.statusInterval,
								doneStates: opts.statusDone.split(",").map((v) => v.trim()).filter(Boolean),
								initialSnapshot: statusSnapshot,
							}
						: null,
					job: jobInfo,
				},
				null,
				2
			) + "\n"
		);
	};

	writeMetaFile();

	let index = 1;
	let running = true;
	let capturing = false;
	let wantStop = false;
	let warnedFontMissing = false;
	let statusTimer = null;
	let jobInfoCaptured = false;

	const takeSnapshot = () =>
		new Promise((resolve, reject) => {
			const filename = `${opts.prefix}${padIndex(index)}.${opts.ext}`;
			const outFile = path.join(runDir, filename);

			const isRtsp = typeof opts.url === "string" && opts.url.startsWith("rtsp://");
			const ffmpegArgs = [
				"-hide_banner",
				"-loglevel",
				opts.loglevel,

				// Helps some RTSP streams (safe / common)
				"-probesize",
				"32M",
				"-analyzeduration",
				"3M",
			];

			if (opts.ignoreDecodeErrors) {
				ffmpegArgs.push("-fflags", "+discardcorrupt", "-err_detect", "ignore_err");
			}

			if (opts.captureHeader) {
				const headerLine = opts.captureHeader.endsWith("\r\n")
					? opts.captureHeader
					: `${opts.captureHeader}\r\n`;
				ffmpegArgs.push("-headers", headerLine);
			}

			if (isRtsp) {
				ffmpegArgs.push("-rtsp_transport", opts.transport);
			}

			ffmpegArgs.push("-i", opts.url, "-an");

			if (opts.timestamp) {
				const { filter, fontExists } = buildDrawTextFilter(opts);
				if (!fontExists && !warnedFontMissing) {
					warnedFontMissing = true;
					console.log(`⚠️  Font not found at: ${opts.font}`);
					console.log("   Continuing without explicit fontfile. If drawtext fails, pass --font /path/to/font.ttf");
				}
				ffmpegArgs.push("-vf", filter);
			}

			ffmpegArgs.push("-frames:v", "1");

			if (opts.ext === "jpg" || opts.ext === "jpeg") {
				ffmpegArgs.push("-q:v", String(opts.quality));
			}

			ffmpegArgs.push("-y", outFile);

			const p = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
			p.on("error", reject);
			p.on("exit", (code) => (code === 0 ? resolve(outFile) : reject(new Error(`ffmpeg exited with code ${code}`))));
		});

	const captureSnapshotStatus = async () => {
		if (!opts.statusUrl) return;
		try {
			const statusData = await fetchStatusData(opts);
			const statusFilename = `${opts.prefix}${padIndex(index)}_status.json`;
			const statusFile = path.join(runDir, statusFilename);
			fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2) + "\n");
		} catch (err) {
			console.error(`⚠️  status capture failed: ${err?.message ?? "(no error message)"}`);
		}
	};

	const stopNow = () => {
		running = false;
		clearInterval(timer);
		if (statusTimer) clearInterval(statusTimer);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		console.log("Stopped.");
		console.log(`Snapshots saved in: ${runDir}`);
		process.exit(0);
	};

	const loop = async () => {
		if (!running || capturing) return;
		capturing = true;

		try {
			await captureSnapshotStatus();
			const outFile = await takeSnapshot();
			// console.log(`✅ ${now.toLocaleTimeString()} 💾 ${path.basename(outFile)}`);
			console.log(`✅ ${formatLocalTimestamp(new Date())} 💾 ${path.basename(outFile)}`);
			index++;
		} catch (err) {
			console.error(`❌ snapshot failed: ${err?.message ?? err}`);
		} finally {
			capturing = false;
			if (wantStop) stopNow();
		}
	};

	console.log(`Capturing every ${opts.interval}s to: ${runDir}`);
	console.log(`Timestamp overlay: ${opts.timestamp ? "on" : "off"}`);
	console.log(`Press "s" to stop (with confirmation).`);

	if (opts.statusUrl && opts.waitForPrinting) {
		console.log("Waiting for printer status to switch to PRINTING...");
		const startedAt = Date.now();
		for (;;) {
			try {
				const data = await fetchStatusData(opts);
				const value = readPath(data, opts.statusPath);
				const stamp = formatLocalTimestamp(new Date());
				if (value === undefined) {
					console.log(`🖨️  ${stamp} status: (missing at ${opts.statusPath})`);
				} else {
					console.log(`🖨️  ${stamp} status: ${String(value)}`);
				}
				if (typeof value === "string" && value.toLowerCase() === "printing") {
					// Capture job info when printing starts
					const jobData = await fetchJobData(opts);
					if (jobData) {
						console.log(`📋 Job info captured: ${jobData.file?.display_name ?? jobData.file?.name ?? "unknown"}`);
						jobInfoCaptured = true;
						writeMetaFile(jobData);
					}
					break;
				}
			} catch (err) {
				console.error(`❌ status check failed: ${err?.message ?? err}`);
			}
			if (opts.waitTimeout > 0 && Date.now() - startedAt >= opts.waitTimeout * 1000) {
				console.log("Wait timeout reached. Starting capture...");
				break;
			}
			await new Promise((r) => setTimeout(r, opts.statusInterval * 1000));
		}
	}

	const timer = setInterval(loop, opts.interval * 1000);
	await loop();

	if (opts.statusUrl) {
		const doneSet = new Set(opts.statusDone.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
		const checkStatus = async () => {
			if (!running) return;
			try {
				const data = await fetchStatusData(opts);
				const value = readPath(data, opts.statusPath);
				const stamp = formatLocalTimestamp(new Date());

				// Capture job info if printer is PRINTING and we haven't captured it yet
				if (!jobInfoCaptured && typeof value === "string" && value.toLowerCase() === "printing") {
					const jobData = await fetchJobData(opts);
					if (jobData) {
						console.log(`📋 Job info captured: ${jobData.file?.display_name ?? jobData.file?.name ?? "unknown"}`);
						jobInfoCaptured = true;
						writeMetaFile(jobData);
					}
				}

				if (value === undefined) {
					console.log(`🖨️  ${stamp} status: (missing at ${opts.statusPath})`);
				} else {
					let suffix = "";
					if (typeof value === "string" && value.toLowerCase() === "printing") {
						const progress = data?.job?.progress;
						const timePrinting = data?.job?.time_printing;
						const timeRemaining = data?.job?.time_remaining;
						const elapsed = formatDuration(timePrinting);
						const remaining = formatDuration(timeRemaining);
						const eta = formatEtaTime(timeRemaining);
						if (elapsed) suffix += ` elapsed ${elapsed}`;
						if (remaining) suffix += `, remaining ${remaining}`;
						if (eta) suffix += `, ETA ${eta}`;
						if (typeof progress === "number" && Number.isFinite(progress)) {
							suffix += `${suffix ? " " : ""}(${progress.toFixed(2)}%)`;
						}
					}
					console.log(`🖨️  ${stamp} status: ${String(value)}${suffix}`);
				}
				if (typeof value === "string" && doneSet.has(value.toLowerCase())) {
					const finishedAt = formatLocalTimestamp(new Date()).slice(11, 16);
					console.log(`Printer status "${value}" detected at ${finishedAt}. Stopping capture...`);
					wantStop = true;
					if (!capturing) stopNow();
				}
			} catch (err) {
				console.error(`❌ status check failed: ${err?.message ?? err}`);
			}
		};

		console.log(`Status polling: ${opts.statusUrl} (${opts.statusInterval}s)`);
		statusTimer = setInterval(checkStatus, opts.statusInterval * 1000);
		await checkStatus();
	}

	if (process.stdin.isTTY) {
		process.stdin.setEncoding("utf8");
		process.stdin.setRawMode(true);
		process.stdin.resume();

		let confirming = false;

		process.stdin.on("data", (key) => {
			if (!running) return;

			if (key === "\u0003") {
				console.log("\nCtrl+C");
				stopNow();
				return;
			}

			if (!confirming && (key === "s" || key === "S")) {
				confirming = true;
				process.stdout.write("\nStop capturing? (y/N) ");
				return;
			}

			if (confirming) {
				const k = key.trim().toLowerCase();
				if (k === "y") {
					wantStop = true;
					process.stdout.write("\nStopping...\n");
					if (!capturing) stopNow();
				} else {
					process.stdout.write("\nContinuing.\n");
				}
				confirming = false;
			}
		});
	}
};

run().catch((err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
