# HD print recording review — 2026-10-23

## Result

Reviewed `snapshots/20261023-185700/recording.mp4` and its `recording.log`. The final MP4 decodes successfully, but the recording is not continuous motion: reconnection gaps are retained as held pictures. HD did not resolve the intermittent stream failures over this full run.

| Measurement | Result |
| --- | --- |
| Video | H.264, 1280×720, 104,483 frames |
| MP4 duration | 6,615.510 seconds (1:50:15.510) |
| Full strict decode | Exit 0; no decoding errors |
| Non-increasing packet presentation timestamps | 0 |
| Intervals between pictures longer than 0.5 seconds | 190 |
| Sum of those intervals | 2,014.09 seconds, about 33.5 minutes |
| Longest interval | 46.628 seconds, from video time 43:30.064 to 44:16.692 |
| Camera connection attempts | 204 (203 reconnects) |
| Attempts producing no usable video packets | 14 |

The interval total includes the ordinary frame duration at each boundary; it is a measure of long held-picture intervals, not an exact count of lost source frames. The recording timeline starts at the first received keyframe and retains elapsed reconnection time. It does not recover missing motion.

Strict decoding examined the entire final file. Visual inspection covered 110 minute-spaced pictures and the before/after pictures at the six longest gaps. No obvious macroblock corruption appeared in these samples. This does not certify every frame against visual defects already encoded by the camera.

## Recording log

The log uses UTC (`Z`); local time was UTC+2. Capture started at 18:57:00 local and stopped manually at 20:47:18. The log contains no printer status history, so it cannot establish the exact print completion time.

- 153 attempts ended with the generic stream-ended/decoding-failed reason, 50 with the no-new-complete-frames watchdog reason, and one with manual stopping. These are stop reasons, not independent fault counts: watchdog cases can also contain decoder errors.
- 178 attempts contain explicit downstream H.264 macroblock decoding errors, with 190 such error lines. For example, the first connection receives a keyframe at 18:57:02.874, then reports `P sub_mb_type 6 out of range`, `error while decoding MB 46 22`, and `Invalid data found when processing input` before ending at 18:58:10.576. This is beyond initial source probing.
- 75 RTSP warnings report `CSeq ... expected, 0 received`. CSeq identifies a control request/reply, not a video frame. These warnings show a reply-sequence mismatch as parsed by FFmpeg; they do not prove that the camera rebooted or count missing video packets. See [FFmpeg's RTSP parser](https://ffmpeg.org/doxygen/trunk/rtsp_8c_source.html).
- At connection 96, after the first-keyframe event at 19:54:26.119, the source reports `RTP: PT=60: bad cseq 2400 expected=8e6d`, followed by a control CSeq warning and a downstream macroblock failure. An RTP sequence failure is distinct from a control CSeq mismatch. It does not quantify packet loss in this TCP stream.
- Connections 88 and 92 report `Failed reading RTSP data: Operation timed out`; neither produces usable video packets.
- Three downstream messages report an invalid NALU header. Two source startup sequences also report unset packet timestamps and corrected non-monotonic DTS. The final MP4 presentation timestamps nevertheless increase throughout.
- Numerous `source:` macroblock warnings happen while probing a new connection. The earlier diagnosis found stale Full HD parameter sets in the camera's SDP after switching to HD. Such startup warnings must be distinguished from errors in the downstream `decoder:` that records from a complete keyframe.

The evidence establishes damaged/unusable input at the decoder and intermittent RTSP reception trouble. The log alone does not isolate camera firmware, the transport path, or receiver parsing as the root cause of this run. Earlier direct-socket Full HD tests found truncated TCP media blocks; that finding is not a direct packet capture of this HD run.

The terminal's `File ended prematurely` warning arose during final assembly from temporary Matroska parts. Some interrupted processes required forced termination and may leave incomplete container tails. The temporary parts were removed after successful assembly, so their tails cannot now be checked separately. The final MP4 passed full strict decoding; the warning is not evidence that the resulting MP4 is undecodable.

## Recorder fixes

The previous video branch returned before the snapshot path's printer-status polling. That is why it never detected completion. Video mode now monitors the configured status endpoint independently of reconnects, waits for PRINTING by default, and stops/finalizes on a configured done state after observing PRINTING. Initial IDLE, pauses, missing state, and transient request failures do not end a job. Default polling is every 30 seconds.

Console reconnect messages now begin with a local timestamp: `2026-10-23 20:12:39 Video interrupted; reconnecting.`

Validation includes the existing four FFmpeg recovery/timeline tests, HTTP lifecycle integration tests against a local Postman simulation, and the real interactive capture command using a local video fixture. The CLI observed IDLE → PRINTING → PRINTING → FINISHED, stopped automatically, and saved an MP4. Actual completion detection against the physical printer remains to be verified on a subsequent print. These changes do not fix the upstream HD stream failures.

The original video and log were preserved. Temporary analysis files and contact sheets are under `/tmp/prusa-print-review/`.
