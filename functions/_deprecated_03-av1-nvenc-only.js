// ===================================================================
// AV1 NVENC Full Encode (FileFlows Function node)
// -------------------------------------------------------------------
// Runs after the CQ Search node. The CQ has already been validated
// against VMAF on representative samples — no retry loop here, no
// post-hoc verify gate. One encode, then ReplaceOriginal.
//
// Variables read:
//   FFmpegPath
//   HDRType, MasterDisplay, MaxCLL  (from HDR Detection)
//   OptCQ                           (from CQ Search)
//
// Variables written:
//   EncodedFile  path of the encoded mkv (working file is set to it)
//
// Output ports:
//   1 = encode succeeded — working file is now the encoded mkv
//   2 = encode failed
// ===================================================================

let ffmpeg    = Variables.FFmpegPath || '/opt/ffmpeg-custom/bin/ffmpeg';
let inputFile = Flow.WorkingFile || (Variables.file && Variables.file.FullName);
if (!inputFile) { Logger.ELog('Full Encode: no working file'); return 2; }

let hdr = Variables.HDRType || 'SDR';
// NB: FileFlows pre-substitutes `Variables.X` patterns inside scripts,
// even when they appear as literal text inside strings. Reading
// `Variables.OptCQ` into a local first avoids trapping the substitution
// in a string literal and breaking the parser.
let optCQ = Variables.OptCQ;
let cq    = Number(optCQ);
if (!isFinite(cq) || cq <= 0) {
    Logger.ELog('Full Encode: OptCQ from search is missing or invalid (got '+optCQ+')');
    return 2;
}

let outputFile = Flow.TempPath + '/' + Flow.NewGuid() + '.mkv';

let args = [
    '-y', '-hide_banner',
    '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
    '-i', inputFile,
    // Real video + audio + subs. Skip attached_pic (cover art) and data
    // streams — UHD Blu-ray remuxes carry png/jpg attachments that ffmpeg
    // would otherwise try to decode and fail on.
    '-map', '0:V',
    '-map', '0:a?',
    '-map', '0:s?',
    '-c:v', 'av1_nvenc',
    '-preset', 'p7',
    '-tune',   'hq',
    '-multipass', 'fullres',
    '-rc',  'vbr',
    '-cq',  String(cq),
    '-b:v', '0',
    '-spatial-aq', '1',
    // No `-pix_fmt p010le`: with -hwaccel_output_format cuda the encoder
    // inherits source bit depth automatically (10-bit in → 10-bit out).
    // Forcing p010le triggers a hwdownload + swscale path that breaks on
    // some 10-bit HDR sources.
    '-c:a', 'copy',
    '-c:s', 'copy',
    '-map_chapters', '0',
    '-map_metadata', '0'
];

if (hdr === 'HDR10' || hdr === 'HDR10+') {
    args.push(
        '-color_primaries', 'bt2020',
        '-color_trc',       'smpte2084',
        '-colorspace',      'bt2020nc',
        '-color_range',     'tv'
    );
    if (Variables.MasterDisplay) {
        args.push('-metadata:s:v:0', 'mastering_display='+Variables.MasterDisplay);
    }
    if (Variables.MaxCLL) {
        args.push('-metadata:s:v:0', 'content_light_level='+Variables.MaxCLL);
    }
}

args.push(outputFile);

Logger.ILog('Full Encode: HDR='+hdr+' CQ='+cq+' → '+outputFile);

let r = Flow.Execute({ command: ffmpeg, argumentList: args });
if (r.exitCode !== 0) {
    Logger.ELog('Full Encode failed (exit '+r.exitCode+'): '+r.standardError.slice(-2000));
    return 2;
}

Variables.EncodedFile  = outputFile;
Variables.OriginalFile = Variables.OriginalFile || inputFile;
Flow.SetWorkingFile(outputFile);
Logger.ILog('Full Encode OK → '+outputFile);
return 1;
