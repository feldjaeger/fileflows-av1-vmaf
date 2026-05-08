// ===================================================================
// CQ Search (FileFlows Function node)
// -------------------------------------------------------------------
// Picks the highest CQ that still meets the VMAF quality threshold —
// = the smallest output file the encoder can produce while staying
// visually equivalent to the source. Pre-computed, so the full encode
// only runs once at the proven-good CQ.
//
// Algorithm:
//   1. Probe source duration.
//   2. Stream-copy 4 × 20 s reference samples at 20/40/60/80 % of the
//      runtime (real video stream only — no attached_pic).
//   3. For each candidate CQ in descending order (highest first):
//        encode each ref sample at that CQ with the *same* settings
//        the full encode will use (preset p7, multipass fullres,
//        HDR signaling, etc.) so the VMAF prediction matches the
//        eventual full encode.
//        run libvmaf (CPU; libvmaf_cuda has an upstream bug, see
//        https://github.com/Netflix/vmaf/issues/1423) on each pair.
//        aggregate: mean, p25, harmonic mean over all 4 samples.
//        if mean ≥ MeanThreshold AND p25 ≥ P25Threshold → win.
//        Since we iterate descending, the first passing CQ is the
//        highest passing CQ → smallest acceptable file.
//   4. If no CQ in the grid passes, fall back to the lowest tested
//      CQ (best quality), so the full encode still runs at a
//      reasonable setting.
//
// Variables read:
//   FFmpegPath / FFprobePath
//   HDRType, MasterDisplay, MaxCLL  (from HDR Detection node)
//   MeanThreshold (95)
//   P25Threshold  (93)
//   VMAFModel     (version=vmaf_4k_v0.6.1)
//   VMAFThreads   (8)
//   CQGrid_HDR    optional override, comma-separated, default "38,34,30,26"
//   CQGrid_SDR    optional override, comma-separated, default "34,30,26,22"
//   SearchSampleSeconds  optional, default 20
//
// Variables written:
//   OptCQ            chosen CQ value
//   SearchMean       VMAF mean at chosen CQ
//   SearchP25        VMAF p25 at chosen CQ
//   SearchHarmonic   VMAF harmonic mean at chosen CQ
//   SearchSummary    one-line human-readable result
//
// Output ports:
//   1 = success, OptCQ set → continue to full encode
//   2 = failure (e.g. source too short, encoder errored on samples)
// ===================================================================

let ffmpeg  = Variables.FFmpegPath  || '/opt/ffmpeg-custom/bin/ffmpeg';
let ffprobe = Variables.FFprobePath || '/opt/ffmpeg-custom/bin/ffprobe';
let inputFile = Flow.WorkingFile || (Variables.file && Variables.file.FullName);
if (!inputFile) { Logger.ELog('CQ Search: no working file'); return 2; }

let hdr   = Variables.HDRType || 'SDR';
let meanT = Number(Variables.MeanThreshold || 95);
let p25T  = Number(Variables.P25Threshold  || 93);
let nT    = Number(Variables.VMAFThreads   || 8);
let model = Variables.VMAFModel || 'version=vmaf_4k_v0.6.1';
let sampleSec = Number(Variables.SearchSampleSeconds || 20);

function parseGrid(s, fallback) {
    if (!s) return fallback;
    let arr = String(s).split(',').map(x => Number(x.trim())).filter(n => isFinite(n));
    return arr.length ? arr : fallback;
}
let cqGrid = (hdr === 'SDR')
    ? parseGrid(Variables.CQGrid_SDR, [34, 30, 26, 22])
    : parseGrid(Variables.CQGrid_HDR, [38, 34, 30, 26]);
// descending = highest CQ (smallest file) first
cqGrid.sort((a, b) => b - a);

// ----- 1. probe duration -------------------------------------------
let probe = Flow.Execute({
    command: ffprobe,
    argumentList: [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', inputFile
    ]
});
if (probe.exitCode !== 0) { Logger.ELog('ffprobe duration failed: '+probe.standardError); return 2; }
let duration = parseFloat(probe.standardOutput.trim());
if (!isFinite(duration) || duration <= sampleSec * 5) {
    Logger.ELog('CQ Search: source too short ('+duration+'s) for 4×'+sampleSec+'s search'); return 2;
}
Logger.ILog('CQ Search: duration='+duration.toFixed(1)+'s, HDR='+hdr+', grid=['+cqGrid.join(',')+']');

// ----- 2. extract 4 reference samples ------------------------------
let positions = [0.20, 0.40, 0.60, 0.80].map(p =>
    Math.max(0, Math.floor(duration * p) - Math.floor(sampleSec / 2))
);
let refSamples = [];
for (let i = 0; i < positions.length; i++) {
    let out = Flow.TempPath + '/cqsrc_' + i + '_' + Flow.NewGuid() + '.mkv';
    let r = Flow.Execute({
        command: ffmpeg,
        argumentList: [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', String(positions[i]),
            '-t',  String(sampleSec),
            '-i',  inputFile,
            '-map', '0:V:0',                 // first real video, no attached_pic
            '-c',   'copy',
            '-avoid_negative_ts', 'make_zero',
            out
        ]
    });
    if (r.exitCode !== 0) {
        Logger.ELog('CQ Search: ref sample '+i+' (pos '+positions[i]+'s) extract failed: '+r.standardError.slice(-500));
        return 2;
    }
    refSamples.push(out);
}
Logger.ILog('CQ Search: extracted '+refSamples.length+' × '+sampleSec+'s ref samples');

