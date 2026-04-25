// =============================================================================
// Audio Normalize — IINA Plugin
// =============================================================================
// Normalizes audio playback using peak or EBU R128 loudness analysis.
//
// R128 scanning uses a two-stage strategy:
//   1. ebur128 filter (fast, ~30-48s for 45min file) measures loudness and peak
//   2. If linear gain is sufficient: apply immediately — done in under a minute
//   3. If dynamic compression needed: run loudnorm scan (~4min) for offset data
//
// Dependencies: ffmpeg (required), b3sum/xxhsum (optional, faster hashing)
// =============================================================================

var { core, event, mpv, overlay, utils, console, preferences, file, menu } = iina;

// --- FILTER LABELS & STATE ---

var FILTER_NORM = "audionorm";       // mpv audio filter label for normalization
var FILTER_DMX = "audionorm-dmx";    // mpv audio filter label for downmix
var CACHE_PATH = "@data/cache.json"; // persisted in IINA plugin data directory
var hideTimer = null;                // setTimeout ID for auto-hiding the OSD
var overlayReady = false;            // true after first initOverlay() call (requires window)
var cache = {};                      // fingerprint → analysis data
var scanGeneration = 0;              // incremented per runAnalysis; stale scans compare against this

// R128 preset targets per EBU R128 / YouTube / broadcast standards
// I = integrated loudness target (LUFS), TP = true peak ceiling (dBTP), LRA = loudness range (LU)
var R128_PRESETS = {
  "r128-youtube":   { I: -14, TP: -1, LRA: 11, label: "YT" },
  "r128-broadcast": { I: -24, TP: -2, LRA: 11, label: "TV" }
};

// OSD indicator sizing per preference setting
var SIZE_MAP = {
  tiny:   { font: 9,  pad: "4px 9px",  dot: 4, gap: 6 },
  small:  { font: 11, pad: "5px 10px", dot: 5, gap: 7 },
  medium: { font: 13, pad: "6px 12px", dot: 6, gap: 8 },
  large:  { font: 15, pad: "7px 14px", dot: 7, gap: 9 }
};

var EDGE = "20px"; // distance from window edge for OSD positioning

// =============================================================================
// CACHE
// =============================================================================

/** Load cache from disk and prune expired entries. */
function loadCache() {
  try {
    if (file.exists(CACHE_PATH)) {
      var content = file.read(CACHE_PATH);
      cache = JSON.parse(content);
      if (typeof cache !== "object" || cache === null || Array.isArray(cache)) {
        console.log("Cache file corrupted, resetting");
        cache = {};
      }
      pruneCache();
      console.log("Cache loaded: " + Object.keys(cache).length + " entries");
    }
  } catch (e) {
    console.log("Cache load failed, resetting: " + e);
    cache = {};
  }
}

/** Remove entries older than the configured retention period. */
function pruneCache() {
  var months = parseInt(preferences.get("cache_months"));
  if (isNaN(months) || months < 1) months = 3;
  var cutoff = Date.now() - (months * 30 * 24 * 60 * 60 * 1000);
  var keys = Object.keys(cache);
  var pruned = 0;
  for (var i = 0; i < keys.length; i++) {
    var entry = cache[keys[i]];
    if (!entry || typeof entry !== "object" || !entry.ts || entry.ts < cutoff) {
      delete cache[keys[i]];
      pruned++;
    }
  }
  if (pruned > 0) {
    saveCache();
    console.log("Cache pruned: removed " + pruned + " expired/invalid entries");
  }
}

/** Write cache to disk. Errors are logged but non-fatal. */
function saveCache() {
  try {
    file.write(CACHE_PATH, JSON.stringify(cache));
  } catch (e) {
    console.log("Cache save failed: " + e);
  }
}

/** Delete all cached entries and remove the cache file. */
function clearCache() {
  cache = {};
  try {
    if (file.exists(CACHE_PATH)) { file.delete(CACHE_PATH); }
  } catch (e) {}
  console.log("Cache cleared");
  showStatusSafe("done", "Cache cleared");
}

/** Show OSD with default duration, handling the case where overlay isn't ready. */
function showStatusSafe(dotClass, text) {
  var osdDuration = (parseInt(preferences.get("osd_duration")) || 4) * 1000;
  if (overlayReady) {
    showStatus(dotClass, text, osdDuration);
  } else {
    console.log("OSD (no window): " + OSD_PREFIX + text);
  }
}

// =============================================================================
// FINGERPRINT
// =============================================================================

/** Check if a path is a local file (not a URL/stream). */
function isLocalFile(path) {
  if (!path) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(path)) return false;
  return true;
}

/**
 * Generate a fingerprint for a local file.
 * Tries: BLAKE3 (~71ms) → xxHash64 (~149ms) → OpenSSL SHA256 (~560ms).
 * Returns null for streams/URLs or if all methods fail.
 */
