import net from "node:net";

// Opt-in H.264/TCP recovery for the Buddy3D's truncated interleaved packets.
// Missing pictures are discarded through the next complete IDR; RTP timestamps
// are retained so an outage never speeds up the recording.
export class H264TcpRepair {
	private pending = Buffer.alloc(0);
	private ssrc: number | undefined;
	private sequence: number | undefined;
	private timestamp: number | undefined;
	private frame: Buffer[] = [];
	private frameBytes = 0;
	private bad = false;
	private idr = false;
	private fragment: number | undefined;
	private waiting = true;
	private parameters = new Map<number, Buffer>();
	readonly stats = { truncated: 0, skippedBytes: 0, droppedFrames: 0, forwardedFrames: 0, recoveries: 0 };

	private emit: (packet: Buffer) => void;
	private event: (message: string) => void;
	constructor(emit: (packet: Buffer) => void, event: (message: string) => void = () => {}) {
		this.emit = emit; this.event = event;
	}

	private header(offset: number) {
		const b = this.pending;
		if (offset + 16 > b.length || b[offset] !== 36 || b[offset + 1] !== 0) return false;
		const size = b.readUInt16BE(offset + 2);
		return size >= 12 && b[offset + 4] === 128 && (b[offset + 5] & 127) === 96
			&& (this.ssrc === undefined || b.readUInt32BE(offset + 12) === this.ssrc);
	}

	private damage() { this.waiting = true; this.bad = true; }

	private resetFrame() {
		this.frame = []; this.frameBytes = 0; this.bad = false; this.idr = false; this.fragment = undefined;
	}

	private video(packet: Buffer) {
		const rtp = packet.subarray(4);
		const seq = rtp.readUInt16BE(2), timestamp = rtp.readUInt32BE(4);
		if (this.sequence !== undefined && seq !== ((this.sequence + 1) & 65535)) this.damage();
		this.sequence = seq;
		if (this.timestamp !== undefined && this.timestamp !== timestamp) {
			if (this.frame.length) { this.stats.droppedFrames++; this.waiting = true; }
			this.resetFrame();
		}
		this.timestamp = timestamp;
		this.frame.push(packet); this.frameBytes += packet.length;
		// Bound memory even when a broken sender omits marker bits indefinitely.
		if (this.frameBytes > 8 * 1024 * 1024) throw new Error("RTSP frame exceeds repair buffer limit");
		let offset = 12 + (rtp[0] & 15) * 4;
		if (rtp[0] & 16) {
			if (offset + 4 > rtp.length) { this.damage(); return; }
			offset += 4 + rtp.readUInt16BE(offset + 2) * 4;
		}
		const end = rtp.length - (rtp[0] & 32 ? rtp.at(-1)! : 0);
		const payload = rtp.subarray(offset, end), type = payload[0] & 31;
		if (offset >= end || end > rtp.length) this.damage();
		else if (type >= 1 && type <= 23) {
			if (this.fragment !== undefined) this.damage();
			if (type === 7 || type === 8) this.parameters.set(type, packet);
			this.idr ||= type === 5;
		} else if (type === 28 && payload.length >= 2) {
			const inner = payload[1] & 31, start = Boolean(payload[1] & 128), finish = Boolean(payload[1] & 64);
			if (start) {
				if (this.fragment !== undefined || finish || inner < 1 || inner > 23) this.damage();
				this.fragment = inner; this.idr ||= inner === 5;
			} else if (this.fragment !== inner) this.damage();
			if (finish) this.fragment = undefined;
		} else if (type === 24) {
			let p = 1;
			while (p + 2 <= payload.length) {
				const size = payload.readUInt16BE(p); p += 2;
				if (!size || p + size > payload.length) { this.damage(); break; }
				this.idr ||= (payload[p] & 31) === 5; p += size;
			}
			if (p !== payload.length || this.fragment !== undefined) this.damage();
		} else this.damage();
		if (rtp[1] & 128) {
			if (this.fragment !== undefined) this.damage();
			if (!this.bad && (!this.waiting || this.idr)) {
				if (this.waiting) {
					this.stats.recoveries++; this.event("Complete IDR received; forwarding video on the existing RTSP connection.");
					const parameters = [...this.parameters.values()].filter((p) => !this.frame.includes(p));
					const firstSequence = this.frame[0].readUInt16BE(6);
					for (const [i, parameter] of parameters.entries()) {
						const copy = Buffer.from(parameter);
						copy[5] &= 127; // Parameter sets belong to the resumed IDR's access unit.
						copy.writeUInt16BE((firstSequence - parameters.length + i) & 65535, 6);
						copy.writeUInt32BE(timestamp, 8);
						this.emit(copy);
					}
				}
				this.waiting = false;
				for (const part of this.frame) this.emit(part);
				this.stats.forwardedFrames++;
			} else this.stats.droppedFrames++;
			this.resetFrame();
		}
	}

