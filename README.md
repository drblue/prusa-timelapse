# Prusa Timelapse

Simple RTSP snapshot capture plus timelapse assembly for Prusa prints.

## Setup

1) Install dependencies

```bash
npm install
```

2) Ensure `ffmpeg` is available in your PATH.

Use Node.js 22.18+ (or 24+) for the TypeScript video recorder. Video mode also requires `ffprobe`, included with FFmpeg.

3) Create a `.env` file (or edit the existing one):

```env
PRUSALINK_IP=192.168.1.124
PRUSALINK_API_KEY=your_api_key_here
RTSP_URL=rtsp://192.168.1.186/live
```

## Capture snapshots

```bash
npm run capture
# or
node capture-timelapse.mjs
```

Each run creates a timestamped folder under `snapshots/` with images and `_timelapse_meta.json`.

### Record continuous video

```bash
npm run capture-coreone -- --video
# Or select a stream explicitly:
npm run capture -- --config configs/coreone.json --video --url rtsp://192.168.1.186/live
```

Records `recording.mp4` in a timestamped folder under `snapshots/`. Press `s`, then `y` to confirm stopping; any other key cancels the stop request while recording continues. Wait for the saved-file message before closing the terminal. Ctrl+C also finishes the video gracefully.

Video mode uses strict decoding and automatically reconnects after a decoding error. It also reconnects if no new encoded frames arrive for five seconds (15 seconds are allowed for initial probing and the first keyframe). Each connection starts with fresh decoder references; recording resumes when a decodable keyframe arrives. TCP remains the default RTSP transport.

RTSP input is first remuxed, without re-encoding, from a complete keyframe into MPEG-TS. Strict decoding then uses the current in-band video parameters. This handles the Buddy3D camera advertising stale Full HD parameters after switching to HD. Source probing may log startup warnings; these initial incomplete pictures are excluded from the recorded video. Only one connection is opened to the camera.

Usable parts are saved in `recording-parts/` and joined into `recording.mp4` without another quality loss when capture stops. For RTSP, the timeline begins at the first received keyframe. Reconnection gaps and a trailing outage retain their elapsed time by holding the last intact picture; missing motion cannot be recovered. Reception times determine the offsets, with buffering and camera timestamp drift limiting their precision. Other input types retain the previous part-joining behavior. If assembly fails, the parts remain available. Diagnostics and reconnection events are saved in `recording.log`, with the camera URL and capture header value redacted. Video mode ignores `ignoreDecodeErrors` and raises quiet/fatal log levels to `warning` so errors can be diagnosed. Snapshot capture keeps its existing settings.

This prevents detected decoding failures from being deliberately concealed and recorded as blocky frames. It cannot recover missing camera data or detect every visual defect already encoded by the camera. Persistent errors require investigating the source stream, camera connection, or camera firmware.

When a printer status endpoint is configured, video mode respects `--wait-for-printing`, `--wait-timeout`, `--status-interval`, and `--status-done`. By default it waits for PRINTING, then finishes the MP4 when a done state is observed. Initial IDLE does not count as a completed print; automatic stopping is armed only after PRINTING has been observed. Paused prints, missing status values, and failed status requests keep the recording running. The default polling interval is 30 seconds, so completion detection can take that long plus the request time. Without a status endpoint, stopping is manual. Reconnect messages begin with the local date and time, for example `2026-10-23 20:12:39 Video interrupted; reconnecting.`

Video mode requires an interactive terminal and a continuous video stream (such as RTSP or HTTP video); a PrusaLink still-image endpoint cannot provide continuous video. Disable snapshot discovery with `--discover-camera false` when using a config that enables it. Timestamp overlays show the current local time. Audio is not recorded. Config files can also enable this mode with `"video": true` (JSON) or `VIDEO=true` (env).

### Capture options