async function getFingerprint(filePath) {
  if (!isLocalFile(filePath)) {
    console.log("Not a local file, skipping fingerprint");
    return null;
  }

  try {
    var b3Path = findTool(["/opt/homebrew/bin/b3sum", "/usr/local/bin/b3sum"]);
    if (b3Path) {
      var result = await utils.exec(b3Path, ["--no-names", filePath]);
      var hash = result.stdout.trim();
      if (hash) { console.log("blake3: " + hash.substring(0, 16) + "\u2026"); return hash; }
    }
  } catch (e) {}

  try {
    var xxhPath = findTool(["/opt/homebrew/bin/xxhsum", "/usr/local/bin/xxhsum"]);
    if (xxhPath) {
      var result = await utils.exec(xxhPath, ["-H1", filePath]);
      var hash = result.stdout.trim().split(/\s+/)[0];
      if (hash) { console.log("xxh64: " + hash); return hash; }
    }
  } catch (e) {}

  try {
    console.log("Using openssl sha256 fallback");
    var result = await utils.exec("openssl", ["dgst", "-sha256", filePath]);
    var match = result.stdout.match(/=\s*([0-9a-f]+)/);
    if (match) { console.log("sha256: " + match[1].substring(0, 16) + "\u2026"); return match[1]; }
  } catch (e) {}

  console.log("All fingerprint methods failed, caching disabled for this file");
  return null;
}

/**
 * Return the first absolute path from the list.
 * IINA's sandbox prevents checking if files exist at absolute paths,
 * so we trust that standard Homebrew/system paths are valid.
 */
function findTool(paths) {
  for (var i = 0; i < paths.length; i++) {
    if (paths[i].charAt(0) === "/") return paths[i];
  }
  return null;
}

// =============================================================================
// OSD OVERLAY
// =============================================================================

function getPositionCSS(pos) {
  switch (pos) {
    case "top-left":     return "top: " + EDGE + "; left: " + EDGE + ";";
    case "top-right":    return "top: " + EDGE + "; right: " + EDGE + ";";
    case "bottom-right": return "bottom: " + EDGE + "; right: " + EDGE + ";";
    default:             return "bottom: " + EDGE + "; left: " + EDGE + ";";
  }
}

/** Build the CSS string for the OSD overlay based on position and size preferences. */
function buildCSS(position, size) {
  var s = SIZE_MAP[size] || SIZE_MAP.medium;
  var posCSS = getPositionCSS(position);
  return '.pn-status {' +
    '  position: fixed;' +
    '  ' + posCSS +
    '  background: rgba(0, 0, 0, 0.3);' +
    '  color: #fff;' +
    '  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;' +
    '  font-size: ' + s.font + 'px;' +
    '  padding: ' + s.pad + ';' +
    '  border-radius: 6px;' +
    '  backdrop-filter: blur(10px);' +
    '  -webkit-backdrop-filter: blur(10px);' +
    '  display: flex;' +
    '  align-items: center;' +
    '  gap: ' + s.gap + 'px;' +
    '  cursor: default;' +
    '  -webkit-user-select: none;' +
    '  user-select: none;' +
    '  -webkit-text-stroke: 0;' +
    '  text-shadow: none;' +
    '  -webkit-font-smoothing: antialiased;' +
    '  font-variant-numeric: tabular-nums;' +
    '}' +
    '.pn-dot {' +
    '  width: ' + s.dot + 'px;' +
    '  height: ' + s.dot + 'px;' +
    '  border-radius: 50%;' +
    '  display: inline-block;' +
    '}' +
    '.pn-dot.scanning {' +
    '  background: #fbbf24;' +
    '  animation: pulse 1s ease-in-out infinite;' +
    '}' +
    '.pn-dot.done { background: #34d399; }' +
    '.pn-dot.warn { background: #fb923c; }' +
    '.pn-dot.skip { background: #94a3b8; }' +
    '@keyframes pulse {' +
    '  0%, 100% { opacity: 1; }' +
    '  50% { opacity: 0.3; }' +
    '}';
}

/** Initialize or reinitialize the overlay with current preference settings. */
function initOverlay() {
  var position = preferences.get("osd_position") || "bottom-left";
  var size = preferences.get("osd_size") || "medium";
  overlay.simpleMode();
  overlay.setStyle(buildCSS(position, size));
  overlayReady = true;
}

var OSD_PREFIX = "Audio Normalize: ";

/**
 * Show a status indicator on the OSD overlay.
 * Duration 0 = stay until replaced (used by scanning progress).
 * Duration > 0 = auto-hide after the longer of: the passed duration or
 * a reading-time estimate (~120ms per character), ensuring long messages
 * stay visible long enough to read.
 */