// ----- 3. for each CQ, encode samples + VMAF -----------------------
function encodeArgs(input, output, cq) {
    let a = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        '-i', input,
        '-map', '0:V',
        '-c:v', 'av1_nvenc',
        '-preset', 'p7',
        '-tune', 'hq',
        '-multipass', 'fullres',
        '-rc', 'vbr',
        '-cq', String(cq),
        '-b:v', '0',
        '-spatial-aq', '1',
        '-an'                               // strip audio for speed
    ];
    if (hdr === 'HDR10' || hdr === 'HDR10+') {
        a.push(
            '-color_primaries', 'bt2020',
            '-color_trc',       'smpte2084',
            '-colorspace',      'bt2020nc',
            '-color_range',     'tv'
        );
        if (Variables.MasterDisplay) a.push('-metadata:s:v:0', 'mastering_display='+Variables.MasterDisplay);
        if (Variables.MaxCLL)        a.push('-metadata:s:v:0', 'content_light_level='+Variables.MaxCLL);
    }
    a.push(output);
    return a;
}

function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    let rank = Math.max(1, Math.ceil(p / 100 * sorted.length));
    return sorted[rank - 1];
}

let bestCQ = null;
let bestStats = null;

for (let ci = 0; ci < cqGrid.length; ci++) {
    let cq = cqGrid[ci];
    Logger.ILog('--- CQ='+cq+' ---');
    let allScores = [];
    let failed = false;

    for (let i = 0; i < refSamples.length; i++) {
        let ref = refSamples[i];
        let enc = Flow.TempPath + '/cqenc_'+cq+'_'+i+'_'+Flow.NewGuid()+'.mkv';

        let er = Flow.Execute({ command: ffmpeg, argumentList: encodeArgs(ref, enc, cq) });
        if (er.exitCode !== 0) {
            Logger.ELog('CQ '+cq+' sample '+i+' encode failed: '+er.standardError.slice(-500));
            failed = true; break;
        }

        let logp = Flow.TempPath + '/vmaf_cq'+cq+'_'+i+'_'+Flow.NewGuid()+'.json';
        let vr = Flow.Execute({
            command: ffmpeg,
            argumentList: [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', ref, '-i', enc,
                '-lavfi', '[1:v][0:v]libvmaf=log_path='+logp+
                          ':log_fmt=json:n_threads='+nT+':model='+model,
                '-f', 'null', '-'
            ]
        });
        if (vr.exitCode !== 0) {
            Logger.ELog('CQ '+cq+' sample '+i+' VMAF failed: '+vr.standardError.slice(-500));
            failed = true; break;
        }
        let cat = Flow.Execute({ command: '/bin/cat', argumentList: [logp] });
        let vd; try { vd = JSON.parse(cat.standardOutput); }
        catch (e) { Logger.ELog('CQ '+cq+' sample '+i+' JSON parse: '+e); failed = true; break; }
        let frames = vd.frames || [];
        for (let fi = 0; fi < frames.length; fi++) {
            let v = frames[fi].metrics && frames[fi].metrics.vmaf;
            if (typeof v === 'number') allScores.push(v);
        }
    }
    if (failed || !allScores.length) continue;

    allScores.sort((a, b) => a - b);
    let sum = 0, harmS = 0, harmN = 0;
    for (let i = 0; i < allScores.length; i++) {
        sum += allScores[i];
        if (allScores[i] > 0) { harmS += 1 / allScores[i]; harmN++; }
    }
    let mean = sum / allScores.length;
    let p25  = percentile(allScores, 25);
    let harm = harmN > 0 ? harmN / harmS : 0;

    Logger.ILog('CQ='+cq+': mean='+mean.toFixed(2)+' p25='+p25.toFixed(2)+
                ' harmonic='+harm.toFixed(2)+' (n='+allScores.length+')');

    if (mean >= meanT && p25 >= p25T) {
        bestCQ = cq;
        bestStats = { mean: mean, p25: p25, harmonic: harm, frames: allScores.length };
        break;   // descending grid: first pass = highest CQ that passes
    }
}

if (bestCQ === null) {
    bestCQ = Math.min.apply(null, cqGrid);
    Variables.OptCQ          = bestCQ;
    Variables.SearchSummary  = 'CQ='+bestCQ+' (fallback — no candidate met thresholds, using lowest tested)';
    Logger.WLog('CQ Search: '+Variables.SearchSummary);
} else {
    Variables.OptCQ          = bestCQ;
    Variables.SearchMean     = bestStats.mean;
    Variables.SearchP25      = bestStats.p25;
    Variables.SearchHarmonic = bestStats.harmonic;
    Variables.SearchSummary  = 'CQ='+bestCQ+' (mean='+bestStats.mean.toFixed(2)+
                               ', p25='+bestStats.p25.toFixed(2)+
                               ', n='+bestStats.frames+')';
    Logger.ILog('CQ Search: '+Variables.SearchSummary);
}

return 1;