```
--video       Record MP4 video; stop on printer completion when status is configured
--config      Path(s) to config files (repeat or comma-separated)
--url         Input URL (rtsp://... or http(s)://...) (default: rtsp://192.168.1.186/live)
--dir         Base output folder (default: ./snapshots)
--interval    Seconds between snapshots (default: 5)
--prefix      Filename prefix (default: frame_)
--ext         jpg|png (default: jpg)
--transport   tcp|udp (default: tcp)
--quality     JPEG quality 2-31 (default: 2)

--timestamp   true|false (default: true)
--font        Font file path (default: OS-specific)
--fontsize    Number (default: 24)

--ignoreDecodeErrors true|false (default: true)
--loglevel    ffmpeg loglevel (default: fatal)

--prusalink-ip   Printer IP address (or set PRUSALINK_IP in .env)
--prusalink-key  API key (or set PRUSALINK_API_KEY in .env)
--prusalink-url  Base URL (http://host:port) if not using IP

--capture-header Optional header in "Key: Value" format for the capture URL

--discover-camera true|false (default: false)
--camera-id       Camera id to select
--camera-index    Camera index to select (0-based)
--camera-name     Camera name to select

--status-url      Status endpoint that returns JSON (default: disabled)
--status-interval Seconds between polls (default: 30)
--status-header   Optional header in "Key: Value" format
--status-path     JSON path to status value (default: printer.state)
--status-done     Comma list of done values (default: idle,finished,stopped,canceled,error)
--wait-for-printing true|false (default: true)
--wait-timeout    Seconds to wait for PRINTING before starting anyway (default: 0 = never)
```

Notes:
- If `PRUSALINK_IP` and `PRUSALINK_API_KEY` are set, the script polls `http://<ip>/api/v1/status` automatically and stops on done status.
- While printing, the status log includes progress percentage, elapsed time, remaining time, and ETA.
- Timestamp overlays require ffmpeg's `drawtext` filter. If your ffmpeg build does not include it, capture continues with the overlay disabled.
- For PrusaLink webcam snapshots, set `--url` to the snapshot endpoint and pass `--capture-header "X-Api-Key: <key>"`.
- When `--discover-camera` is enabled, the capture URL is pulled from PrusaLink and the snapshot interval is updated from the camera's configured interval (unless `--interval` is provided).

### Config files

You can store capture settings in JSON or `.env` files under `./configs` or `./config`. Pass configs with `--config` (or as positional paths). If you pass multiple, the script prompts you to choose. If you omit configs and multiple exist, it will also prompt.

#### i3 MK3S+ with USB web camera

Example `configs/mk3s.json`:

USB Web camera connected to Raspberry Pi running PrusaLink.

```json
{
  "name": "MK3S+ PrusaLink (Pi camera)",
  "prusaLinkIp": "192.168.1.191",
  "prusaLinkApiKey": "YOUR_PRUSALINK_KEY",
  "discoverCamera": true,
  "timestamp": true
}
```

#### CoreOne+ with Buddy3D camera

Example `configs/coreone.json`:

Buddy3D camera connected over wifi.

```json
{
  "name": "CoreOne+ Buddy3D (RTSP)",
  "url": "rtsp://192.168.1.186/live",
  "transport": "tcp",
  "prusaLinkIp": "192.168.1.124",
  "prusaLinkApiKey": "YOUR_PRUSALINK_KEY",
  "timestamp": true
}
```

Example usage:

```bash
node capture-timelapse.mjs --config configs/mk4.json,configs/mk3s-prusalink.json
```

## Make a timelapse video

```bash
npm run make
# or
node make-timelapse.mjs
```

The script prompts you to select a capture folder and choose speed, FPS, and quality.

### Make options

```
--dir        Base snapshots folder (default: ./snapshots)
--pattern    Input pattern (default: frame_%06d.jpg)
--out        Output file (default: auto-generated in snapshots/)
--recursive  Search subfolders (default: true)
```

## Tips

- Press `s` during capture to stop (with confirmation).
- Prefer TCP for RTSP video. UDP can lose packets and should only be used if a comparison with the specific camera shows better results.
- For the tested Buddy3D camera running firmware 3.1.6, HD (1280×720) passed the short continuous-recording tests; Full HD produced truncated packets. See [the measured results and limitations](docs/buddy3d-stream-diagnosis.md). Set the mode in the camera itself; scaling in FFmpeg does not reduce camera traffic.

## Tests

Run `npm test` with FFmpeg and ffprobe installed. The video tests verify joining mid-GOP at a complete keyframe, recovery from damaged H.264, preservation of gap/trailing-outage time, and stopping during a reconnect.