	push(chunk: Buffer) {
		this.pending = Buffer.concat([this.pending, chunk]);
		if (this.pending.length > 2 * 1024 * 1024) throw new Error("RTSP repair input exceeds buffer limit");
		while (this.pending.length >= 4) {
			const b = this.pending;
			if (b.subarray(0, 4).toString() === "RTSP") {
				const end = b.indexOf("\r\n\r\n");
				if (end < 0) return;
				const size = Number(b.subarray(0, end).toString().match(/\r\nContent-Length:\s*(\d+)/i)?.[1] || 0);
				if (b.length < end + 4 + size) return;
				this.emit(b.subarray(0, end + 4 + size)); this.pending = b.subarray(end + 4 + size); continue;
			}
			if (b[0] === 36 && b[1] === 1) {
				const end = 4 + b.readUInt16BE(2);
				if (b.length < end) return;
				this.emit(b.subarray(0, end)); this.pending = b.subarray(end); continue;
			}
			if (this.header(0)) {
				this.ssrc ??= b.readUInt32BE(12);
				const end = 4 + b.readUInt16BE(2), seq = b.readUInt16BE(6);
				// A sequential packet with the same SSRC inside the advertised
				// payload proves that this interleaved block was cut short.
				let nested = b.indexOf(Buffer.from([36, 0]), 16);
				while (nested >= 0 && nested < end) {
					if (this.header(nested) && b.readUInt16BE(nested + 6) === ((seq + 1) & 65535)) break;
					nested = b.indexOf(Buffer.from([36, 0]), nested + 1);
				}
				if (nested >= 0 && nested < end && this.header(nested)) {
					this.stats.truncated++; this.stats.skippedBytes += nested;
					this.damage(); this.event(`Truncated RTP packet ${seq}: declared ${end - 4}, received ${nested - 4} bytes; waiting for a complete IDR.`);
					this.pending = b.subarray(nested); continue;
				}
				// Keep enough lookahead to catch a header split across socket reads.
				if (b.length < end + 16) return;
				this.video(b.subarray(0, end)); this.pending = b.subarray(end); continue;
			}
			// Retain the last 15 bytes until another read can validate a header.
			if (b.length < 16) return;
			this.damage(); this.stats.skippedBytes++; this.pending = b.subarray(1);
		}
	}

	finish() {
		// At EOF only a whole, verified final packet can be considered.
		if (this.header(0) && this.pending.length === 4 + this.pending.readUInt16BE(2)) this.video(this.pending);
		this.pending = Buffer.alloc(0);
	}
}

// This deliberately supports the observed Buddy3D profile only: H.264 PT 96,
// interleaved video/RTCP channels 0/1. Other cameras keep FFmpeg's normal path.
export const createRepairProxy = async (url: string, event: (message: string) => void, trace?: (chunk: Buffer) => void) => {
	const target = new URL(url);
	if (target.protocol !== "rtsp:" || target.username || target.password) throw new Error("Buddy3D RTSP repair requires an unauthenticated rtsp:// URL");
	const remoteOrigin = `${target.protocol}//${target.host}`;
	let localOrigin: string;
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		const upstream = net.createConnection({ host: target.hostname, port: Number(target.port || 554) });
		sockets.add(client); sockets.add(upstream);
		const fail = (error: Error) => { event(`RTSP repair proxy: ${error.message}`); client.destroy(); upstream.destroy(); };
		client.on("error", fail); upstream.on("error", fail);
		client.once("close", () => { upstream.destroy(); sockets.delete(client); });
		upstream.once("close", () => { client.destroy(); sockets.delete(upstream); });
		let requests = Buffer.alloc(0);
		client.on("data", (chunk) => {
			requests = Buffer.concat([requests, chunk]);
			while (requests.length >= 4) {
				if (requests[0] === 36) {
					const size = 4 + requests.readUInt16BE(2);
					if (requests.length < size) return;
					upstream.write(requests.subarray(0, size)); requests = requests.subarray(size); continue;
				}
				const end = requests.indexOf("\r\n\r\n");
				if (end < 0) { if (requests.length > 65536) fail(new Error("Oversized RTSP request")); return; }
				const header = requests.subarray(0, end).toString();
				const size = Number(header.match(/\r\nContent-Length:\s*(\d+)/i)?.[1] || 0);
				if (requests.length < end + 4 + size) return;
				upstream.write(header.replaceAll(localOrigin, remoteOrigin) + "\r\n\r\n");
				if (size) upstream.write(requests.subarray(end + 4, end + 4 + size));
				requests = requests.subarray(end + 4 + size);
			}
		});
		const repair = new H264TcpRepair((packet) => {
			if (packet.subarray(0, 4).toString() === "RTSP") {
				const end = packet.indexOf("\r\n\r\n");
				const body = packet.subarray(end + 4).toString().replaceAll(remoteOrigin, localOrigin);
				if (/^m=video /m.test(body) && !/^a=rtpmap:96 H264\/90000\r?$/m.test(body)) {
					fail(new Error("Buddy3D RTSP repair requires H.264 payload type 96")); return;
				}
				let header = packet.subarray(0, end).toString().replaceAll(remoteOrigin, localOrigin);
				if (/\r\nContent-Length:/i.test(header)) header = header.replace(/(\r\nContent-Length:)\s*\d+/i, `$1 ${Buffer.byteLength(body)}`);
				client.write(header + "\r\n\r\n" + body);
			} else client.write(packet);
			if (client.writableLength > 8 * 1024 * 1024) fail(new Error("Video consumer fell behind repair buffer"));
		}, event);
		upstream.on("data", (chunk) => { try { trace?.(chunk); repair.push(chunk); } catch (error) { fail(error as Error); } });
		upstream.once("end", () => { repair.finish(); event(`RTSP repair summary: ${JSON.stringify(repair.stats)}`); client.end(); });
	});
	server.on("error", () => {});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address() as net.AddressInfo;
	const local = new URL(url); local.hostname = "127.0.0.1"; local.port = String(address.port);
	localOrigin = `${local.protocol}//${local.host}`;
	return { url: local.href, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
};
