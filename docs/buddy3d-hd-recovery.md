# Buddy3D HD stream and recovery investigation — 2026-10-23

## Finding

HD also produces truncated RTSP/TCP media blocks with a single direct socket client and no FFmpeg, decoding, or re-encoding. Reading faster does not request extra camera frames. The camera sends a live stream; draining it promptly reduces receiver backpressure. Throttling reads can fill buffers, and FFmpeg specifically warns against low input read rates for live streams.

The receiver's offline HD decode/encode benchmark ran at 27.1 times real time with the recorder's single-threaded decoder and encoding settings (30 seconds of media in 1.106 seconds). This establishes processing capacity in that test, not the absence of every scheduling or disk stall during a print.

Camera-side buffer pressure or an incorrect partial-write implementation remains a plausible explanation. Camera CPU, memory, temperature, and internal send buffers were not measured. No camera shell was enabled and no firmware was modified.

## Direct HD transport tests

Tests were sequential, with no other local FFmpeg/VLC process or existing camera TCP connection found before the first test. Both used the configured camera URL, one camera session, and the same existing diagnostic scripts. No network or camera settings were changed.

| Check | Result |
| --- | --- |
| TCP, 180.916 seconds including setup/teardown | About 2.28 Mbit/s, 24.16 frame markers/s; strict boundary checker found one truncated block. |
| Concrete TCP failure | Packet 44147 declared 1,456 RTP bytes but contained only 633. Packet 44148 followed with the same SSRC and timestamp, 823 bytes before the declared end. The defect occurred around 139.8 seconds after starting the probe. |
| Parser consequence | The original diagnostic parser lost alignment and skipped 65 otherwise parseable packets while recovering. That count is not TCP network packet loss. |
| UDP, 181.401 seconds including setup/teardown | 44,280 received RTP packets; six missing across five sequence gaps, about 0.0135% of the observed sequence span. Five unfinished fragment assemblies. No TCP-style framing defect. |

UDP avoids the malformed TCP length boundary but still loses parts of H.264 pictures. The sequential tests were not under identical radio/motion conditions and do not establish a permanent transport winner. The earlier Full HD UDP test had much higher loss; it must not be substituted for this HD measurement.

The camera identifies its RTSP server as `rtsp_demo`. SDP advertises one H.264 video track and the same stale parameter set previously observed after the HD switch. RTP media contained in-band 720p parameter sets.

## Recovery mode

`--repair-rtsp true` enables a bounded local TCP relay for the observed Buddy3D H.264 profile. It validates packet headers against payload type, SSRC, and sequence evidence, drops truncated packets and damaged access units, and discards dependent pictures until a complete IDR is available. It preserves video RTP timestamps. Separately sent SPS/PPS parameter sets are supplied with the resumed IDR's timestamp and immediately preceding sequence numbers; replaying their old timestamps would introduce artificial discontinuities.

This keeps the existing camera session alive through recoverable framing faults. It does not reconstruct missing bytes. Buffer limits bound memory; strict decoding, the no-frame watchdog, and full reconnection remain fallbacks for undetected corruption or persistent failure. This is opt-in and restricted to unauthenticated H.264 payload type 96 on interleaved channels 0/1.

MPEG-TS's normal FFmpeg timestamp correction closes gaps above ten seconds. Recovery mode increases that correction threshold to one hour; the 15-second recovery watchdog is much shorter. A dedicated test verifies that a twelve-second interruption within one connection retains its full duration and all 50 intact pictures.

The saved three-minute TCP capture was replayed through the recovery parser. Its damaged block was detected, strict H.264 decoding produced no error output, and the longest interval between forwarded pictures was 1.6277 seconds. The same capture was replayed through a local RTSP fixture, the relay, the MPEG-TS stage, and strict decoder/encoder: exit 0, 4,305 forwarded access units, one truncation handled without restarting the RTSP session. Some access units contain only parameters rather than decoded pictures. These are controlled replays of one captured failure, not a full-print reliability result.

Initial live iterations exposed separate parameter-set startup and timestamp problems in the new relay. Those iterations were not accepted as successful validation.

Final integrated live validation, 21:18:15–21:21:15 local:

- Capture/finalization took 180.427 seconds; final MP4 is 1280×720, 177.840 seconds, 3,070 decoded pictures. The timeline starts after initial keyframe acquisition.
- One camera connection, no reconnects, 146 detected truncated packets, 13 complete-IDR forwarding events including startup, and no downstream decoder error lines.
- Full strict decode of the final MP4 exited 0 with no error output. Packet presentation timestamps increased throughout.
- Twelve intervals between pictures exceeded 0.5 seconds; their sum was 47.92 seconds and the longest was 8.44 seconds. The total includes normal picture duration at the boundaries. Thus the mode does **not** deliver freeze-free HD under these conditions; it keeps the session alive and cleanly resumes when intact data returns.
- The same initial saved fault was also replayed through the original chain without the relay for a controlled comparison. That chain failed strict decoding, whereas the repaired replay completed. This establishes recovery of that fault, not a general reduction in camera-side fault frequency.