function showStatus(dotClass, text, duration) {
  if (!overlayReady) return;
  overlay.setContent(
    '<div class="pn-status"><span class="pn-dot ' + dotClass + '"></span>' + OSD_PREFIX + text + '</div>'
  );
  overlay.show();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (duration > 0) {
    var readTime = (OSD_PREFIX.length + text.length) * 120;
    var effectiveDuration = Math.max(duration, readTime);
    hideTimer = setTimeout(function() { overlay.hide(); hideTimer = null; }, effectiveDuration);
  }
}

// =============================================================================
// AUDIO FILTERS
// =============================================================================

/** Remove all plugin-managed audio filters from mpv. */
function removeFilters() {
  try { mpv.command("af", ["remove", "@" + FILTER_DMX]); } catch (e) {}
  try { mpv.command("af", ["remove", "@" + FILTER_NORM]); } catch (e) {}
}

/** Return "+" for non-negative numbers, "" for negative (sign is already in the number). */
function signStr(n) { return n >= 0 ? "+" : ""; }

/** Format an array of tags like ["cached", "downmix"] into " (cached, downmix)". */
function formatTags(tags) {
  if (!tags || tags.length === 0) return "";
  return " (" + tags.join(", ") + ")";
}

/** Get the channel count of the current audio track. */
function getChannelCount() {
  try { return mpv.getNumber("audio-params/channel-count"); } catch (e) { return 2; }
}

/**
 * Apply enhanced 5.1→stereo downmix filter.
 * Uses full-weight center channel (clearer dialogue) and mixes in 50% LFE.
 * Standard 5.1 layout assumed: FL, FR, FC, LFE, SL, SR.
 */
function applyDownmix() {
  var channels = getChannelCount();
  if (channels <= 2) {
    console.log("Audio is " + channels + "ch, skipping downmix");
    return false;
  }
  console.log("Applying enhanced downmix (" + channels + "ch \u2192 stereo)");
  var pan = "pan=stereo|FL=FC+0.707*FL+0.707*SL+0.5*LFE|FR=FC+0.707*FR+0.707*SR+0.5*LFE";
  try {
    mpv.command("af", ["add", "@" + FILTER_DMX + ":lavfi=[" + pan + "]"]);
  } catch (e) {
    console.log("Downmix filter failed: " + e);
    return false;
  }
  return true;
}

// =============================================================================
// PEAK MODE
// =============================================================================

/** Validate that a cache entry has the required peak fields. */
function isValidPeakEntry(entry) {
  return entry && typeof entry.peak_db === "number" && !isNaN(entry.peak_db);
}

/** Apply a volume filter based on cached/scanned peak data. */
function applyPeakFilter(entry, targetPeak, showOsd, osdDuration, tags) {
  if (!isValidPeakEntry(entry)) {
    console.log("Invalid peak data, skipping");
    if (showOsd) showStatus("skip", "Invalid peak data", osdDuration);
    return;
  }
  var gain = targetPeak - entry.peak_db;
  // Skip filter if gain is less than 0.1 dB (inaudible)
  if (Math.abs(gain) < 0.1) {
    if (showOsd) showStatus("done", "Peak " + entry.peak_db.toFixed(1) + " dB" + formatTags(tags.concat(["no change"])), osdDuration);
    return;
  }
  try {
    mpv.command("af", ["add", "@" + FILTER_NORM + ":volume=volume=" + gain.toFixed(1) + "dB"]);
  } catch (e) {
    console.log("Failed to apply volume filter: " + e);
    if (showOsd) showStatus("skip", "Filter error", osdDuration);
    return;
  }
  if (showOsd) showStatus("done", "Peak " + signStr(gain) + gain.toFixed(1) + " dB" + formatTags(tags), osdDuration);
}

/**
 * Run ffmpeg volumedetect on a file and return { peak_db } or null.
 * Progress is reported via -progress pipe:1 (stdout) through the stdoutHook callback,
 * while results come from stderr — clean separation, no interference.
 */
async function scanPeak(filePath, ffmpegPath, onProgress) {
  var args = ["-nostdin", "-i", filePath, "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-threads", "4",
     "-af", "volumedetect", "-progress", "pipe:1", "-f", "null", "/dev/null"];
  var result = await utils.exec(ffmpegPath, args, undefined, onProgress);
  if (result.status !== 0) {
    console.log("ffmpeg volumedetect exited with status " + result.status);
    var tail = result.stderr ? result.stderr.slice(-500) : "(empty)";
    console.log("ffmpeg stderr: " + tail);
  }
  var match = result.stderr.match(/max_volume:\s*([+\-\d.]+)/);
  if (!match) return null;
  var val = parseFloat(match[1]);
  if (isNaN(val)) return null;
  return { peak_db: val };
}

// =============================================================================
// R128 MODE — EBUR128 (FAST SCAN, ~5× FASTER THAN LOUDNORM)
// =============================================================================

