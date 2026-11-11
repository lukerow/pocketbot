// Pocket — tempo engine.
//
// TempoTracker: given recent hit times and the drummer's TARGET tempo, works
// out the tempo actually being played.
//
// Why the target matters: the same groove can be "heard" at several tempos
// (8ths at 120 look like quarters at 240; a half-time backbeat looks like 60).
// Drummers think in the tempo of the song, so we:
//   • only consider tempos within ±25% of the target — so 8th/16th hi-hats,
//     half-time and double-time feels all read in the song's tempo;
//   • gently prefer tempos close to the target / to the last reading, which
//     settles genuinely ambiguous cases (e.g. a crash every 4 beats at 120 is
//     also every 5 beats at 150);
//   • score only gaps that are a whole number of beats (1–8), so fills,
//     flams and ghost notes that don't sit on the grid simply don't count.
// A least-squares fit over the matching gaps then gives a precise BPM.
//
// TempoFollower: wraps the tracker with smoothing, "hold through breaks",
// silence detection and half/double-time feel detection. The app and the
// tests both use it, so what's tested is exactly what runs.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class TempoTracker {
  constructor() {
    this.onsets = [];
    this.levels = [];
    this.sigma = 0.012; // timing tolerance in seconds (human feel + detection jitter)
  }

  reset() {
    this.onsets = [];
    this.levels = [];
  }

  addOnset(t, level = 1) {
    this.onsets.push(t);
    this.levels.push(level);
    if (this.onsets.length > 300) {
      this.onsets.splice(0, 100);
      this.levels.splice(0, 100);
    }
  }

  lastOnset() {
    return this.onsets.length ? this.onsets[this.onsets.length - 1] : -Infinity;
  }

  /** indices of onsets inside [now - sec, now] */
  _range(now, sec) {
    const start = now - sec;
    let i = this.onsets.length;
    while (i > 0 && this.onsets[i - 1] >= start) i--;
    let j = this.onsets.length;
    while (j > i && this.onsets[j - 1] > now) j--;
    return [i, j];
  }

  /** ~8 beats normally; up to 16 beats / 10 s when the playing is sparse */
  windowFor(target, now) {
    const P0 = 60 / target;
    const base = clamp(8 * P0, 3, 6);
    const [i, j] = this._range(now, base);
    if (j - i >= 8) return base;
    return clamp(16 * P0, 6, 10);
  }

  /**
   * @param {number} target  target BPM
   * @param {number} now     current time (same clock as onsets)
   * @param {number|null} hint  last reading, for continuity
   * @returns {{bpm:number, confidence:number, hits:number} | null}
   */
  estimate(target, now, hint = null) {
    const P0 = 60 / target;
    const windowSec = this.windowFor(target, now);
    const [i0, i1] = this._range(now, windowSec);
    const t = this.onsets.slice(i0, i1);
    if (t.length < 4) return null;

    const maxGap = Math.min(windowSec, 8.6 * P0);
    const minGap = 0.3 * P0; // 16th-note gaps can never be a whole beat
    const tau = windowSec * 0.6;

    // pairs of hits (gap, weight) — recent pairs count more
    const gaps = [];
    const weights = [];
    for (let i = 0; i < t.length; i++) {
      const wi = Math.exp(-(now - t[i]) / tau);
      for (let j = i + 1; j < t.length; j++) {
        const d = t[j] - t[i];
        if (d > maxGap) break;
        if (d < minGap) continue;
        gaps.push(d);
        weights.push(wi);
      }
    }
    if (gaps.length < 3) return null;

    const s2 = 2 * this.sigma * this.sigma;
    const nWeight = [0, 1, 0.87, 0.77, 0.69, 0.63, 0.58, 0.54, 0.5]; // long gaps alias more easily
    const prior = (bpm) => {
      const a = Math.log(bpm / target) / 0.12;
      let p = Math.exp(-0.5 * a * a);
      if (hint) {
        const b = Math.log(bpm / hint) / 0.05;
        p = Math.max(p, Math.exp(-0.5 * b * b));
      }
      return 0.25 + 0.75 * p;
    };
    const scorePeriod = (p) => {
      let s = 0;
      for (let k = 0; k < gaps.length; k++) {
        const n = Math.round(gaps[k] / p);
        if (n < 1 || n > 8) continue;
        const e = gaps[k] - n * p;
        if (e > 4 * this.sigma || e < -4 * this.sigma) continue;
        s += weights[k] * nWeight[n] * Math.exp(-(e * e) / s2);
      }
      // a shorter period has a denser grid and matches random gaps more often — compensate
      return s * (p / P0);
    };

    // coarse search ±25% around target, 0.2 BPM steps
    let bestP = P0;
    let bestScore = -1;
    for (let bpm = target * 0.8; bpm <= target * 1.25; bpm += 0.2) {
      const p = 60 / bpm;
      const s = scorePeriod(p) * prior(bpm);
      if (s > bestScore) {
        bestScore = s;
        bestP = p;
      }
    }

    // refine: weighted least squares over the gaps that matched the best grid
    let num = 0, den = 0, matchedW = 0, totalW = 0, matched = 0;
    for (let k = 0; k < gaps.length; k++) {
      totalW += weights[k];
      const n = Math.round(gaps[k] / bestP);
      if (n < 1 || n > 8) continue;
      const e = gaps[k] - n * bestP;
      if (Math.abs(e) < 2.5 * this.sigma) {
        num += weights[k] * n * gaps[k];
        den += weights[k] * n * n;
        matchedW += weights[k];
        matched++;
      }
    }
    if (matched < 3 || den === 0) return null;

    const p = num / den;
    const confidence = matchedW / totalW;
    if (confidence < 0.12) return null;
    return { bpm: 60 / p, confidence, hits: t.length };
  }

  /**
   * Feel, from the accents (the loudest hits — usually kick & snare):
   * accents ~every beat → normal, every 2 beats → half-time,
   * every half beat → double-time. Returns null when unclear.
   */
  feel(bpm, now) {
    const p = 60 / bpm;
    const [i0, i1] = this._range(now, clamp(8 * p, 3, 6));
    if (i1 - i0 < 6) return null;
    const lv = this.levels.slice(i0, i1);
    const max = Math.max(...lv);
    const sorted = [...lv].sort((a, b) => a - b);
    const thr = Math.max(0.45 * max, sorted[Math.floor(sorted.length * 0.4)]);
    const acc = [];
    for (let k = i0; k < i1; k++) if (this.levels[k] >= thr) acc.push(this.onsets[k]);
    if (acc.length < 4) return null;
    const votes = { double: 0, normal: 0, half: 0 };
    let total = 0;
    for (let k = 1; k < acc.length; k++) {
      const r = (acc[k] - acc[k - 1]) / p;
      total++;
      if (Math.abs(r - 0.5) < 0.1) votes.double++;
      else if (Math.abs(r - 1) < 0.15) votes.normal++;
      else if (Math.abs(r - 2) < 0.25) votes.half++;
    }
    if (total < 3) return null;
    const best = Object.keys(votes).reduce((a, b) => (votes[b] > votes[a] ? b : a));
    return votes[best] / total >= 0.6 ? best : null;
  }
}