The mode remains opt-in. The user's camera config was not automatically changed. A lower camera-side source rate/bitrate or SD comparison is needed to investigate source pressure further. Reducing output FPS on the receiving computer would not perform that experiment.

## Hardware and frame rate

Prusa documents HD local RTSP streaming at approximately 25 fps. An independent CORE One camera project reports Rockchip RV1103 (ARM Cortex-A7), Linux, and very limited free RAM. Rockchip documents a hardware H.264/H.265 encoder supporting 4 MP at 30 fps. The specific hardware revision in this user's unit was not inspected. This is not evidence of a measured CPU overload, nor a guarantee that the vendor's software keeps up under every load.

Dropping output FPS, scaling in FFmpeg, or reducing output CRF does not reduce camera encoding or Wi-Fi traffic. Lower source FPS/bitrate would need camera-side support. The documented Prusa settings and observed SDP did not establish a configurable source FPS/bitrate control.

## SD follow-up

The user confirms that a microSD card is installed but the camera's own timelapse is disabled, and that the app offers resolution choices only, not FPS or bitrate. The user selected SD before the follow-up probes at approximately 23:45 local on 2026-10-23. In-band video parameters verify 640×480. The SD setting was changed by the user; neither camera firmware nor Wi-Fi configuration was changed by the agent.

In the initial SD sample, IDR NAL units averaged approximately 25.4 kB, compared with 68.3 kB in the earlier HD direct capture. P-picture NAL units were also smaller. These are sequential samples from different times, not a controlled measurement of the same moving scene. Smaller pictures reduce bursts and average traffic, but changing resolution also changes camera processing, so software, CPU, and network-pressure explanations remain confounded.

The six-minute direct SD test completed in 360.841 seconds including setup/teardown. It received 22,617 RTP packets (27,517,826 RTP bytes), approximately 0.610 Mbit/s: about 73% less than the earlier HD direct test. Reassembled media contained 8,703 VCL picture NAL units; RTP marker counts also include separately marked parameter sets and are not the same as picture counts. There were zero sequence gaps, truncated TCP blocks, resynchronization events, unfinished H.264 fragment assemblies, or source timestamp intervals over the probe's 0.1-second threshold. Five arrival pauses exceeded 0.3 seconds; the largest was 0.444 seconds, without packet loss. Full strict decoding from the first in-band parameter sets completed with exit 0 and no error output.

This extends the earlier short HD validation window, but it remains a stationary-camera test at a later time of day. The previous UniFi snapshots were not refreshed for this comparison and must not be treated as measurements of the SD test's radio conditions.

The subsequent standard-recorder SD test ran at 23:51:58–23:57:58 local, with `repairRtsp: false` and TCP. Capture/finalization took 360.490 seconds. It used one camera connection with no reconnects and no downstream decoding errors. The final MP4 is 640×480, 357.972 seconds after initial keyframe acquisition, with 8,637 decoded pictures. Full strict decoding exited 0 with an empty error log. Presentation timestamps increased throughout; no interval exceeded 0.5 seconds, and the longest interval/picture duration was 0.124 seconds. The final picture duration was 0.041 seconds, so the result did not conceal an extended trailing hold. Six minute-spaced rendered samples showed no obvious block corruption.

The standard source probe still logged initial macroblock warnings from the stale SDP parameters, before the first received keyframe. There were no further source warnings after that keyframe and no downstream macroblock errors. These startup warnings did not appear as corrupted recorded pictures.

Together these are approximately twelve minutes of sequential SD testing with no observed transport corruption or long video holds. SD is the best currently verified setting for the next print, using the normal `npm run capture-coreone -- --video` command, without enabling the repair relay. The camera remains in the user's selected SD mode; its config file was not changed. A complete moving-print test is still needed. The evidence supports source-load/buffer pressure as a trigger, but does not distinguish camera CPU, memory, sender implementation, and changing radio conditions. It does not establish that HD itself has been fixed.

SD test evidence is under `/tmp/prusa-stream-diagnosis/sd-tcp-1/` and `/tmp/prusa-rtsp-repair/sd-integrated/`. All camera test connections were closed afterward.

## Aspect-ratio correction and return to HD — 2026-10-24

The user correctly reported that the SD picture was horizontally compressed. The earlier visual review missed the incorrect proportions. The SD file is 640×480 with no usable sample/display aspect ratio, so players show a 4:3 picture even though the scene is wide. The returned HD stream is verified as 1280×720. Comparing the images shows the same wide scene compressed into the SD raster, rather than a 4:3 crop.

A `videoAspect` config option / `--video-aspect` override now supplies the desired display ratio. It is set to 16:9 in the user's local Core One config. Encoding an SD frame gives sample aspect ratio 4:3 and display aspect ratio 16:9; HD gives sample aspect ratio 1:1 and display aspect ratio 16:9. An FFmpeg test verifies these through encoding and final MP4 assembly, including frame preservation and composition with another video filter. The generic default remains the source ratio.

