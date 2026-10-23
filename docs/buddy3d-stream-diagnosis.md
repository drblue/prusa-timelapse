# Buddy3D stream diagnosis — 2026-10-23

## Finding

The 1920×1080 stream was damaged before video encoding in this project. A separate RTSP/TCP client, implemented with Node's socket API and no FFmpeg RTSP receiver, captured truncated interleaved RTP packets. UDP avoided the TCP framing problem but lost too many packets to provide intact continuous video.

After the user changed the camera to HD, the source was verified as 1280×720. A minute-long direct TCP capture had no packet-sequence gaps, truncated blocks, or incomplete fragment assemblies. A subsequent continuous recording passed 120 seconds with strict decoding, no reconnects, and no clipped intervals. This demonstrates a working lower-load configuration in the tested windows; it does not establish the camera's internal failure mechanism or prove full-print reliability.

**Full-print follow-up:** the subsequent HD recording did fail intermittently: 204 connection attempts and 190 long held-picture intervals totaling about 33.5 minutes. Its final MP4 decoded without errors, but continuous motion was not preserved. See the [full review](hd-print-review-20261023.md), including RTSP sequence warnings and reception timeouts in `recording.log`.

**Further investigation:** a new direct-socket HD capture also reproduced a truncated TCP block without FFmpeg. An opt-in receiver recovery mode now resynchronizes and waits for a complete IDR on the existing session. See [the HD recovery investigation](buddy3d-hd-recovery.md) for transport measurements, source-load limits, and validation.

## Observations

The user reports camera firmware **3.1.6**. VLC was open during the original blocky recording, but all live viewers were closed throughout the diagnostic session. The single-consumer diagnostic failures therefore cannot be explained solely by concurrent VLC playback. A local process/connection check also found no active VLC process or existing RTSP connection to the camera before the follow-up test.

| Check | Result |
| --- | --- |
| Offline decode of the same earlier raw recording | FFmpeg 5.1.2 and 9.0.1 both reported 28 macroblock decoding errors and 8 corrupt decoded frames. |
| Direct TCP capture, about 60 seconds | 26,746 parsed RTP packets; 172 framing/resynchronization events; 27 unfinished fragment assemblies. |
| Concrete TCP framing failure | RTP packet sequence 11799 declared a 1,456-byte payload. The next valid packet header, sequence 11800 with the same SSRC, appeared after only 1,067 payload bytes. The following packet, sequence 11801, was correctly positioned relative to 11800. The first packet was short by 389 bytes. |
| Direct UDP capture, about 60 seconds | 25,851 packets received, 29,483 expected from the sequence span, 3,632 missing (12.32%). No duplicate sequence numbers or TCP-style framing errors. Datagram size was at most 1,456 bytes. A 4 MiB UDP receive buffer was requested successfully. |
| Follow-up TCP capture with a larger buffer | A separate Python socket client verified an actual 4,194,304-byte TCP receive buffer and received approximately 41.76 MB over 60.06 seconds. A stricter packet-boundary checker identified 63 truncated blocks, including sequence 12380 declaring 1,456 payload bytes but containing only 1,036 before the next valid sequential packet. Increasing the receiving buffer did not eliminate the failure. |
| HD direct TCP capture, about 60 seconds | Verified 1280×720; 11,948 RTP packets, 1,464 frame markers; zero sequence gaps, truncated blocks, resynchronization events, incomplete fragments, or arrival/frame gaps over the probe's thresholds. Received RTP traffic averaged about 2.15 Mbit/s. |
| HD continuous recording, 120-second target | Strict decoder exited successfully; 2,811 recorded frames, 119.96-second output, largest timestamp interval 0.08 seconds, no non-increasing timestamps, reconnects, or decoder errors. Full output decoded successfully with strict error detection; sampled rendered pictures were intact. The process ran for 121.684 seconds including startup. |
| Integrated HD recorder | A separate 35-second manual-stop simulation finished successfully using a single connection, producing 786 frames and a 33.4-second video after startup. |
| Camera stream traffic | Approximately 5 Mbit/s of received RTP traffic; this is an average, not a peak bitrate measurement. |
| Short ping | 20 requests, 20 replies; min/average/max 3.9/25.5/58.1 ms. This does not establish loss-free delivery under video load. |
| Camera Wi-Fi | 2.4 GHz, channel 1, 20 MHz; signal around −61 dBm, reported noise −96 dBm; association uptime around 6.7 days. |
| AP radio snapshot | 27 clients, channel utilization 57%, AP-reported retry percentage 9.8%. These are radio-level observations, not measurements of camera-to-AP packet loss. |
| Recording computer | The receiving source IP maps to a wired client in UniFi. |

TCP sequence discontinuities reported after a framing error are **parser observations**, not a reliable count of network packet loss. The parser can skip otherwise valid packets while searching for framing again. The UDP loss figure was calculated separately from the entire sequence span, accounting for sequence-number wraparound and checking for duplicates.

A follow-up boundary checker searched for the next packet with the same SSRC and the immediately succeeding sequence number inside each declared block. It identified 64 truncated blocks in the original direct TCP capture. This is a different measurement from the original parser's 172 framing/resynchronization events. It excludes the incomplete tail of a capture and does not count that tail as a truncated block.

