# iina-audio-normalize

Automatic audio normalization for IINA. Analyzes each file on playback and applies gain to bring the volume to a consistent level.

> **Note:** requires ffmpeg and IINA 1.4.0 or later. Tested on macOS Tahoe 26.3.1 with IINA 1.4.1.

---

## Features

- **Three normalization modes** — peak, R128 YouTube (−14 LUFS), R128 Broadcast (−24 LUFS)
- **Two-stage R128 scan** — fast ebur128 measurement (~30s), slow loudnorm only when dynamic compression is needed (~4min). Most well-mastered content finishes in under a minute.
- **Hybrid R128 compression** — linear gain when possible, dynamic compression only when needed, capped to prevent artifacts
- **Analysis caching** — BLAKE3/xxHash/SHA256 fingerprinting with automatic expiry
- **Enhanced 5.1 downmix** — full-weight center channel for clearer dialogue, LFE preserved instead of discarded
- **Configurable OSD** — position, size, minimum duration (auto-extends for longer messages), toggle on/off
- **Stale scan protection** — rapidly switching files discards outdated analysis results
- **Streaming support** — works on URLs and streams (without caching)
- **Auto-detect ffmpeg** — checks Homebrew and system paths automatically

---

## Dependencies

All dependencies are installed via [Homebrew](https://brew.sh). If you don't have Homebrew, open Terminal and run:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Required:**

- **ffmpeg** — `brew install ffmpeg`. The plugin auto-detects `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg`, or you can set a custom path in preferences.

**Optional (faster file fingerprinting):**

- **b3sum** — BLAKE3 hash, ~71 ms for a 3 GB file. `brew install b3sum`
- **xxhsum** — xxHash, ~149 ms for a 3 GB file. `brew install xxhash`

Without either, the plugin falls back to OpenSSL SHA256 (~560 ms for 3 GB), which is built into macOS.

---

## Install

### From GitHub (recommended)

1. Open IINA
2. Go to **IINA → Settings → Plugin**
3. Click the **+** button and enter `Gabe-LS/iina-audio-normalize`
4. IINA will check for updates automatically

### Manual

1. Download or clone this repository
2. Copy the contents to `~/Library/Application Support/com.colliderli.iina/plugins/io.github.audio-normalize.iinaplugin/`
3. Restart IINA

---

## How it works

When you open a video, the plugin:

1. Fingerprints the file using BLAKE3, xxHash, or SHA256 (whichever is fastest and available)
2. Checks its local cache — if this file was already analyzed, skips straight to step 5
3. Runs a fast scan using ffmpeg's ebur128 filter (~30s for a 45-min episode)
4. If linear gain is sufficient, applies immediately. If dynamic compression is needed, runs a full loudnorm scan (~4 min) to get precise offset data.
5. Calculates the appropriate gain and applies it as an mpv audio filter
6. Shows the result on the OSD indicator: `Audio Normalize: R128 YT +3.2 dB (linear, cached)`

---

## Modes

| Mode | Target | Method |
|------|--------|--------|
| Peak normalize | −1.0 dB (configurable) | Flat linear gain to bring the sample peak to the target |
| R128 YouTube | −14 LUFS, TP −1 dBTP | EBU R128 loudness normalization |
| R128 Broadcast | −24 LUFS, TP −2 dBTP | EBU R128 loudness normalization |

R128 modes use a hybrid strategy:

- **Linear** — if the needed gain keeps the true peak below the ceiling, a simple stateless volume filter is applied (no seek overhead, no compression artifacts)
- **Dynamic** — if linear gain would clip, the loudnorm filter is used with dynamic compression, limited by a configurable maximum (default 6 dB) to prevent unnatural results
- **Capped** — if the compression needed exceeds the limit, the LUFS target is reduced to stay within the allowed compression range

---

## Settings

All settings are in **IINA → Settings → Plugin → Audio Normalize → Preferences**.

| Setting | Default | Description |
|---------|---------|-------------|
| Enable normalization | On | Master toggle (also available in Plugin menu) |
| Mode | Peak | Peak, R128 YouTube (−14 LUFS), or R128 Broadcast (−24 LUFS) |
| Target peak (dB) | −1.0 | Peak mode only — the sample peak ceiling |
| Max compression (dB) | 6 | R128 modes only — limits dynamic compression to prevent artifacts |
| Enhanced 5.1→stereo downmix | Off | Full-weight center channel + 50% LFE mix-in (only for surround audio) |
| Show on-screen indicator | On | OSD overlay during analysis and on result |
| Indicator position | Bottom left | Top left, top right, bottom left, or bottom right |
| Indicator size | Medium | Tiny, small, medium, or large |
| OSD duration (s) | 4 | Minimum display time; automatically extended for longer messages based on reading time |
| Cache retention (months) | 3 | Analysis results older than this are pruned on launch |
| ffmpeg path | auto-detect | Override if ffmpeg is in a non-standard location |

---

## Plugin menu

Under **Plugin → Audio Normalize** in the menu bar:

- **✓ Audio Normalize** — toggle on/off. Disabling removes filters immediately from the current playback. Enabling re-analyzes and applies to the current file.
- **Reanalyze Current File** — clears the cached result for the current file and runs a fresh analysis
- **Clear All Cache** — deletes all cached analysis results

---

## OSD indicators

All messages are prefixed with `Audio Normalize:`.

| Dot color | Meaning | Example |
|-----------|---------|---------|
| Yellow (pulsing) | Scanning in progress | `Fast scan… 34%`, `Deep scan… 52%` |
| Green | Filter applied | `R128 YT +3.2 dB (linear, cached)` |
| Orange | Filter applied, LUFS target was capped | `R128 YT +7.0 dB, target was +14.8 (capped)` |
| Grey | Skipped, error, or disabled | `Disabled`, `No audio data` |

Tags in parentheses provide context: `linear` (volume filter), `compressed` (loudnorm filter), `capped` (target reduced), `cached` (from cache), `downmix` (5.1→stereo active), `no change` (already at target).

---

## Cache

Analysis results are cached to avoid re-scanning files you've already watched. The cache is stored in the plugin's data directory as a JSON file.

- **Fingerprinting** — each file is identified by a full-file hash (BLAKE3 → xxHash → SHA256, in order of availability). Renamed or moved files with the same content produce the same fingerprint.
- **One entry per file** — switching normalization modes overwrites the cached entry and triggers a rescan
- **Settings changes that don't require rescanning** — target peak, max compression, downmix, and all OSD settings are computed on playback from cached measurements
- **Auto-pruning** — entries older than the configured retention period (default 3 months) are removed on launch
- **Streams** — URLs and non-local files are analyzed but not cached

---

## Technical details

<details>
<summary>Click to expand</summary>

**Two-stage R128 scan**

R128 analysis uses two ffmpeg filters with very different performance characteristics:

| Filter | Speed (45-min 5.1 file) | Purpose |
|--------|------------------------|---------|
| ebur128 | ~30 seconds | Measures integrated loudness, true peak, LRA, threshold |
| loudnorm | ~4 minutes | Same measurements plus `target_offset` for two-pass normalization |

The plugin always runs ebur128 first (fast scan). If the file can be normalized with simple linear gain (a stateless volume filter), the result is applied immediately — no need for the slow loudnorm scan. Only when dynamic compression is required does the plugin run the full loudnorm scan (deep scan) to obtain the `target_offset` value needed for loudnorm's two-pass mode.

Benchmarking showed that loudnorm is ~20× slower than raw audio decoding, while ebur128 is only ~4× slower. The bottleneck is loudnorm's internal processing (true peak upsampling to 192kHz, normalization curve computation), not audio decoding.

**ffmpeg flags**

Both scans use: `-map 0:a:0` (first audio stream only), `-vn -sn` (skip video and subtitle decoding), `-ac 2` (downmix to stereo for faster processing), `-threads 4` (parallelize audio decoder), `-progress pipe:1` (machine-readable progress to stdout, keeping results in stderr separate).

**R128 hybrid strategy**

Given measured values from ebur128 (integrated loudness, true peak, loudness range, threshold):

1. Calculate the gain needed to reach the LUFS target
2. Calculate the maximum gain that keeps true peak below the ceiling
3. If the needed gain fits within the peak ceiling → apply as a simple `volume` filter (stateless, zero seek overhead)
4. If not, calculate how much dynamic compression is required beyond the linear maximum
5. If compression ≤ max_compression setting → apply `loudnorm` at the full LUFS target
6. If compression > max_compression → reduce the LUFS target so that compression stays within the limit

Step 3 is important for seek performance: the `loudnorm` filter maintains internal state (sliding windows, lookahead buffers) that must be rebuilt on every seek. The `volume` filter is a stateless multiplier with zero overhead. Using `volume` for the linear case means most well-mastered content gets instant seeking.

For the linear case, the loudnorm `target_offset` is not needed — gain is simply `target_I − measured_I`. The offset only matters for loudnorm's internal two-pass algorithm.

**Downmix matrix**

The enhanced downmix replaces mpv's default ITU matrix with:

```
FL = FC + 0.707×FL + 0.707×SL + 0.5×LFE
FR = FC + 0.707×FR + 0.707×SR + 0.5×LFE
```

Differences from default: center channel gets full weight (1.0 instead of 0.707) for louder dialogue, and 50% of the LFE is mixed in instead of being discarded entirely. Standard 5.1 channel layout assumed (FL, FR, FC, LFE, SL, SR).

**Fingerprint cascade**

| Tool | Speed (3 GB file) | Availability |
|------|-------------------|--------------|
| b3sum (BLAKE3) | ~71 ms | `brew install b3sum` |
| xxhsum (xxHash64) | ~149 ms | `brew install xxhash` |
| openssl sha256 | ~560 ms | Built into macOS |

The plugin tries each in order and uses the first one that succeeds. BLAKE3 is fastest because it parallelizes across all CPU cores. All three produce full-file hashes — no sampling or partial reads.

**Cache structure**

```json
{
  "de6a39b57b621ab4...": {
    "mode": "r128-youtube",
    "ts": 1745370000000,
    "loudness_lufs": -27,
    "true_peak_dbtp": -2,
    "loudness_range_lu": 13.8,
    "threshold_lufs": -38.5,
    "offset_lu": 1.83
  }
}
```

One entry per file fingerprint. The `ts` field is a Unix timestamp in milliseconds used for auto-pruning. Switching modes overwrites the entry. Settings like target peak and max compression are not stored — they're computed on playback from the cached measurements. `offset_lu` is `null` for files where linear gain was sufficient (no loudnorm scan was needed); if the user later changes settings so dynamic compression is required, a loudnorm scan runs to obtain it.

**Known limitations**

- Fast scan (ebur128) takes ~30 seconds for a 45-minute 5.1 episode. If dynamic compression is needed, the full loudnorm scan adds ~4 more minutes. Cached files are instant on subsequent plays.
- Abandoned ffmpeg scans (when you skip files rapidly) run to completion in the background because IINA's plugin API does not support process cancellation. Their results are discarded.
- The ebur128 filter measures true peak in dBFS (sample-accurate) rather than dBTP (upsampled to 192kHz per ITU-R BS.1770). The difference is negligible for media player use (<0.5 dB).
- The downmix matrix assumes a standard 5.1 channel layout. 7.1 or non-standard layouts may produce unexpected results.

**Files**

| File | Purpose |
|------|---------|
| `Info.json` | Plugin metadata, defaults, permissions |
| `main.js` | Plugin logic |
| `preferences.html` | Settings UI |

</details>

---

## Something not working?

Open an issue at [github.com/Gabe-LS/iina-audio-normalize/issues](https://github.com/Gabe-LS/iina-audio-normalize/issues)

---

## License

MIT License — Copyright (c) 2026 Gabriele Lo Surdo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
