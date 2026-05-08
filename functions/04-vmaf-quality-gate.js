// ===================================================================
// VMAF Quality Gate (FileFlows Function node)
// -------------------------------------------------------------------
// Runs libvmaf over each (ref, dist) sample pair, aggregates per-frame
// VMAF scores across all samples, computes mean / p25 / harmonic_mean,
// and judges pass/fail.
//
// We currently use the CPU libvmaf filter, NOT libvmaf_cuda. The CUDA
// filter in libvmaf 3.0.0 / 3.1.0 has a regression where it processes
// the first frame fine and then errors out with "problem during
// vmaf_read_pictures" -> -22 on every subsequent frame. Reproduced
// against ffmpeg n8.1.1 + libvmaf v3.1.0 with both hwupload_cuda and
// NVDEC frame paths, with and without scale_cuda. Same upstream bug is
// tracked at https://github.com/Netflix/vmaf/issues/1423 — open as of
// 2026-05-08, no fix.
//
// CPU libvmaf with n_threads=8 is fast enough for 3 × 60 s samples on
// modern hardware (~250 fps for 1080p, ~40-60 fps for 4K → roughly
// 1-2 min per 4K sample, ~5 min total per VMAF run — acceptable for an
// out-of-band quality gate).
//
// To switch back to GPU once libvmaf_cuda is fixed: replace `libvmaf=`
// in the filter chain below with the hwupload_cuda + libvmaf_cuda
// variant, set Variables.UseGPUVMAF=true if you want a flow toggle.
//
// Output ports (deviating slightly from the spec for clarity — the
// retry/hard-fail decision lives in the Loop Counter node):
//   1 = Pass   (mean ≥ MeanThreshold AND p25 ≥ P25Threshold)
//   2 = Fail   (one of the thresholds missed → loop counter decides)
//
// Reads:
//   Variables.RefSamples       JSON array of ref sample paths
//   Variables.DistSamples      JSON array of dist sample paths
//   Variables.VMAFModel        default "version=vmaf_4k_v0.6.1"
//   Variables.MeanThreshold    default 95
//   Variables.P25Threshold     default 93
//   Variables.VMAFThreads      default 8
//
// Writes:
//   Variables.VMAFMean / VMAFP25 / VMAFHarmonic / VMAFFrameCount
//   Variables.VMAFLastReport   pretty summary string
// ===================================================================

let ffmpeg = Variables.FFmpegPath || '/opt/ffmpeg-custom/bin/ffmpeg';

let refs, dists;
try {
    refs  = JSON.parse(Variables.RefSamples  || '[]');
    dists = JSON.parse(Variables.DistSamples || '[]');
} catch (e) { Logger.ELog('VMAF gate: cannot parse sample arrays: ' + e); return 2; }

if (refs.length === 0 || refs.length !== dists.length) {
    Logger.ELog('VMAF gate: no samples or length mismatch');
    return 2;
}

let model        = Variables.VMAFModel       || 'version=vmaf_4k_v0.6.1';
let meanThresh   = Number(Variables.MeanThreshold || 95);
let p25Thresh    = Number(Variables.P25Threshold  || 93);
let nThreads     = Number(Variables.VMAFThreads   || 8);

let allScores = [];

for (let i = 0; i < refs.length; i++) {
    let ref  = refs[i];
    let dist = dists[i];
    let logPath = Flow.TempPath + '/vmaf_' + i + '_' + Flow.NewGuid() + '.json';

    // CPU libvmaf — input order is [distorted][reference].
    let filter =
        '[1:v][0:v]libvmaf=' +
            'log_path=' + logPath +
            ':log_fmt=json' +
            ':n_threads=' + nThreads +
            ':model=' + model;

    let r = Flow.Execute({
        command: ffmpeg,
        argumentList: [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', ref,
            '-i', dist,
            '-lavfi', filter,
            '-f', 'null', '-'
        ]
    });

    if (r.exitCode !== 0) {
        Logger.ELog('libvmaf failed on sample ' + i + ': ' + r.standardError.slice(-1500));
        return 2;
    }

    // Read the JSON log. FileFlows JS has System.IO via Jint — use a small ffmpeg
    // shim to read the file content portably across FileFlows versions.
    let cat = Flow.Execute({ command: '/bin/cat', argumentList: [logPath] });
    if (cat.exitCode !== 0) {
        Logger.ELog('Cannot read VMAF log ' + logPath);
        return 2;
    }
    let parsed;
    try { parsed = JSON.parse(cat.standardOutput); }
    catch (e) { Logger.ELog('VMAF JSON parse failed for sample ' + i + ': ' + e); return 2; }

    let frames = parsed.frames || [];
    for (let j = 0; j < frames.length; j++) {
        let v = frames[j].metrics && frames[j].metrics.vmaf;
        if (typeof v === 'number') allScores.push(v);
    }
    Logger.ILog('Sample ' + i + ': ' + frames.length + ' frames, pooled mean=' +
        (parsed.pooled_metrics && parsed.pooled_metrics.vmaf && parsed.pooled_metrics.vmaf.mean));
}

if (allScores.length === 0) {
    Logger.ELog('VMAF gate: no frame scores collected');
    return 2;
}

allScores.sort((a, b) => a - b);
let n = allScores.length;
let sum = 0, harmSum = 0, harmN = 0;
for (let i = 0; i < n; i++) {
    sum += allScores[i];
    if (allScores[i] > 0) { harmSum += 1 / allScores[i]; harmN++; }
}

function percentile(sorted, p) {
    // Nearest-rank percentile; sorted ascending.
    if (sorted.length === 0) return NaN;
    let rank = Math.max(1, Math.ceil(p / 100 * sorted.length));
    return sorted[rank - 1];
}

let mean     = sum / n;
let p25      = percentile(allScores, 25);
let harmonic = harmN > 0 ? harmN / harmSum : 0;

Variables.VMAFMean       = mean;
Variables.VMAFP25        = p25;
Variables.VMAFHarmonic   = harmonic;
Variables.VMAFFrameCount = n;

let report =
    'VMAF over ' + n + ' frames (' + refs.length + ' samples): ' +
    'mean=' + mean.toFixed(2) +
    ', p25=' + p25.toFixed(2) +
    ', harmonic=' + harmonic.toFixed(2) +
    ' | thresholds mean≥' + meanThresh + ' p25≥' + p25Thresh;
Variables.VMAFLastReport = report;
Logger.ILog(report);

if (mean >= meanThresh && p25 >= p25Thresh) {
    Logger.ILog('VMAF: PASS');
    return 1;
}
Logger.WLog('VMAF: FAIL');
return 2;
