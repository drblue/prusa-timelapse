import assert from "node:assert/strict";
import { test } from "node:test";
import { recordVideo } from "../record-video.ts";

test("video refuses to start without printer status before opening the terminal or camera", async () => {
	await assert.rejects(recordVideo({ url: "rtsp://camera.invalid/live", transport: "tcp", loglevel: "warning" }, "/unused"),
		/printer status endpoint/i);
});
