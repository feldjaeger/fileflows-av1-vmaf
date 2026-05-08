# fileflows-av1-vmaf

FileFlows pipeline for **4K HEVC → AV1 NVENC** re-encoding with a
custom **libvmaf_cuda** quality gate. Uses an external custom-ffmpeg
build (see [`feldjaeger/ffmpeg-vmaf-cuda`](https://github.com/feldjaeger/ffmpeg-vmaf-cuda))
mounted into the FileFlows worker via a named volume.

No FileFlows Pro / VMAF-Pro features are used — quality measurement and
the loop-on-fail logic are implemented entirely as Function nodes.

## Repo layout

```
compose/
  docker-compose.yml      FileFlows + oneshot ffmpeg-init service
  .env.example
functions/
  01-hdr-detection.js     SDR / HDR10 / HDR10+ / DV detector
  02-av1-nvenc-encode.js  av1_nvenc encode w/ HDR signaling
  03-sample-extraction.js 3 × 60s reference / distorted samples
  04-vmaf-quality-gate.js libvmaf_cuda → mean / p25 / harmonic
  05-encode-loop-counter.js  retry / hard-fail
flow/
  AV1-VMAF-Pipeline.md    flow shape, wiring, verify checklist
  av1-vmaf-pipeline.flow.json  skeleton, export over from your UI
```

## Design decisions

- **Volume-mount pattern** (not a custom FileFlows image). A oneshot
  init container copies the custom ffmpeg + libvmaf + codec libs onto
  a named volume that FileFlows mounts read-only at `/opt/ffmpeg-custom`.
  Survives FileFlows updates because we never modify the FileFlows image.
- **GPL + nonfree build** of ffmpeg — `--enable-cuda-nvcc` requires
  `--enable-nonfree`, so the resulting binary is not redistributable
  under GPL terms (build it yourself, or pull from a personal-use
  registry). Audio is always copy-passthrough so we don't need
  libfdk-aac.
- **HDR10+ is downgraded to HDR10**. av1_nvenc has no dynamic-metadata
  passthrough today; rather than building a hdr10plus_tool detour we
  let HDR10+ sources land as HDR10. Static mastering display + maxCLL
  is preserved.
- **Dolby Vision is skipped**, not transcoded.
- **Quality gate uses mean ≥ 95 AND p25 ≥ 93** by default. p25 catches
  short-but-bad regions that mean-only would average away.
- **Retry tightens CQ by 2 each iteration**, capped at 3 attempts then
  hard-fail.

## Quick start

1. Build / pull the custom ffmpeg image:

   ```bash
   docker pull ghcr.io/feldjaeger/ffmpeg-vmaf-cuda:latest
   ```

2. Bring up FileFlows + the ffmpeg-init service:

   ```bash
   cd compose
   cp .env.example .env
   $EDITOR .env       # set MEDIA_PATH, TEMP_PATH, FILEFLOWS_PORT, ...
   docker compose up -d
   ```

   The `ffmpeg-init` service runs once, copies binaries onto the named
   volume, then exits 0. FileFlows starts only after that succeeds.

3. Verify inside the FileFlows container:

   ```bash
   docker compose exec fileflows /opt/ffmpeg-custom/bin/ffmpeg \
       -hide_banner -filters | grep libvmaf
   docker compose exec fileflows /opt/ffmpeg-custom/bin/ffmpeg \
       -hide_banner -encoders | grep nvenc
   ```

4. In the FileFlows UI, **Settings → Tools** point the **FFmpeg** tool
   to `/opt/ffmpeg-custom/bin/ffmpeg`. (Some flow elements pick the
   binary up from there, others read the per-flow `FFmpegPath` variable
   — the function nodes here do the latter.)

5. **Settings → Variables** — add the variables from
   [`flow/AV1-VMAF-Pipeline.md`](flow/AV1-VMAF-Pipeline.md) (defaults
   are fine; only override what you need).

6. **Flows → New flow** — build the flow per the diagram in
   `flow/AV1-VMAF-Pipeline.md`. Each Function node is a "Run Function"
   element with the JS pasted in from `functions/`. Export the finished
   flow over `flow/av1-vmaf-pipeline.flow.json`.

## Updating the custom ffmpeg

```bash
docker compose pull ffmpeg-init
docker compose up -d --force-recreate ffmpeg-init
docker compose restart fileflows   # picks up new binaries on the volume
```

## Verify checklist

See `flow/AV1-VMAF-Pipeline.md` — covers HDR signaling, audio MD5
identity, loop limit termination, and CUDA-vs-CPU VMAF benchmark.

## Co-existence with Tdarr

This flow is intentionally evaluation-only — the existing Tdarr v6
pipeline keeps running in parallel. Make sure the Tdarr and FileFlows
libraries don't both pick the same files (FileFlows watches a different
directory or a tag-based subset).