The original SD test file was preserved. A corrected copy at `/tmp/prusa-rtsp-repair/sd-integrated/recording-16x9.mp4` updates container and H.264 aspect metadata without re-encoding. Its dimensions remain 640×480 and duration remains 357.972 seconds. No lower camera resolution or data rate is required just to correct the display ratio. See [FFmpeg's aspect correction guidance](https://github.com/FFmpeg/FFmpeg/blob/master/doc/faq.texi).

The user switched back to HD before a new direct TCP test starting around 00:07 local. In 361.054 seconds including setup/teardown, the diagnostic parser received 68,742 RTP packets and approximately 2.073 Mbit/s. The stricter boundary checker found ten truncated blocks and one additional resynchronization event. The first malformed-framing observations occurred around 68.7 seconds. Packet 60116 declared 1,456 bytes but had only 789 before the next sequential packet with the same SSRC. The diagnostic parser's four observed sequence gaps include losses of alignment and must not be interpreted as a TCP network loss count.

Thus returning to HD reproduced the same wire-level fault without FFmpeg. The scene remained stationary. The HD test was later than the SD test, so resolution, camera processing, sender pressure, and radio conditions are still not isolated causal variables. Evidence is under `/tmp/prusa-stream-diagnosis/hd-return-tcp/`.

An additional six-minute HD recording ran at approximately 00:13:40–00:19:40 local, with the recovery relay and explicit 16:9 display ratio. Capture/finalization took 360.338 seconds. The final MP4 is 1280×720, sample aspect ratio 1:1, display aspect ratio 16:9, 358.600 seconds after initial keyframe acquisition, and 8,424 decoded pictures. Full strict decoding exited 0 with no error output. Presentation timestamps increased throughout, no interval exceeded 0.5 seconds, and the longest interval/picture duration was 0.085 seconds. The final picture duration was 0.042 seconds. Six minute-spaced rendered samples showed intact pictures and the correct wide proportions.

The recording used one camera connection with no reconnects, no downstream decoding errors, and no detected truncated packets. The relay was enabled, but no recovery beyond initial IDR acquisition was needed, so this clean window cannot be attributed to its repair behavior. The adjacent direct test's ten wire-level faults still demonstrate intermittent HD failures. Neither a full moving print nor permanent HD reliability has been established.

HD recording evidence is under `/tmp/prusa-rtsp-repair/hd-return-integrated/`. All camera test connections were closed afterward. The camera remains in the user's selected HD mode. The local config now sets `videoAspect` to `16:9`; `repairRtsp` remains disabled by default. To repeat the exact tested recording mode, pass `--repair-rtsp true`.

The corrected SD copy passed full strict decoding with an empty error log, and all packet presentation timestamps and durations match the original exactly. Eleven automated video tests passed, including the new SD/HD aspect-ratio encode-and-assemble check. No production dependencies were added.

## Coverage and Limitations

- Collection: 2026-10-23, Europe/Stockholm, about 21:02–21:06 for the UniFi snapshots and the first TCP probe. These are current follow-up observations, not historical measurements of the earlier print.
- UniFi camera lookup: available; IP substring filter `192.168.1.186`, limit 10, one result returned and matched exactly. Details and Wi-Fi queries: available for that one MAC. Reported signal −63 dBm, noise −96 dBm, channel 1/20 MHz, rate fields 72.2/39 Mbit/s, power saving disabled, association uptime approximately 6.8 days. PHY rates are not measured usable throughput; AP/client rate directions are not interchangeable.
- AP radio query: available for the camera's recorded AP `ap-closet-u7-pro`; three radio rows returned, 2.4 GHz row selected. Channel utilization 43%, 27 clients, AP counters 813 retries/7,009 transmitted packets. Camera client data reported 9.5% Wi-Fi transmit retries. Neither counter isolates camera-to-AP video loss, and the tool did not supply a timestamp for each counter window. No overall network-health conclusion follows.
- Camera internals and print-time radio history: unavailable in this investigation. No CPU, memory, send-buffer, temperature, or power measurements. No firmware version was read directly; 3.1.6 remains user-reported.
- Temporary packet captures, replay scripts, logs, and benchmark output: `/tmp/prusa-stream-diagnosis/hd-followup-*`, `/tmp/prusa-rtsp-repair/`, and `/tmp/prusa-print-review/`. Recordings can contain private camera images; these temporary files were not added to Git.

## Sources

- [Prusa Buddy3D documentation](https://help.prusa3d.com/article/buddy3d-camera_821264)
- [FFmpeg input read-rate documentation](https://ffmpeg.org/ffmpeg-all.html#Main-options)
- [CORE One camera hardware investigation](https://github.com/tlchandler/Improved-Buddy3D-Camera-for-Prusa-CORE-One)
- [Rockchip RV1103 specifications](https://www.rock-chips.com/a/cn/product/RV11xilie/2022/0926/1662.html)
- [Independent go2rtc truncated-packet reproduction](https://github.com/AlexxIT/go2rtc/issues/2574): analogous behavior on a different camera, not proof of the Buddy3D firmware implementation.