/**
 * Parse the ebur128 summary block from ffmpeg stderr.
 *
 * IMPORTANT: ebur128 outputs per-frame data AND a summary at the end.
 * Per-frame lines look like: "t: 0.4  M: -70.0  S: -70.0  I: -70.0 LUFS  LRA: 0.0 LU"
 * We must extract the Summary section first to avoid matching per-frame values.
 *
 * Note: ebur128 reports true peak in dBFS (sample-accurate), not dBTP
 * (which involves upsampling to 192kHz as per ITU-R BS.1770). For our
 * media player use case, the difference is negligible (<0.5 dB).
 *
 * Returns { loudness_lufs, true_peak_dbtp, loudness_range_lu, threshold_lufs } or null.
 */
function parseEbur128Summary(stderr) {
  // Extract only the Summary section (always at the end of stderr)
  var summaryMatch = stderr.match(/Summary:[\s\S]+$/);
  if (!summaryMatch) {
    console.log("ebur128: no Summary section found in output");
    return null;
  }
  var summary = summaryMatch[0];

  // Integrated loudness
  var iMatch = summary.match(/I:\s*([+\-\d.]+)\s*LUFS/);
  // Threshold under Integrated loudness section
  var threshMatch = summary.match(/Integrated loudness:[\s\S]*?Threshold:\s*([+\-\d.]+)\s*LUFS/);
  // LRA
  var lraMatch = summary.match(/LRA:\s*([+\-\d.]+)\s*LU/);
  // True peak — take the highest (least negative) across all channels
  var peaks = [];
  var peakRegex = /Peak:\s*([+\-\d.]+)\s*dBFS/g;
  var m;
  while ((m = peakRegex.exec(summary)) !== null) {
    peaks.push(parseFloat(m[1]));
  }

  if (!iMatch || !threshMatch || !lraMatch || peaks.length === 0) {
    console.log("ebur128: failed to parse summary fields");
    return null;
  }

  var data = {
    loudness_lufs: parseFloat(iMatch[1]),
    true_peak_dbtp: Math.max.apply(null, peaks),
    loudness_range_lu: parseFloat(lraMatch[1]),
    threshold_lufs: parseFloat(threshMatch[1])
  };

  var fields = ["loudness_lufs", "true_peak_dbtp", "loudness_range_lu", "threshold_lufs"];
  for (var i = 0; i < fields.length; i++) {
    if (typeof data[fields[i]] !== "number" || isNaN(data[fields[i]])) return null;
  }
  return data;
}

/** Fast R128 scan using ebur128 filter (~5× faster than loudnorm). */
async function scanEbur128(filePath, ffmpegPath, onProgress) {
  var args = ["-nostdin", "-i", filePath, "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-threads", "4",
     "-af", "ebur128=peak=true", "-progress", "pipe:1", "-f", "null", "/dev/null"];
  var result = await utils.exec(ffmpegPath, args, undefined, onProgress);
  if (result.status !== 0) {
    console.log("ffmpeg ebur128 exited with status " + result.status);
    // Log last 500 chars of stderr to diagnose failures (e.g. file not found, codec issues)
    var tail = result.stderr ? result.stderr.slice(-500) : "(empty)";
    console.log("ffmpeg stderr: " + tail);
  }
  return parseEbur128Summary(result.stderr);
}

// =============================================================================
// R128 MODE — LOUDNORM (SLOW SCAN, ONLY USED WHEN DYNAMIC COMPRESSION NEEDED)
// =============================================================================

/** Extract the loudnorm JSON block from ffmpeg stderr output. */
function parseR128Json(stderr) {
  var jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch (e) { return null; }
}

/**
 * Run loudnorm scan to get the target_offset value needed for two-pass dynamic compression.
 * This is the slow scan (~4 min for a 45-min file) — only called when ebur128 determines
 * that linear gain is insufficient and dynamic compression is needed.
 * Returns { offset_lu } or null.
 */
async function scanLoudnormOffset(filePath, ffmpegPath, preset, onProgress) {
  var p = R128_PRESETS[preset];
  var scanFilter = "loudnorm=I=" + p.I + ":TP=" + p.TP + ":LRA=" + p.LRA + ":print_format=json";
  var args = ["-nostdin", "-i", filePath, "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-threads", "4",
     "-af", scanFilter, "-progress", "pipe:1", "-f", "null", "/dev/null"];

  var result = await utils.exec(ffmpegPath, args, undefined, onProgress);
  if (result.status !== 0) {
    console.log("ffmpeg loudnorm exited with status " + result.status);
    var tail = result.stderr ? result.stderr.slice(-500) : "(empty)";
    console.log("ffmpeg stderr: " + tail);
  }

  var parsed = parseR128Json(result.stderr);
  if (!parsed) return null;

  var offset = parseFloat(parsed.target_offset);
  if (isNaN(offset)) return null;

  return { offset_lu: offset };
}

// =============================================================================
// R128 MODE — FILTER APPLICATION
// =============================================================================

