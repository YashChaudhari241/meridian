// Emote-surge detection for timeline highlights.
//
// Goal: when enough *unique viewers* type the same emote within a short window, emit a
// "highlight". Designed for high message throughput — O(1) work per emote occurrence, no
// per-message storage. We keep one small bucket per distinct emote currently in its window.
//
// Uniqueness: a `Set` of user logins per bucket means one viewer counts once no matter how
// many times (or in how many messages) they spam the same emote.

// Minimum unique viewers per window for an emote highlight — floor enforced here so the
// timeline never clutters with low-signal surges.
export const MIN_EMOTE_THRESHOLD = 3;

export class HighlightEngine {
  constructor({ windowMs = 12000, getThreshold, onHighlight, onUpdate } = {}) {
    this.windowMs = windowMs;
    this.getThreshold = getThreshold || (() => MIN_EMOTE_THRESHOLD);
    this.onHighlight = onHighlight || (() => {});
    this.onUpdate = onUpdate || (() => {});
    this.buckets = new Map(); // emoteName -> { firstTs, users:Set, triggered, peak, threshold, key, url }
    this._seq = 0;
  }

  // Record one (emote, user) occurrence at wall-clock `ts`. `url` is the emote image.
  ingest(name, url, user, ts) {
    if (!name || !user) return;
    let b = this.buckets.get(name);
    if (!b || ts - b.firstTs > this.windowMs) {
      // Start a fresh tumbling window anchored at the first occurrence.
      b = { firstTs: ts, users: new Set(), triggered: false, peak: 0, threshold: 0, key: null, url };
      this.buckets.set(name, b);
    }
    if (b.users.has(user)) return; // unique viewers only
    b.users.add(user);
    const count = b.users.size;
    if (!b.triggered) {
      const thr = Math.max(MIN_EMOTE_THRESHOLD, this.getThreshold() | 0);
      if (count >= thr) {
        b.triggered = true;
        b.threshold = thr;
        b.peak = count;
        b.key = `${name}|${b.firstTs}|${++this._seq}`;
        this.onHighlight({ key: b.key, name, url: b.url, firstTs: b.firstTs, count, threshold: thr });
      }
    } else if (count > b.peak) {
      // Same surge growing — report increased intensity, don't make a new highlight.
      b.peak = count;
      this.onUpdate({ key: b.key, name, count, threshold: b.threshold });
    }
  }

  // Drop expired buckets so memory stays bounded by emotes seen in the last window.
  prune(now) {
    for (const [name, b] of this.buckets) {
      if (now - b.firstTs > this.windowMs) this.buckets.delete(name);
    }
  }

  reset() { this.buckets.clear(); }
}

// Chat-activity density over the stream timeline — drives the "most-replayed"-style wave.
//
// We accumulate a weight (messages + distinct emotes) per fixed-size *base* bucket keyed by
// video-time seconds. Rendering aggregates base buckets up to an adaptive display resolution,
// so changing the display resolution never loses data. O(1) per message, and memory is one
// small int per base bucket (≈2160 entries for a 6 h stream at 10 s base — negligible).
export class DensityTracker {
  constructor({ baseRes = 5 } = {}) {
    this.baseRes = baseRes;          // seconds per base bucket
    this.buckets = new Map();        // baseBucketIndex -> weight
  }

  // Record `weight` units of activity at time `t` (seconds — wall-clock for live).
  add(t, weight = 1) {
    if (!Number.isFinite(t) || t < 0) return;
    const i = Math.floor(t / this.baseRes);
    this.buckets.set(i, (this.buckets.get(i) || 0) + weight);
  }

  // Drop buckets older than `tSec` so memory stays bounded as wall-clock advances.
  pruneBefore(tSec) {
    const cutoff = Math.floor(tSec / this.baseRes);
    for (const k of this.buckets.keys()) if (k < cutoff) this.buckets.delete(k);
  }

  reset() { this.buckets.clear(); }

  // Pick a display resolution (seconds/point) for a stream of `durationSec`. Targets roughly
  // a fixed number of points so a 10 min stream lands near 10 s/point and a 6 h stream near
  // 2 min/point — and is always a whole multiple of the base resolution.
  resolutionFor(durationSec) {
    const target = durationSec / 180;            // ~180 points across the whole stream
    const mult = Math.max(1, Math.round(target / this.baseRes));
    return mult * this.baseRes;
  }

  // Build a normalized series of { t, v } across [startT, endT] at `displayRes` seconds.
  // `v` is the per-second activity rate (so different resolutions stay comparable).
  series(startT, endT, displayRes) {
    const out = [];
    if (!(endT > startT)) return out;
    const step = Math.max(this.baseRes, displayRes || this.baseRes);
    const perBase = Math.max(1, Math.round(step / this.baseRes));
    const first = Math.floor(startT / step) * step;
    for (let t = first; t < endT; t += step) {
      let sum = 0;
      const base = Math.floor(t / this.baseRes);
      for (let k = 0; k < perBase; k++) sum += this.buckets.get(base + k) || 0;
      out.push({ t, v: sum / step });
    }
    return out;
  }
}
