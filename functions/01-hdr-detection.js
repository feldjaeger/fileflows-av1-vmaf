// ===================================================================
// HDR Detection (FileFlows Function node)
// -------------------------------------------------------------------
// Output ports:
//   1 = SDR
//   2 = HDR10
//   3 = HDR10+   (will be re-encoded as HDR10 — av1_nvenc has no
//                 dynamic-metadata passthrough; this is by design.)
//   4 = Dolby Vision  → skip + tag
//
// Variables set:
//   HDRType        "SDR" | "HDR10" | "HDR10+" | "DV"
//   MasterDisplay  x265-style "G(...)B(...)R(...)WP(...)L(...)" string or null
//   MaxCLL         "<maxCLL>,<maxFALL>" or null
//   DVProfile      Dolby Vision profile number, or null
// -------------------------------------------------------------------
// ffprobe path is taken from Variables.FFprobePath (set in Flow Settings)
// or falls back to /opt/ffmpeg-custom/bin/ffprobe.
// ===================================================================

let ffprobe = Variables.FFprobePath || '/opt/ffmpeg-custom/bin/ffprobe';
let workingFile = Flow.WorkingFile || (Variables.file && Variables.file.FullName);
if (!workingFile) {
    Logger.ELog('HDR Detection: no working file');
    return -1;
}

let probe = Flow.Execute({
    command: ffprobe,
    argumentList: [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_frames',
        '-read_intervals', '%+#1',
        '-select_streams', 'v:0',
        workingFile
    ]
});

if (probe.exitCode !== 0) {
    Logger.ELog('ffprobe failed (exit ' + probe.exitCode + '): ' + probe.standardError);
    return -1;
}

let data;
try { data = JSON.parse(probe.standardOutput); }
catch (e) { Logger.ELog('ffprobe JSON parse failed: ' + e); return -1; }

let stream = (data.streams || [])[0] || {};
let frame  = (data.frames  || [])[0] || {};
let sideDataList = (frame.side_data_list || []).concat(stream.side_data_list || []);

let colorTransfer = (stream.color_transfer || frame.color_transfer || '').toLowerCase();
let isPQ  = colorTransfer === 'smpte2084';
let isHLG = colorTransfer === 'arib-std-b67';

// ---- Dolby Vision -------------------------------------------------
let dvSide = sideDataList.find(sd =>
    sd.side_data_type && /dovi|dolby vision/i.test(sd.side_data_type)
);
if (dvSide) {
    Variables.HDRType   = 'DV';
    Variables.DVProfile = dvSide.dv_profile != null ? Number(dvSide.dv_profile) : null;
    Logger.ILog('HDR Detection: Dolby Vision (profile ' + Variables.DVProfile + ') — skipping');
    return 4;
}

// ---- HDR static metadata (used for both HDR10 and HDR10+) ---------
function evalFrac(s) {
    if (s == null) return NaN;
    if (typeof s === 'number') return s;
    let parts = String(s).split('/');
    if (parts.length === 2) return parseFloat(parts[0]) / parseFloat(parts[1]);
    return parseFloat(s);
}
let cx  = v => Math.round(evalFrac(v) * 50000);   // chromaticity scaling
let lum = v => Math.round(evalFrac(v) * 10000);   // luminance scaling

let masteringSide = sideDataList.find(sd => sd.side_data_type === 'Mastering display metadata');
if (masteringSide) {
    try {
        Variables.MasterDisplay =
            'G('  + cx(masteringSide.green_x)        + ',' + cx(masteringSide.green_y)        + ')' +
            'B('  + cx(masteringSide.blue_x)         + ',' + cx(masteringSide.blue_y)         + ')' +
            'R('  + cx(masteringSide.red_x)          + ',' + cx(masteringSide.red_y)          + ')' +
            'WP(' + cx(masteringSide.white_point_x)  + ',' + cx(masteringSide.white_point_y)  + ')' +
            'L('  + lum(masteringSide.max_luminance) + ',' + lum(masteringSide.min_luminance) + ')';
    } catch (e) {
        Logger.WLog('Could not parse mastering display metadata: ' + e);
        Variables.MasterDisplay = null;
    }
} else {
    Variables.MasterDisplay = null;
}

let cllSide = sideDataList.find(sd => sd.side_data_type === 'Content light level metadata');
Variables.MaxCLL = cllSide ? (cllSide.max_content + ',' + cllSide.max_average) : null;

// ---- HDR10+ -------------------------------------------------------
let hdr10plusSide = sideDataList.find(sd =>
    sd.side_data_type && /smpte ?2094-?40|hdr dynamic metadata/i.test(sd.side_data_type)
);
if (hdr10plusSide) {
    Variables.HDRType = 'HDR10+';
    Logger.ILog('HDR Detection: HDR10+ source — encoding as HDR10 (no dynamic metadata passthrough on av1_nvenc)');
    return 3;
}

// ---- HDR10 / HLG --------------------------------------------------
if (isPQ || isHLG) {
    Variables.HDRType = 'HDR10';
    Logger.ILog('HDR Detection: HDR10 (color_transfer=' + colorTransfer + ')');
    return 2;
}

// ---- SDR ----------------------------------------------------------
Variables.HDRType       = 'SDR';
Variables.MasterDisplay = null;
Variables.MaxCLL        = null;
Logger.ILog('HDR Detection: SDR');
return 1;