/** Validate that a cache entry has all required R128 fields. */
function isValidR128Entry(entry) {
  if (!entry) return false;
  var fields = ["loudness_lufs", "true_peak_dbtp", "loudness_range_lu", "threshold_lufs"];
  for (var i = 0; i < fields.length; i++) {
    if (typeof entry[fields[i]] !== "number" || isNaN(entry[fields[i]])) return false;
  }
  return true;
}

/**
 * Check if linear gain alone can reach the LUFS target without exceeding the TP ceiling.
 * For linear, gain = target_I - measured_I (no loudnorm offset — offset only applies
 * to loudnorm's internal algorithm, not to a simple volume filter).
 */
function isLinearSufficient(entry, preset) {
  var p = R128_PRESETS[preset];
  if (!p) return false;
  var gain = p.I - entry.loudness_lufs;
  var projectedTP = entry.true_peak_dbtp + gain;
  return projectedTP <= p.TP + 0.1; // 0.1 dB tolerance for measurement rounding
}

/**
 * Apply R128 normalization filter.
 *
 * Strategy:
 *   1. Linear: simple volume filter (gain = target_I - measured_I, no offset)
 *   2. Dynamic (compression ≤ limit): loudnorm at full target with offset
 *   3. Capped (compression > limit): loudnorm at reduced target with offset
 */
function applyR128Filter(entry, preset, maxCompression, showOsd, osdDuration, tags) {
  if (!isValidR128Entry(entry)) {
    console.log("Invalid R128 data, skipping");
    if (showOsd) showStatus("skip", "Invalid R128 data", osdDuration);
    return;
  }

  var p = R128_PRESETS[preset];
  if (!p) {
    console.log("Unknown preset: " + preset);
    if (showOsd) showStatus("skip", "Unknown mode", osdDuration);
    return;
  }

  // Linear gain: target - measured (no offset, volume filter doesn't use loudnorm internals)
  var linearGain = p.I - entry.loudness_lufs;
  var projectedTP = entry.true_peak_dbtp + linearGain;

  // Dynamic gain: includes loudnorm offset if available
  var offset = (typeof entry.offset_lu === "number" && !isNaN(entry.offset_lu)) ? entry.offset_lu : 0;
  var dynGain = p.I - entry.loudness_lufs + offset;
  var maxLinearGain = p.TP - entry.true_peak_dbtp;

  console.log("Linear gain: " + linearGain.toFixed(1) + " dB, projected TP: " + projectedTP.toFixed(1) +
    " dBTP, offset: " + offset.toFixed(2));

  // Case 1: Linear — simple volume filter (stateless, no seek overhead)
  if (projectedTP <= p.TP + 0.1) {
    console.log("Strategy: linear (volume filter, " + linearGain.toFixed(1) + " dB)");
    try {
      mpv.command("af", ["add", "@" + FILTER_NORM + ":volume=volume=" + linearGain.toFixed(1) + "dB"]);
    } catch (e) {
      console.log("Failed to apply volume filter: " + e);
      if (showOsd) showStatus("skip", "Filter error", osdDuration);
      return;
    }
    var resultTags = (tags || []).concat(["linear"]);
    if (showOsd) showStatus("done",
      "R128 " + p.label + " " + signStr(linearGain) + linearGain.toFixed(1) + " dB" + formatTags(resultTags),
      osdDuration);
    return;
  }

  // Case 2: Dynamic compression needed
  var compressionNeeded = dynGain - maxLinearGain;
  console.log("Compression needed: " + compressionNeeded.toFixed(1) + " dB (limit: " + maxCompression + " dB)");

  var effectiveTarget;
  var capped = false;

  if (compressionNeeded <= maxCompression) {
    effectiveTarget = p.I;
    console.log("Strategy: dynamic, full target " + effectiveTarget + " LUFS");
  } else {
    // Reduce the LUFS target so compression stays within the allowed limit.
    // Formula: start from measured loudness, add the max safe linear gain, add allowed compression.
    effectiveTarget = entry.loudness_lufs + maxLinearGain + maxCompression;
    capped = true;
    console.log("Strategy: dynamic capped, effective target " + effectiveTarget.toFixed(1) +
      " LUFS (original " + p.I + " LUFS)");
  }

  // Build loudnorm filter with pre-measured values (two-pass mode).
  // This avoids loudnorm re-analyzing the audio and instead uses our cached measurements.
  var filter = "loudnorm=I=" + effectiveTarget.toFixed(1) + ":TP=" + p.TP + ":LRA=" + p.LRA +
    ":linear=false" +
    ":measured_I=" + entry.loudness_lufs +
    ":measured_TP=" + entry.true_peak_dbtp +
    ":measured_LRA=" + entry.loudness_range_lu +
    ":measured_thresh=" + entry.threshold_lufs +
    ":offset=" + offset;

  try {
    mpv.command("af", ["add", "@" + FILTER_NORM + ":lavfi=[" + filter + "]"]);
  } catch (e) {
    console.log("Failed to apply loudnorm filter: " + e);
    if (showOsd) showStatus("skip", "Filter error", osdDuration);
    return;
  }

  var totalGain = effectiveTarget - entry.loudness_lufs;
  if (showOsd) {
    if (capped) {
      var warnTags = (tags || []).concat(["capped"]);
      showStatus("warn",
        "R128 " + p.label + " " + signStr(totalGain) + totalGain.toFixed(1) +
        " dB, target was " + signStr(dynGain) + dynGain.toFixed(1) + formatTags(warnTags),
        osdDuration);
    } else {
      var compTags = (tags || []).concat(["compressed"]);
      showStatus("done",
        "R128 " + p.label + " " + signStr(dynGain) + dynGain.toFixed(1) + " dB" + formatTags(compTags),
        osdDuration);
    }
  }
}

