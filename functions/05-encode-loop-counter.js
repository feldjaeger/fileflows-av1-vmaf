// ===================================================================
// Re-Encode Loop Counter (FileFlows Function node)
// -------------------------------------------------------------------
// Wired to the VMAF gate's "Fail" output. Increments
// Variables.EncodeAttempts and decides whether to retry the encode
// or hard-fail (keep original).
//
// Reads:
//   Variables.EncodeAttempts  current attempt count (0-indexed before this node)
//   Variables.MaxEncodeAttempts  default 3
//
// Writes:
//   Variables.EncodeAttempts  incremented
//
// Output ports:
//   1 = Retry encode (loop back into the AV1 encode node)
//   2 = Hard-Fail   (give up, downstream should keep the original)
// ===================================================================

let attempts = Number(Variables.EncodeAttempts || 0) + 1;
let max      = Number(Variables.MaxEncodeAttempts || 3);
Variables.EncodeAttempts = attempts;

Logger.WLog('Re-Encode Loop Counter: attempt ' + attempts + ' / ' + max);

if (attempts >= max) {
    Logger.WLog('Loop limit reached → hard-fail, keeping original');
    return 2;
}
Logger.ILog('Looping back for re-encode (CQ will be tightened by 2)');
return 1;
