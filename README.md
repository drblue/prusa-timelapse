# Prusa Timelapse

Simple RTSP snapshot capture plus timelapse assembly for Prusa prints.

## Setup

1) Install dependencies

```bash
npm install
```

2) Ensure `ffmpeg` is available in your PATH.

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

### Capture options

```
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
- Use `--transport udp` if your RTSP stream is flaky over TCP.