// =============================================================================
// PROGRESS TRACKING
// =============================================================================

/**
 * Create a progress callback for ffmpeg's -progress pipe:1 output.
 * Updates OSD only when integer percentage changes (avoids webview flooding).
 * Logs to console every 10%.
 */
function createProgressHook(totalDurationSec, label, showOsd) {
  var lastLoggedPct = -10;
  var lastDisplayedPct = -1;

  return function(data) {
    if (!totalDurationSec || totalDurationSec <= 0) return;
    var match = data.match(/out_time_us=(\d+)/);
    if (!match) return;
    var currentUs = parseInt(match[1]);
    if (isNaN(currentUs) || currentUs < 0) return;
    var pct = Math.min(100, Math.round((currentUs / 1000000) / totalDurationSec * 100));
    if (showOsd && pct !== lastDisplayedPct) {
      lastDisplayedPct = pct;
      // Pad to 3 chars with figure spaces (\u2007) to prevent OSD width jitter
      var pctStr = (pct < 10 ? "\u2007\u2007" : pct < 100 ? "\u2007" : "") + pct + "%";
      showStatus("scanning", label + " " + pctStr, 0);
    }
    if (pct >= lastLoggedPct + 10) {
      lastLoggedPct = pct - (pct % 10);
      console.log("Scan progress: " + pct + "%");
    }
  };
}

/** Get the total duration of the current file from mpv. Returns 0 if unavailable. */
function getFileDuration() {
  try {
    var d = mpv.getNumber("duration");
    return (d && d > 0) ? d : 0;
  } catch (e) {
    return 0;
  }
}

// =============================================================================
// FFMPEG DETECTION
// =============================================================================

var FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg",  // Apple Silicon Homebrew
  "/usr/local/bin/ffmpeg",     // Intel Homebrew / manual install
  "/usr/bin/ffmpeg",           // System (rare on macOS)
  "/opt/local/bin/ffmpeg"      // MacPorts
];

/**
 * Find ffmpeg binary. Priority:
 *   1. User-configured absolute path
 *   2. User-configured name in PATH
 *   3. First known Homebrew/system location (absolute paths trusted, sandbox can't verify)
 *   4. Bare "ffmpeg" as last resort
 */
function findFfmpeg() {
  var custom = preferences.get("ffmpeg_path");
  if (custom && custom.charAt(0) === "/") return custom;
  if (custom && custom !== "ffmpeg" && utils.fileInPath(custom)) return custom;
  if (FFMPEG_PATHS.length > 0) return FFMPEG_PATHS[0];
  return "ffmpeg";
}

// =============================================================================
// INIT
// =============================================================================

loadCache();

var isEnabled = preferences.get("enabled") !== false;

// Menu: toggle enable/disable with checkmark
var toggleItem = menu.item("Audio Normalize", function() {
  isEnabled = !isEnabled;
  preferences.set("enabled", isEnabled);
  toggleItem.selected = isEnabled;
  menu.forceUpdate();

  if (isEnabled) {
    console.log("Enabled via menu");
    try {
      var path = mpv.getString("path");
      if (path) runAnalysis(false);
    } catch (e) {
      console.log("No file loaded, will analyze on next file");
    }
  } else {
    console.log("Disabled via menu, removing filters");
    removeFilters();
    showStatusSafe("skip", "Disabled");
  }
}, { selected: isEnabled });

menu.addItem(toggleItem);

// Menu: force reanalysis of current file
menu.addItem(menu.item("Reanalyze Current File", function() {
  try {
    var path = mpv.getString("path");
    if (path) {
      runAnalysis(true);
    } else {
      showStatusSafe("skip", "No file loaded");
    }
  } catch (e) {
    showStatusSafe("skip", "No file loaded");
  }
}));

// Menu: clear all cached analysis results
menu.addItem(menu.item("Clear All Cache", function() {
  clearCache();
}));

