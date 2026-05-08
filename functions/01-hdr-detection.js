// ===================================================================
// HDR Detection (FileFlows Function node)
// -------------------------------------------------------------------
// Output ports:
//   1 = SDR
//   2 = HDR10           (also: DV Profile 7/8 with HDR10 base — RPU is
//                        dropped during av1_nvenc re-encode, HDR10 base
//                        is preserved)
//   3 = HDR10+          (degraded to HDR10 during encode — av1_nvenc
//                        has no dynamic-metadata passthrough, by design)
//   4 = DV-only / skip  (Profile 5: no HDR10 fallback — would need
//                        dovi_tool tonemap, not implemented)
//
// Variables set:
//   HDRType        "SDR" | "HDR10" | "HDR10+" | "DV"
//   MasterDisplay  x265-style "G(...)B(...)R(...)WP(...)L(...)" string or null
//   MaxCLL         "<maxCLL>,<maxFALL>" or null
//   HasDV          true when a DV layer was detected (even if routed
//                  to HDR10 path), so logging downstream can flag it
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

// ---- HDR static metadata (extract first — needed both to decide
//      whether DV has an HDR10 fallback, and for the encode node) ---
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

let hasHDR10Base = !!Variables.MasterDisplay;   // mastering display present → HDR10 base layer is there

// ---- Dolby Vision -------------------------------------------------
let dvSide = sideDataList.find(sd =>
    sd.side_data_type && /dovi|dolby vision/i.test(sd.side_data_type)
);
if (dvSide) {
    Variables.HasDV     = true;
    Variables.DVProfile = dvSide.dv_profile != null ? Number(dvSide.dv_profile) : null;
    if (!hasHDR10Base) {
        // Profile 5 (DV-only, IPT-PQ-c2). No HDR10 base layer, would need
        // dovi_tool to tonemap into BT.2020-PQ. We don't ship dovi_tool.
        Variables.HDRType = 'DV';
        Logger.ILog('HDR Detection: DV-only (profile ' + Variables.DVProfile +
                    ', no HDR10 base) — skipping');
        return 4;
    }
    // Profile 7 / 8: HDR10 base layer is present alongside the DV RPU.
    // av1_nvenc has no DV passthrough, so we drop the DV layer and
    // re-encode the HDR10 base. Falls through to the HDR10+/HDR10 path
    // below, which propagates mastering display + MaxCLL.
    Logger.ILog('HDR Detection: DV+HDR10 (profile ' + Variables.DVProfile +
                ') — encoding as HDR10, dropping DV RPU');
}

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
