// =============================================================================
// Audio Normalize — IINA Plugin
// =============================================================================
// Normalizes audio playback using peak or EBU R128 loudness analysis.
// Supports caching of analysis results with BLAKE3/xxHash/SHA256 fingerprinting.
//
// Modes:
//   - Peak: flat linear gain to bring the sample peak to a target dB
//   - R128 YouTube (-14 LUFS): EBU R128 with hybrid linear/dynamic compression
//   - R128 Broadcast (-24 LUFS): EBU R128 with hybrid linear/dynamic compression
//
// Cache structure (one entry per file, overwritten on mode change):
//   { "fingerprint": { mode, ts, peak_db } }                          — peak
//   { "fingerprint": { mode, ts, loudness_lufs, true_peak_dbtp, … } } — R128
//
// Dependencies: ffmpeg (required), b3sum/xxhsum (optional, faster hashing)
// =============================================================================

var { core, event, mpv, overlay, utils, console, preferences, file, menu } = iina;

// --- CONSTANTS ---

var FILTER_NORM = "audionorm";       // mpv af label for normalization filter
var FILTER_DMX = "audionorm-dmx";    // mpv af label for downmix filter
var CACHE_PATH = "@data/cache.json"; // plugin data directory
var hideTimer = null;
var overlayReady = false;
var cache = {};
var scanGeneration = 0;              // incremented per analysis to detect stale scans
                                     // NOTE: abandoned ffmpeg processes run to completion
                                     // because IINA's utils.exec has no cancellation API.
                                     // Results are discarded via generation check, but CPU
                                     // is consumed until the process finishes naturally.

// R128 target presets: I = integrated loudness (LUFS), TP = true peak (dBTP), LRA = loudness range (LU)
var R128_PRESETS = {
  "r128-youtube":   { I: -14, TP: -1, LRA: 11, label: "YT" },
  "r128-broadcast": { I: -24, TP: -2, LRA: 11, label: "TV" }
};

// OSD indicator sizes
var SIZE_MAP = {
  tiny:   { font: 9,  pad: "4px 9px",  dot: 4, gap: 6 },
  small:  { font: 11, pad: "5px 10px", dot: 5, gap: 7 },
  medium: { font: 13, pad: "6px 12px", dot: 6, gap: 8 },
  large:  { font: 15, pad: "7px 14px", dot: 7, gap: 9 }
};

var EDGE = "20px"; // distance from video border for all OSD positions

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
    if (file.exists(CACHE_PATH)) {
      file.delete(CACHE_PATH);
    }
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
    console.log("OSD (no window): " + text);
  }
}

// =============================================================================
// FINGERPRINT
// =============================================================================

/** Check if a path is a local file (not a URL/stream). */
function isLocalFile(path) {
  if (!path) return false;
  // URLs start with protocol://
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

  // Try BLAKE3: parallelized, ~71ms for 3GB
  try {
    var b3Path = findTool(["/opt/homebrew/bin/b3sum", "/usr/local/bin/b3sum"]);
    if (b3Path) {
      var result = await utils.exec(b3Path, ["--no-names", filePath]);
      var hash = result.stdout.trim();
      if (hash) {
        console.log("blake3: " + hash.substring(0, 16) + "\u2026");
        return hash;
      }
    }
  } catch (e) {}

  // Try xxHash64: ~149ms for 3GB
  try {
    var xxhPath = findTool(["/opt/homebrew/bin/xxhsum", "/usr/local/bin/xxhsum"]);
    if (xxhPath) {
      var result = await utils.exec(xxhPath, ["-H1", filePath]);
      var hash = result.stdout.trim().split(/\s+/)[0];
      if (hash) {
        console.log("xxh64: " + hash);
        return hash;
      }
    }
  } catch (e) {}

  // Fallback: OpenSSL SHA256 (~560ms for 3GB, guaranteed on all Macs)
  try {
    console.log("Using openssl sha256 fallback");
    var result = await utils.exec("openssl", ["dgst", "-sha256", filePath]);
    var match = result.stdout.match(/=\s*([0-9a-f]+)/);
    if (match) {
      console.log("sha256: " + match[1].substring(0, 16) + "\u2026");
      return match[1];
    }
  } catch (e) {}

  console.log("All fingerprint methods failed, caching disabled for this file");
  return null;
}

/** Find the first available tool from a list of absolute paths. */
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

