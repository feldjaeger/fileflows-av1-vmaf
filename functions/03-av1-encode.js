// ===================================================================
// AV1 Full Encode (FileFlows Function node)
// -------------------------------------------------------------------
// Supports two encoders, switchable per HDR/SDR via Variables:
//
//   av1_nvenc  (default)
//     GPU-accelerated, fast, but inefficient on 4K HDR heavy-detail
//     content — bitrate explodes at low CQ values (~100 Mbit/s at CQ=22
//     on Avatar 2). Best for SDR or non-detail-dense HDR.
//
//   libsvtav1
//     CPU-only, much slower, but dramatically more efficient per bit
//     (~10 Mbit/s at CRF=22 on the same content). Right pick when the
//     output needs to be both small AND visually close to source.
//
// Variables read:
//   FFmpegPath
//   HDRType               from HDR Detection
//   MasterDisplay, MaxCLL from HDR Detection
//   OptCQ                 from CQ Search (used by av1_nvenc only)
//
//   EncoderHDR / EncoderSDR    "av1_nvenc" (default) | "libsvtav1"
//   SvtPreset                  libsvtav1 preset (default 8)
//   SvtCrf                     libsvtav1 CRF (default 22)
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
let encoder = (hdr === 'SDR')
    ? (Variables.EncoderSDR || 'av1_nvenc')
    : (Variables.EncoderHDR || 'av1_nvenc');

let outputFile = Flow.TempPath + '/' + Flow.NewGuid() + '.mkv';

let args = [];

if (encoder === 'libsvtav1') {
    // -------- SVT-AV1 (CPU) --------------------------------------
    let preset = Number(Variables.SvtPreset || 8);
    let crf    = Number(Variables.SvtCrf    || 22);

    // No -hwaccel cuda for libsvtav1: it's a CPU encoder, and forcing
    // frames through GPU memory then back is pure overhead. CPU
    // HEVC decode on this 26-thread i7 is not the bottleneck anyway.
    args = [
        '-y', '-hide_banner',
        '-i', inputFile,
        '-map', '0:V',
        '-map', '0:a?',
        '-map', '0:s?',
        '-c:v', 'libsvtav1',
        '-preset', String(preset),
        '-crf',    String(crf),
        '-pix_fmt', (hdr === 'SDR') ? 'yuv420p' : 'yuv420p10le',
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

    Logger.ILog('Full Encode: libsvtav1 preset='+preset+' crf='+crf+' HDR='+hdr+' → '+outputFile);

} else {
    // -------- av1_nvenc (default) --------------------------------
    let optCQ = Variables.OptCQ;
    let cq    = Number(optCQ);
    if (!isFinite(cq) || cq <= 0) {
        Logger.ELog('Full Encode (nvenc): OptCQ from search is missing or invalid (got '+optCQ+')');
        return 2;
    }

    args = [
        '-y', '-hide_banner',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        '-i', inputFile,
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

    Logger.ILog('Full Encode: av1_nvenc CQ='+cq+' HDR='+hdr+' → '+outputFile);
}

args.push(outputFile);

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