// =============================================================================
// EVENTS
// =============================================================================

event.on("iina.window-loaded", function() {
  initOverlay();
  console.log("Audio Normalize ready");
});

/**
 * Main analysis and filter application logic.
 *
 * For R128 modes, uses a two-stage strategy:
 *   Stage 1: ebur128 scan (fast, ~30-48s) — measures loudness and peak
 *   Stage 2: If linear gain works → apply immediately, done
 *            If dynamic needed → run loudnorm scan (~4min) for offset, then apply
 */
async function runAnalysis(forceRescan) {
  scanGeneration++;
  var myGeneration = scanGeneration;

  var mode = preferences.get("mode") || "peak";
  var showOsd = preferences.get("show_osd") !== false;
  var osdDuration = (parseInt(preferences.get("osd_duration")) || 4) * 1000;
  var ffmpegPath = findFfmpeg();
  var maxCompression = parseFloat(preferences.get("max_compression"));
  if (isNaN(maxCompression)) maxCompression = 6;
  var doDownmix = preferences.get("downmix") === true;

  // Guard: ensure a file is loaded
  var filePath;
  try {
    filePath = mpv.getString("path");
  } catch (e) {
    console.log("No file loaded");
    if (showOsd) showStatusSafe("skip", "No file loaded");
    return;
  }
  if (!filePath) { console.log("Empty file path"); return; }

  // Hide any previous OSD and cancel pending timer before reinitializing
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (overlayReady) overlay.hide();
  initOverlay();
  removeFilters();

  // Apply downmix filter (before normalization in the chain)
  var didDownmix = false;
  if (doDownmix) { didDownmix = applyDownmix(); }

  // Generate fingerprint for caching (null for streams/URLs)
  var fingerprint = await getFingerprint(filePath);
  // Fingerprinting is async (~70ms); check if a newer file was loaded while we waited
  if (myGeneration !== scanGeneration) {
    console.log("Scan aborted: newer file loaded during fingerprinting");
    return;
  }

  var cached = fingerprint ? cache[fingerprint] : null;
  // Cache entries are mode-specific: switching modes requires a rescan
  var cacheHit = !forceRescan && cached && cached.mode === mode;

  // Build OSD tags
  var tags = [];
  if (didDownmix) tags.push("downmix");

  try {
    // =================================================================
    // CACHE HIT — PEAK
    // =================================================================
    if (cacheHit && mode === "peak") {
      console.log("Cache hit (peak) for: " + fingerprint);
      var targetPeak = parseFloat(preferences.get("target_peak"));
      if (isNaN(targetPeak)) targetPeak = -1.0;
      applyPeakFilter(cached, targetPeak, showOsd, osdDuration, tags.concat(["cached"]));
      return;
    }

    // =================================================================
    // CACHE HIT — R128
    // =================================================================
    if (cacheHit && mode !== "peak") {
      console.log("Cache hit (" + mode + ") for: " + fingerprint);
      console.log("Cached R128: " + cached.loudness_lufs + " LUFS, TP " + cached.true_peak_dbtp + " dBTP");

      if (isLinearSufficient(cached, mode)) {
        // Linear path: offset not needed, ebur128 data is enough
        applyR128Filter(cached, mode, maxCompression, showOsd, osdDuration, tags.concat(["cached"]));
        return;
      }

      if (cached.offset_lu !== null && cached.offset_lu !== undefined) {
        // Dynamic path: offset was cached from a previous loudnorm scan
        applyR128Filter(cached, mode, maxCompression, showOsd, osdDuration, tags.concat(["cached"]));
        return;
      }

      // Dynamic needed but no offset cached — fall through to scan
      console.log("Cache hit but dynamic needed without offset — need loudnorm scan");
    }

    // =================================================================
    // SCAN — PEAK
    // =================================================================
    if (mode === "peak") {
      if (showOsd) showStatus("scanning", "Fast scan\u2026", 0);
      console.log("Peak scan: " + filePath);

      var duration = getFileDuration();
      var progressHook = createProgressHook(duration, "Fast scan\u2026", showOsd);
      var peakData = await scanPeak(filePath, ffmpegPath, progressHook);

      if (myGeneration !== scanGeneration) {
        console.log("Scan aborted: newer file loaded during peak scan");
        return;
      }
      if (!peakData) {
        console.log("Peak scan returned no data");
        if (showOsd) showStatus("skip", "No audio data", osdDuration);
        return;
      }

      console.log("Peak: " + peakData.peak_db + " dB");
      if (fingerprint) {
        cache[fingerprint] = { mode: mode, ts: Date.now(), peak_db: peakData.peak_db };
        saveCache();
      }

      var targetPeak = parseFloat(preferences.get("target_peak"));
      if (isNaN(targetPeak)) targetPeak = -1.0;
      applyPeakFilter(peakData, targetPeak, showOsd, osdDuration, tags);
      return;
    }

    // =================================================================
    // SCAN — R128 (TWO-STAGE: FAST EBUR128, THEN LOUDNORM IF NEEDED)
    // =================================================================

    console.log("R128 scan (" + mode + "): " + filePath);
    var duration = getFileDuration();
    var scanStartTime = Date.now();

    // --- Stage 1: Fast ebur128 scan ---
    if (showOsd) showStatus("scanning", "Fast scan\u2026", 0);
    var progressHook = createProgressHook(duration, "Fast scan\u2026", showOsd);
    var ebur128Data = await scanEbur128(filePath, ffmpegPath, progressHook);

    var ebur128ElapsedSec = ((Date.now() - scanStartTime) / 1000).toFixed(1);

    if (myGeneration !== scanGeneration) {
      console.log("Scan aborted: newer file loaded during ebur128 scan");
      return;
    }

    if (!ebur128Data) {
      console.log("ebur128 scan returned no data");
      if (showOsd) showStatus("skip", "Scan failed", osdDuration);
      return;
    }

    console.log("ebur128 result: " + ebur128Data.loudness_lufs + " LUFS, TP " +
      ebur128Data.true_peak_dbtp + " dBTP, LRA " + ebur128Data.loudness_range_lu +
      " LU (scanned in " + ebur128ElapsedSec + "s)");

    // --- Check if linear gain is sufficient ---
    if (isLinearSufficient(ebur128Data, mode)) {
      console.log("Linear sufficient — applied in " + ebur128ElapsedSec +
        "s (full loudnorm scan would have taken ~5\u00d7 longer)");

      if (fingerprint) {
        // Cache ebur128 data. offset_lu is null because linear gain doesn't need it;
        // if the user later changes settings so dynamic is needed, a loudnorm scan will run.
        cache[fingerprint] = {
          mode: mode, ts: Date.now(),
          loudness_lufs: ebur128Data.loudness_lufs,
          true_peak_dbtp: ebur128Data.true_peak_dbtp,
          loudness_range_lu: ebur128Data.loudness_range_lu,
          threshold_lufs: ebur128Data.threshold_lufs,
          offset_lu: null
        };
        saveCache();
      }

      applyR128Filter(ebur128Data, mode, maxCompression, showOsd, osdDuration, tags);
      return;
    }

    // --- Stage 2: Dynamic compression needed — run loudnorm for offset ---
    console.log("Dynamic compression needed, running loudnorm scan for offset...");
    if (showOsd) showStatus("scanning", "Deep scan\u2026", 0);

    var loudnormProgressHook = createProgressHook(duration, "Deep scan\u2026", showOsd);
    var loudnormResult = await scanLoudnormOffset(filePath, ffmpegPath, mode, loudnormProgressHook);

    if (myGeneration !== scanGeneration) {
      console.log("Scan aborted: newer file loaded during loudnorm scan");
      return;
    }

    var totalElapsedSec = ((Date.now() - scanStartTime) / 1000).toFixed(1);

    var offset = (loudnormResult && typeof loudnormResult.offset_lu === "number") ? loudnormResult.offset_lu : 0;
    if (!loudnormResult) {
      console.log("Loudnorm scan failed, using offset=0");
    } else {
      console.log("Loudnorm offset: " + offset.toFixed(2));
    }
    console.log("Full R128 analysis completed in " + totalElapsedSec + "s");

    // Merge ebur128 measurements with loudnorm offset
    var mergedData = {
      loudness_lufs: ebur128Data.loudness_lufs,
      true_peak_dbtp: ebur128Data.true_peak_dbtp,
      loudness_range_lu: ebur128Data.loudness_range_lu,
      threshold_lufs: ebur128Data.threshold_lufs,
      offset_lu: offset
    };

    if (fingerprint) {
      cache[fingerprint] = {
        mode: mode, ts: Date.now(),
        loudness_lufs: mergedData.loudness_lufs,
        true_peak_dbtp: mergedData.true_peak_dbtp,
        loudness_range_lu: mergedData.loudness_range_lu,
        threshold_lufs: mergedData.threshold_lufs,
        offset_lu: mergedData.offset_lu
      };
      saveCache();
    }

    applyR128Filter(mergedData, mode, maxCompression, showOsd, osdDuration, tags);

  } catch (err) {
    console.log("Analysis error: " + err);
    if (showOsd) showStatus("skip", "Error", osdDuration);
  }
}

// Trigger analysis on every file load (if enabled)
event.on("iina.file-loaded", async function() {
  // Sync menu checkmark with preference (in case changed via preferences page)
  var prefEnabled = preferences.get("enabled") !== false;
  if (prefEnabled !== isEnabled) {
    isEnabled = prefEnabled;
    toggleItem.selected = isEnabled;
    menu.forceUpdate();
  }
  if (!isEnabled) return;
  await runAnalysis(false);
});