function buildCSS(position, size) {
  var s = SIZE_MAP[size] || SIZE_MAP.medium;
  var posCSS = getPositionCSS(position);

  return '.pn-status {' +
    '  position: fixed;' +
    '  ' + posCSS +
    '  background: rgba(0, 0, 0, 0.4);' +
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

/** Show a status indicator on the OSD overlay. Duration 0 = stay until replaced. */
function showStatus(dotClass, text, duration) {
  if (!overlayReady) return;
  overlay.setContent(
    '<div class="pn-status"><span class="pn-dot ' + dotClass + '"></span>' + text + '</div>'
  );
  overlay.show();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (duration > 0) {
    hideTimer = setTimeout(function() { overlay.hide(); hideTimer = null; }, duration);
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
 * Returns true if downmix was applied, false if skipped (stereo or mono source).
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
    if (showOsd) showStatus("skip", "Peak: invalid data", osdDuration);
    return;
  }

  var gain = targetPeak - entry.peak_db;

  if (Math.abs(gain) < 0.1) {
    if (showOsd) showStatus("done", "Peak " + entry.peak_db.toFixed(1) + " dB \u2014 OK" + formatTags(tags), osdDuration);
    return;
  }

  try {
    mpv.command("af", ["add", "@" + FILTER_NORM + ":volume=volume=" + gain.toFixed(1) + "dB"]);
  } catch (e) {
    console.log("Failed to apply volume filter: " + e);
    if (showOsd) showStatus("skip", "Peak: filter error", osdDuration);
    return;
  }
  if (showOsd) showStatus("done", "Peak: " + signStr(gain) + gain.toFixed(1) + " dB" + formatTags(tags), osdDuration);
}

/** Run ffmpeg volumedetect on a file and return { peak_db } or null. */
async function scanPeak(filePath, ffmpegPath) {
  var result = await utils.exec(ffmpegPath,
    ["-nostdin", "-i", filePath, "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-threads", "4",
     "-af", "volumedetect", "-f", "null", "/dev/null"]);

  if (result.status !== 0) {
    console.log("ffmpeg exited with status " + result.status + ", attempting to parse output anyway");
  }

  var match = result.stderr.match(/max_volume:\s*([+\-\d.]+)/);
  if (!match) return null;

  var val = parseFloat(match[1]);
  if (isNaN(val)) return null;

  return { peak_db: val };
}

// =============================================================================
// R128 MODE
// =============================================================================

/** Extract the loudnorm JSON block from ffmpeg stderr output. */
function parseR128Json(stderr) {
  var jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch (e) { return null; }
}

/** Validate that a cache entry has all required R128 fields. */
function isValidR128Entry(entry) {
  if (!entry) return false;
  var fields = ["loudness_lufs", "true_peak_dbtp", "loudness_range_lu", "threshold_lufs", "offset_lu"];
  for (var i = 0; i < fields.length; i++) {
    if (typeof entry[fields[i]] !== "number" || isNaN(entry[fields[i]])) return false;
  }
  return true;
}

/**
 * Apply R128 normalization filter based on cached/scanned measurements.
 *
 * Strategy:
 *   1. If linear gain alone keeps TP within ceiling → use simple volume filter (stateless, no seek overhead)
 *   2. If compression needed ≤ max_compression → use loudnorm at full target
 *   3. If compression needed > max_compression → use loudnorm at capped target to limit artifacts
 */
function applyR128Filter(entry, preset, maxCompression, showOsd, osdDuration, tags) {
  if (!isValidR128Entry(entry)) {
    console.log("Invalid R128 data, skipping");
    if (showOsd) showStatus("skip", "R128: invalid data", osdDuration);
    return;
  }

  var p = R128_PRESETS[preset];
  if (!p) {
    console.log("Unknown preset: " + preset);
    if (showOsd) showStatus("skip", "R128: unknown mode", osdDuration);
    return;
  }

  var neededGain = p.I - entry.loudness_lufs + entry.offset_lu;
  var maxLinearGain = p.TP - entry.true_peak_dbtp;
  var projectedTP = entry.true_peak_dbtp + neededGain;

  console.log("Needed gain: " + neededGain.toFixed(1) + " dB, max linear: " +
    maxLinearGain.toFixed(1) + " dB, projected TP: " + projectedTP.toFixed(1) + " dBTP");

  // Case 1: Linear — use simple volume filter (stateless, no seek overhead)
  if (projectedTP <= p.TP + 0.1) {
    console.log("Strategy: linear (volume filter, " + neededGain.toFixed(1) + " dB)");
    try {
      mpv.command("af", ["add", "@" + FILTER_NORM + ":volume=volume=" + neededGain.toFixed(1) + "dB"]);
    } catch (e) {
      console.log("Failed to apply volume filter: " + e);
      if (showOsd) showStatus("skip", "R128: filter error", osdDuration);
      return;
    }

    var resultTags = (tags || []).concat(["linear"]);
    if (showOsd) showStatus("done",
      "R128 " + p.label + ": " + signStr(neededGain) + neededGain.toFixed(1) + " dB" + formatTags(resultTags),
      osdDuration);
    return;
  }

  // Case 2: Dynamic compression needed
  var compressionNeeded = neededGain - maxLinearGain;
  console.log("Compression needed: " + compressionNeeded.toFixed(1) + " dB (limit: " + maxCompression + " dB)");

  var effectiveTarget;
  var capped = false;

  if (compressionNeeded <= maxCompression) {
    effectiveTarget = p.I;
    console.log("Strategy: dynamic, full target " + effectiveTarget + " LUFS");
  } else {
    // Cap the target to limit compression artifacts
    effectiveTarget = entry.loudness_lufs + maxLinearGain + maxCompression;
    capped = true;
    console.log("Strategy: dynamic capped, effective target " + effectiveTarget.toFixed(1) +
      " LUFS (original " + p.I + " LUFS)");
  }

  var filter = "loudnorm=I=" + effectiveTarget.toFixed(1) + ":TP=" + p.TP + ":LRA=" + p.LRA +
    ":linear=false" +
    ":measured_I=" + entry.loudness_lufs +
    ":measured_TP=" + entry.true_peak_dbtp +
    ":measured_LRA=" + entry.loudness_range_lu +
    ":measured_thresh=" + entry.threshold_lufs +
    ":offset=" + entry.offset_lu;

  try {
    mpv.command("af", ["add", "@" + FILTER_NORM + ":lavfi=[" + filter + "]"]);
  } catch (e) {
    console.log("Failed to apply loudnorm filter: " + e);
    if (showOsd) showStatus("skip", "R128: filter error", osdDuration);
    return;
  }

  var totalGain = effectiveTarget - entry.loudness_lufs;
  if (showOsd) {
    if (capped) {
      var warnTags = (tags || []).concat(["capped"]);
      showStatus("warn",
        "R128 " + p.label + ": " + signStr(totalGain) + totalGain.toFixed(1) +
        " dB, target was " + signStr(neededGain) + neededGain.toFixed(1) + formatTags(warnTags),
        osdDuration);
    } else {
      var compTags = (tags || []).concat(["compressed"]);
      showStatus("done",
        "R128 " + p.label + ": " + signStr(neededGain) + neededGain.toFixed(1) + " dB" + formatTags(compTags),
        osdDuration);
    }
  }
}

/** Run ffmpeg loudnorm scan on a file and return measurement object or null. */
async function scanR128(filePath, ffmpegPath, preset) {
  var p = R128_PRESETS[preset];
  var scanFilter = "loudnorm=I=" + p.I + ":TP=" + p.TP + ":LRA=" + p.LRA + ":print_format=json";

  var result = await utils.exec(ffmpegPath,
    ["-nostdin", "-i", filePath, "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-threads", "4",
     "-af", scanFilter, "-f", "null", "/dev/null"]);

  if (result.status !== 0) {
    console.log("ffmpeg exited with status " + result.status + ", attempting to parse output anyway");
  }

  var measured = parseR128Json(result.stderr);
  if (!measured) return null;

  var data = {
    loudness_lufs: parseFloat(measured.input_i),
    true_peak_dbtp: parseFloat(measured.input_tp),
    loudness_range_lu: parseFloat(measured.input_lra),
    threshold_lufs: parseFloat(measured.input_thresh),
    offset_lu: parseFloat(measured.target_offset)
  };

  // Validate parsed values
  if (!isValidR128Entry(data)) return null;

  return data;
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
 *   3. First known Homebrew/system location
 *   4. Bare "ffmpeg" as last resort
 */
function findFfmpeg() {
  var custom = preferences.get("ffmpeg_path");
  if (custom && custom.charAt(0) === "/") return custom;
  if (custom && custom !== "ffmpeg" && utils.fileInPath(custom)) return custom;
  // Default to first known location (absolute paths trusted, sandbox can't verify)
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
    // Only run analysis if a file is currently loaded
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
 * Called on file-loaded, menu toggle (enable), and reanalyze.
 *
 * @param {boolean} forceRescan - If true, ignore cache and re-scan the file.
 */
async function runAnalysis(forceRescan) {
  // Capture scan generation to detect if a newer scan supersedes this one
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

  if (!filePath) {
    console.log("Empty file path");
    return;
  }

  initOverlay();
  removeFilters();

  // Apply downmix filter (before normalization in the chain)
  var didDownmix = false;
  if (doDownmix) {
    didDownmix = applyDownmix();
  }

  // Generate fingerprint for caching (null for streams/URLs)
  var fingerprint = await getFingerprint(filePath);

  // Stale scan check: if another file was loaded during fingerprinting, abort
  if (myGeneration !== scanGeneration) {
    console.log("Scan aborted: newer file loaded during fingerprinting");
    return;
  }

  var cached = fingerprint ? cache[fingerprint] : null;
  var cacheHit = !forceRescan && cached && cached.mode === mode;

  // Build OSD tags for the result message
  var tags = [];
  if (didDownmix) tags.push("downmix");

  try {
    if (cacheHit) {
      console.log("Cache hit (" + mode + ") for: " + fingerprint);
      var hitTags = tags.concat(["cached"]);

      if (mode === "peak") {
        var targetPeak = parseFloat(preferences.get("target_peak"));
        if (isNaN(targetPeak)) targetPeak = -1.0;
        applyPeakFilter(cached, targetPeak, showOsd, osdDuration, hitTags);
      } else {
        console.log("Cached R128: " + cached.loudness_lufs + " LUFS, TP " + cached.true_peak_dbtp + " dBTP");
        applyR128Filter(cached, mode, maxCompression, showOsd, osdDuration, hitTags);
      }
      return;
    }

    // --- SCAN ---

    if (mode === "peak") {
      if (showOsd) showStatus("scanning", "Analyzing peak\u2026", 0);
      console.log("Peak scan: " + filePath);

      var peakData = await scanPeak(filePath, ffmpegPath);

      // Stale scan check
      if (myGeneration !== scanGeneration) {
        console.log("Scan aborted: newer file loaded during peak scan");
        return;
      }

      if (!peakData) {
        console.log("Peak scan returned no data");
        if (showOsd) showStatus("skip", "Peak: no audio data", osdDuration);
        return;
      }

      console.log("Peak: " + peakData.peak_db + " dB");

      // Cache the result
      if (fingerprint) {
        cache[fingerprint] = { mode: mode, ts: Date.now(), peak_db: peakData.peak_db };
        saveCache();
      }

      var targetPeak = parseFloat(preferences.get("target_peak"));
      if (isNaN(targetPeak)) targetPeak = -1.0;
      applyPeakFilter(peakData, targetPeak, showOsd, osdDuration, tags);

    } else {
      if (showOsd) showStatus("scanning", "Analyzing loudness\u2026", 0);
      console.log("R128 scan (" + mode + "): " + filePath);

      var r128Data = await scanR128(filePath, ffmpegPath, mode);

      // Stale scan check
      if (myGeneration !== scanGeneration) {
        console.log("Scan aborted: newer file loaded during R128 scan");
        return;
      }

      if (!r128Data) {
        console.log("R128 scan returned no data");
        if (showOsd) showStatus("skip", "R128: scan failed", osdDuration);
        return;
      }

      console.log("Measured: " + r128Data.loudness_lufs + " LUFS, TP " + r128Data.true_peak_dbtp + " dBTP");

      // Cache the result
      if (fingerprint) {
        cache[fingerprint] = {
          mode: mode,
          ts: Date.now(),
          loudness_lufs: r128Data.loudness_lufs,
          true_peak_dbtp: r128Data.true_peak_dbtp,
          loudness_range_lu: r128Data.loudness_range_lu,
          threshold_lufs: r128Data.threshold_lufs,
          offset_lu: r128Data.offset_lu
        };
        saveCache();
      }

      applyR128Filter(r128Data, mode, maxCompression, showOsd, osdDuration, tags);
    }

  } catch (err) {
    console.log("Analysis error: " + err);
    if (showOsd) showStatus("skip", "Normalize: error", osdDuration);
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
