// ===================================================================
// AV1 NVENC Encode (FileFlows Function node)
// -------------------------------------------------------------------
// Reads:
//   Variables.HDRType         "SDR" | "HDR10" | "HDR10+"  (HDR10+ → HDR10)
//   Variables.EncodeAttempts  0,1,2... incremented by the loop counter node
//   Variables.CQ_SDR          override; default 28
//   Variables.CQ_HDR          override; default 30
//
// Writes:
//   Sets the working file to the encoded MKV.
//   Variables.EncodedFile     path of the encoded file (also kept in WorkingFile)
//   Variables.LastCQ          the CQ value actually used
//
// Output ports:
//   1 = encode succeeded
//   2 = encode failed
// ===================================================================

let ffmpeg = Variables.FFmpegPath || '/opt/ffmpeg-custom/bin/ffmpeg';
let inputFile = Flow.WorkingFile || (Variables.file && Variables.file.FullName);
if (!inputFile) { Logger.ELog('AV1 Encode: no working file'); return 2; }

let hdr = Variables.HDRType || 'SDR';
let attempts = Number(Variables.EncodeAttempts || 0);

// Base CQ per HDR type. Each retry tightens by 2.
let baseCQ = (hdr === 'SDR')
    ? Number(Variables.CQ_SDR || 28)
    : Number(Variables.CQ_HDR || 30);
let cq = Math.max(18, baseCQ - 2 * attempts);
Variables.LastCQ = cq;

let outputFile = Flow.TempPath + '/' + Flow.NewGuid() + '.mkv';

let args = [
    '-y', '-hide_banner',
    '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-i', inputFile,
    '-map', '0',
    '-c:v', 'av1_nvenc',
    '-preset', 'p7',
    '-tune', 'hq',
    '-multipass', 'fullres',
    '-rc', 'vbr',
    '-cq', String(cq),
    '-b:v', '0',
    '-spatial-aq', '1',
    '-pix_fmt', 'p010le',
    '-c:a', 'copy',
    '-c:s', 'copy',
    '-map_chapters', '0',
    '-map_metadata', '0'
];

if (hdr === 'HDR10' || hdr === 'HDR10+') {
    // BT.2020 / PQ signaling. HDR10 static metadata (mastering display + maxCLL)
    // is propagated automatically via stream side_data when -map 0 is used and
    // the output container is MKV, which preserves these structures.
    args.push(
        '-color_primaries', 'bt2020',
        '-color_trc',       'smpte2084',
        '-colorspace',      'bt2020nc',
        '-color_range',     'tv'
    );
    // Mirror the static metadata on the output stream as a belt-and-braces measure.
    if (Variables.MasterDisplay) {
        args.push('-metadata:s:v:0', 'mastering_display=' + Variables.MasterDisplay);
    }
    if (Variables.MaxCLL) {
        args.push('-metadata:s:v:0', 'content_light_level=' + Variables.MaxCLL);
    }
}

args.push(outputFile);

Logger.ILog('AV1 Encode: HDR=' + hdr + ', CQ=' + cq + ', attempt=' + (attempts + 1));
Logger.ILog('ffmpeg ' + args.map(a => /\s/.test(a) ? '"' + a + '"' : a).join(' '));

let r = Flow.Execute({ command: ffmpeg, argumentList: args });

if (r.exitCode !== 0) {
    Logger.ELog('AV1 encode failed (exit ' + r.exitCode + '): ' + r.standardError.slice(-2000));
    return 2;
}

Variables.EncodedFile  = outputFile;
Variables.OriginalFile = Variables.OriginalFile || inputFile;
Flow.SetWorkingFile(outputFile);
Logger.ILog('AV1 Encode OK → ' + outputFile);
return 1;