The TCP parser received some malformed media data and the UDP parser discarded incomplete NAL units while reconstructing H.264. Decoding those reconstructed files alone therefore cannot demonstrate a clean, complete stream.

## Interpretation

RTSP interleaving specifies a length for each binary block. H.264 FU-A fragments must be reassembled completely and in sequence. Missing bytes damage the current picture and can affect dependent pictures until a decoder refresh/keyframe arrives.

The shortened TCP block is consistent with a camera sender failing to finish a partial socket write when buffers fill. This is a **hypothesis**, not a verified inspection of the camera firmware. Radio contention, retransmission delays, competing camera consumers, or source load could trigger buffer pressure. Signal-strength percentage alone cannot distinguish those possibilities.

The evidence does not support treating this as an FFmpeg 9-only decoder regression or solving it solely by changing the MP4 encoding quality. UDP is not currently a satisfactory workaround.

The follow-up result also excludes a larger receiver-side TCP buffer as a sufficient fix under the tested conditions. Source firmware 3.1.6 still produced truncated interleaved packets with a single confirmed viewer. VLC may have increased load during the original recording, but concurrent playback is not necessary to reproduce the fault.

HD removed transport failures in the short follow-up tests. This supports a source-load/transport-pressure explanation, but changing resolution reduces both camera processing and network traffic, so those causes remain confounded.

## Startup metadata and recorder changes

After the HD switch, RTSP DESCRIBE still supplied the previous Full HD SPS parameter set. Actual in-band SPS units described 1280×720. A direct strict-decoding attempt failed before recording its first picture. The HD stream itself subsequently remained intact once a complete in-band keyframe was available.

RTSP recording now uses a stream-copy MPEG-TS stage that starts at a keyframe, followed by strict decoding/encoding with the current in-band parameters. It retains packet timestamps and opens one camera connection. The source probe can still report warnings about initial incomplete pictures; they are excluded from the downstream decoder's recording.

If a future RTSP interruption requires reconnection, assembly now retains elapsed gap time and trailing outage time by extending picture display times without re-encoding. This produces a held last intact picture during missing intervals. The timeline starts at the first received keyframe; receive buffering and source clock drift limit alignment precision. It does not recreate missing motion.

The automated tests cover a stream joined mid-GOP, strict recovery from damaged frames, an eight-second timeline containing two one-second clips with reconnect/trailing holds, and stopping during recovery.

## Next controlled test

1. Completed: user reports firmware 3.1.6 and confirms no other live viewer during diagnosis. Keep this single-consumer condition for subsequent comparisons.
2. Completed: the user selected HD and the actual 720p stream passed the short TCP/recording tests. Scaling the received image in FFmpeg would not reduce source traffic.
3. Completed: the full HD print recording was reviewed. It still suffers intermittent H.264 errors and reconnections; see the follow-up report linked above.
4. If failures recur, compare radio conditions or camera placement separately before considering AP configuration changes.
5. For a Full HD investigation, provide Prusa support with the truncation example and firmware/hardware versions. No message has been sent externally.

A short continuous HD recording is verified. The later full-print run demonstrates that HD alone is insufficient for reliable long-running recording.

## Coverage and limitations

Collection date: 2026-10-23, Europe/Stockholm (CEST).

- Direct TCP test: camera response time 18:16:03, roughly 60 seconds. Direct UDP test: 18:18:09–18:19:10. Tests were sequential. Raw socket data, reconstructed streams, probe scripts, and JSON reports are under `/tmp/prusa-stream-diagnosis/`; they are temporary local evidence, not committed camera recordings.
- Follow-up HD tests were sequential with a single camera connection. The user changed the camera mode; no Wi-Fi or firmware settings were changed by the agent. These brief test windows cannot establish reliability over an entire print or rule out intermittent load-related errors.
- UniFi: available for current camera/AP snapshots. Camera search returned 1 of 1 match with limit 10. The receiving-computer IP substring search returned 3 matches with limit 10; the exact IP match was selected and was wired.
- Client history: requested the preceding hour at 5-minute granularity; 12 rows returned. Per-row timestamps were absent, so those rows were not used for exact correlation with media errors.
- AP raw data included an older nested historical statistics object dated 2026-09-18. That object was excluded from current-state conclusions. The current radio snapshot did not expose a per-measurement timestamp.
- Ping was a short, separate 20-packet test. No claim of overall network health follows from it.
- Camera firmware is user-reported as 3.1.6; competing viewers during diagnosis were excluded by the user's confirmation. Hardware version, internal CPU/buffer state, and camera-side packet logs remain unknown. The user changed the camera's video mode from Full HD to HD for the follow-up test; no firmware or Wi-Fi configuration was changed.

## Protocol references

- [RTSP 1.0 binary interleaving, RFC 2326 §10.12](https://www.rfc-editor.org/rfc/rfc2326.html#section-10.12)
- [TCP service model, RFC 9293 §2.2](https://www.rfc-editor.org/rfc/rfc9293.html#section-2.2)
- [H.264 RTP fragmentation, RFC 6184 §5.8](https://datatracker.ietf.org/doc/html/rfc6184#section-5.8)
