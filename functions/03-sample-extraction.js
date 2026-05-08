// ===================================================================
// Sample Extraction (FileFlows Function node)
// -------------------------------------------------------------------
// Extracts 3 × 60-second samples from the original *and* encoded files
// at identical timestamps (25%, 50%, 75% of the runtime). Stream-copy
// only — no re-encode — so this is fast and lossless.
//
// Reads:
//   Variables.OriginalFile  set by encode node (or fallback to working file)
//   Variables.EncodedFile   set by encode node
//   Variables.SampleSeconds  override; default 60
//
// Writes:
//   Variables.RefSamples   JSON array of paths (length 3)
//   Variables.DistSamples  JSON array of paths (length 3)
//
// Output ports:
//   1 = success
//   2 = failure
// ===================================================================

let ffmpeg  = Variables.FFmpegPath  || '/opt/ffmpeg-custom/bin/ffmpeg';
let ffprobe = Variables.FFprobePath || '/opt/ffmpeg-custom/bin/ffprobe';

let original = Variables.OriginalFile;
let encoded  = Variables.EncodedFile;
if (!original || !encoded) {
    Logger.ELog('Sample Extraction: missing OriginalFile or EncodedFile');
    return 2;
}

let sampleSec = Number(Variables.SampleSeconds || 60);

// Probe duration (use the original — both files should match in length).
let probe = Flow.Execute({
    command: ffprobe,
    argumentList: [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', original
    ]
});
if (probe.exitCode !== 0) {
    Logger.ELog('ffprobe duration failed: ' + probe.standardError);
    return 2;
}
let duration = parseFloat(probe.standardOutput.trim());
if (!isFinite(duration) || duration <= sampleSec * 3) {
    Logger.ELog('Sample Extraction: source too short (' + duration + 's) for 3×' + sampleSec + 's samples');
    return 2;
}

let positions = [0.25, 0.50, 0.75].map(p => Math.max(0, Math.floor(duration * p) - Math.floor(sampleSec / 2)));
let refSamples  = [];
let distSamples = [];

function extract(input, pos, outPath) {
    // -ss before -i seeks fast (input-side); copy with -avoid_negative_ts make_zero
    // gives clean timestamps for the VMAF compare step.
    let r = Flow.Execute({
        command: ffmpeg,
        argumentList: [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', String(pos),
            '-t',  String(sampleSec),
            '-i',  input,
            '-map', '0:v:0',
            '-c',   'copy',
            '-avoid_negative_ts', 'make_zero',
            outPath
        ]
    });
    return r.exitCode === 0;
}

for (let i = 0; i < positions.length; i++) {
    let pos = positions[i];
    let refOut  = Flow.TempPath + '/ref_'  + i + '_' + Flow.NewGuid() + '.mkv';
    let distOut = Flow.TempPath + '/dist_' + i + '_' + Flow.NewGuid() + '.mkv';

    if (!extract(original, pos, refOut))  { Logger.ELog('Ref sample '  + i + ' failed at ' + pos + 's'); return 2; }
    if (!extract(encoded,  pos, distOut)) { Logger.ELog('Dist sample ' + i + ' failed at ' + pos + 's'); return 2; }

    refSamples.push(refOut);
    distSamples.push(distOut);
    Logger.ILog('Sample ' + i + ' @ ' + pos + 's: ref=' + refOut + ' dist=' + distOut);
}

// Variables only reliably hold scalars, so persist arrays as JSON strings.
Variables.RefSamples  = JSON.stringify(refSamples);
Variables.DistSamples = JSON.stringify(distSamples);
return 1;