export class TempoFollower {
  constructor() {
    this.tracker = new TempoTracker();
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.bpm = null;
    this.mode = 'listen';
    this.feelState = null;
    this._feelCand = null;
    this._feelCount = 0;
  }

  hit(t, level = 1) {
    this.tracker.addOnset(t, level);
  }

  _medianGap() {
    const o = this.tracker.onsets;
    const n = Math.min(9, o.length);
    if (n < 3) return 0;
    const g = [];
    for (let k = o.length - n + 1; k < o.length; k++) g.push(o[k] - o[k - 1]);
    g.sort((a, b) => a - b);
    return g[Math.floor(g.length / 2)];
  }

  /**
   * @returns {{mode:'listen'|'live'|'hold', bpm:number|null, feel:string|null}}
   *   live   — playing, reading is current
   *   hold   — a break: keep showing the last reading (dimmed)
   *   listen — nothing to show
   */
  update(now, target) {
    const P0 = 60 / target;
    const silence = now - this.tracker.lastOnset();
    const med = this._medianGap();
    const holdAfter = Math.max(1.5, 1.6 * med + 0.25);
    const listenAfter = Math.max(5, 8 * P0, 2.5 * med);

    if (!isFinite(silence) || silence > listenAfter) {
      if (this.bpm != null) this.reset();
      this.mode = 'listen';
      return this._out();
    }

    if (silence <= holdAfter) {
      const est = this.tracker.estimate(target, now, this.bpm);
      if (est) {
        if (this.bpm == null || Math.abs(est.bpm - this.bpm) > target * 0.15) this.bpm = est.bpm;
        else this.bpm += 0.35 * (est.bpm - this.bpm);
      }
    }

    this.mode = this.bpm == null ? 'listen' : silence > holdAfter ? 'hold' : 'live';

    if (this.mode === 'live') {
      const f = this.tracker.feel(this.bpm, now);
      if (f === this._feelCand) this._feelCount++;
      else { this._feelCand = f; this._feelCount = 1; }
      if (this._feelCount >= 3) this.feelState = f;
    }
    return this._out();
  }

  _out() {
    return { mode: this.mode, bpm: this.bpm, feel: this.mode === 'listen' ? null : this.feelState };
  }
}
