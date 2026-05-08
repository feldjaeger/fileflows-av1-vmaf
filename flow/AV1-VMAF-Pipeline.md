# Flow: AV1 VMAF Pipeline

This document describes how to wire the flow inside FileFlows. A skeleton
`av1-vmaf-pipeline.flow.json` is included next to this file as a starting
point, but FileFlows flow JSON is version-sensitive — easiest is to build
it once in the UI and export from there.

## Prerequisites in Flow Settings

Add the following Flow Variables (Settings → Variables) so the function
nodes pick them up. All have sensible defaults but exposing them as
variables makes them tunable per-flow.

| Name                | Default                       | Meaning                                |
|---------------------|-------------------------------|----------------------------------------|
| `FFmpegPath`        | `/opt/ffmpeg-custom/bin/ffmpeg` | overrides ffmpeg binary               |
| `FFprobePath`       | `/opt/ffmpeg-custom/bin/ffprobe`| overrides ffprobe binary              |
| `CQ_SDR`            | `28`                          | starting CQ for SDR encodes            |
| `CQ_HDR`            | `30`                          | starting CQ for HDR10/HDR10+ encodes   |
| `MeanThreshold`     | `95`                          | VMAF mean pass threshold               |
| `P25Threshold`      | `93`                          | VMAF p25 pass threshold                |
| `VMAFModel`         | `version=vmaf_4k_v0.6.1`      | libvmaf model selector                 |
| `VMAFThreads`       | `8`                           | libvmaf thread count                   |
| `SampleSeconds`     | `60`                          | length of each VMAF sample             |
| `MaxEncodeAttempts` | `3`                           | hard-fail after N attempts             |

## Flow shape

```
                ┌─ Input: Video File
                │
                ▼
       [Codec Check: HEVC?]──── no ───────────────────────────► Output: skip
                │ yes
                ▼
       [Resolution: ≥ 2160p?]── no ───────────────────────────► Output: skip
                │ yes
                ▼
       [Function: 01-hdr-detection]
         ├─ port 4 (DV) ──────────► [Tag: "DV-skipped"] ────► Output: skip
         ├─ port 1 (SDR)
         ├─ port 2 (HDR10)
         └─ port 3 (HDR10+ → HDR10)
                │
                ▼ (any of 1/2/3, joined)
       [Function: 02-av1-nvenc-encode]
         ├─ port 2 (encode error) ──► Output: failed
         └─ port 1 (success)
                │
                ▼
       [Function: 03-sample-extraction]
         ├─ port 2 (failed) ──► Output: failed
         └─ port 1
                │
                ▼
       [Function: 04-vmaf-quality-gate]
         ├─ port 1 (Pass) ──► [Replace Original (move)] ──► Output: success
         └─ port 2 (Fail)
                │
                ▼
       [Function: 05-encode-loop-counter]
         ├─ port 1 (Retry) ──► back to [02-av1-nvenc-encode]
         └─ port 2 (Hard-Fail) ─► [Delete encoded temp] ──► [Tag: "VMAF-fail"] ─► Output: keep original
```

## Wiring notes

- The three HDR Detection success ports (1/2/3) all feed into the same
  encode node — the encode node itself reads `Variables.HDRType` to pick
  CQ and HDR signaling.
- The retry edge from the loop counter back into the encode node is a
  real backwards connection in FileFlows; it works because the encode
  node is non-recursive and re-reads `Variables.EncodeAttempts` each pass.
- The "Replace Original" step is FileFlows' built-in **Move File** /
  **Replace Original** node, configured to move the working file to the
  original library location with the original filename (extension forced
  to `.mkv`).
- The "Delete encoded temp" step is the built-in **Delete File** node
  pointed at `Variables.EncodedFile`.

## Codec / resolution gates

These are FileFlows' built-in **Video** flow elements:

- `Video / Video Codec` set to match `hevc` (continue) or no-match (skip)
- `Video / Resolution` set to ≥ `2160p` (UHD)

Both are stock nodes; no custom JS required.

## Known caveat: sample timestamp alignment

`03-sample-extraction.js` uses `-ss <pos> -i <file> -c copy`, which seeks
to the nearest keyframe at-or-before `pos`. HEVC source and AV1 encode
have different GOP structures, so the two samples for one position may
land on slightly different keyframes — and libvmaf compares frame-by-frame
in input order. Mild misalignment (< GOP) tends to cancel out across the
3 × 60 s pool, but a worst-case "ref starts 4 s before dist" sample
will tank the score.

If you see surprising VMAF drops on otherwise visually clean encodes,
switch the extraction to re-encode the samples instead of stream-copy
(slow but frame-accurate). Easiest tweak: replace `-c copy` with
`-c:v libx264 -crf 0 -preset ultrafast` — re-encodes losslessly to a
dummy intermediate, but timestamps are now exact. The libvmaf compare
then runs unaffected.

## Verify checklist

After importing the flow and running on a representative library:

- [ ] HEVC SDR 4K file → encoded, mean VMAF ≥ 95, p25 ≥ 93
- [ ] HEVC HDR10 4K file → encoded, MediaInfo shows BT.2020 / PQ /
      mastering display + maxCLL preserved
- [ ] HEVC HDR10+ 4K file → encoded as HDR10 (dynamic metadata dropped,
      per project decision)
- [ ] DV 4K file → tagged "DV-skipped", original untouched
- [ ] Audio MD5 of encode == audio MD5 of original
      (`ffmpeg -i ... -map 0:a -c copy -f md5 -`)
- [ ] Subtitles bit-identical (PGS preserved in MKV)
- [ ] Forced VMAF failure (set `MeanThreshold=99`) loops 3× then keeps
      original and tags "VMAF-fail"
- [ ] libvmaf_cuda is faster than CPU libvmaf on the same files
      (compare wall-clock with `model=path=/usr/local/share/vmaf/model/...`
      and the CPU `libvmaf` filter)
