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
--url         RTSP url (default: rtsp://192.168.1.186/live)
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
