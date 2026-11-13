// PocketBot — hit detector. Runs on the audio thread, sample-accurate.
// Listens to the mic, finds sharp energy spikes (drum hits) and posts
// their exact time (in AudioContext seconds) to the main thread.

const SENSITIVITY = {
  //        ratio: how far above the room's recent level a hit must jump
  //        floor: minimum absolute level (ignores quiet room noise)
  low:    { ratio: 2.2, floor: 0.030 },
  medium: { ratio: 1.7, floor: 0.012 },
  high:   { ratio: 1.4, floor: 0.004 },
};

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    // one-pole high-pass ~150 Hz: removes rumble/hum, keeps the attack of every drum
    this.hpA = Math.exp(-2 * Math.PI * 150 / sr);
    this.hpPrevX = 0;
    this.hpPrevY = 0;
    // envelope followers
    this.fastAtk = 1 - Math.exp(-1 / (0.0005 * sr)); // 0.5 ms attack
    this.fastRel = 1 - Math.exp(-1 / (0.015 * sr));  // 15 ms release
    this.slowCoef = 1 - Math.exp(-1 / (0.30 * sr));  // 300 ms room average
    this.fast = 0;
    this.slow = 0;
    this.armed = true;
    this.lastOnset = -1;
    this.pending = null;
    this.refractory = 0.07; // seconds — fastest hits we count (~16ths at 210 BPM)
    this.peak = 0;
    this.levelCounter = 0;
    this.setSensitivity('medium');
    this.port.onmessage = (e) => {
      if (e.data && e.data.sensitivity) this.setSensitivity(e.data.sensitivity);
    };
  }

  setSensitivity(name) {
    const s = SENSITIVITY[name] || SENSITIVITY.medium;
    this.ratio = s.ratio;
    this.floor = s.floor;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const x = input[0];
    const sr = sampleRate;
    const t0 = currentFrame / sr;

    for (let i = 0; i < x.length; i++) {
      // high-pass
      const y = this.hpA * (this.hpPrevY + x[i] - this.hpPrevX);
      this.hpPrevX = x[i];
      this.hpPrevY = y;
      const a = y < 0 ? -y : y;

      // envelopes
      this.fast += (a > this.fast ? this.fastAtk : this.fastRel) * (a - this.fast);
      this.slow += this.slowCoef * (a - this.slow);
      if (this.fast > this.peak) this.peak = this.fast;

      const threshold = this.ratio * this.slow;
      const t = t0 + i / sr;

      if (!this.armed) {
        // re-arm once the hit has died back down (or after 250 ms of sustained noise)
        if (this.fast < threshold || t - this.lastOnset > 0.25) this.armed = true;
      } else if (
        this.fast > threshold &&
        this.fast > this.floor &&
        t - this.lastOnset > this.refractory
      ) {
        this.armed = false;
        this.lastOnset = t;
        // measure how loud this hit gets over the next 20 ms, then report it
        this.pending = { t, level: this.fast, until: t + 0.02 };
      }

      if (this.pending) {
        if (this.fast > this.pending.level) this.pending.level = this.fast;
        if (t >= this.pending.until) {
          this.port.postMessage({ type: 'onset', t: this.pending.t, level: this.pending.level });
          this.pending = null;
        }
      }
    }

    // send an input level reading ~20x a second (for the "hearing you" meter)
    if (++this.levelCounter >= Math.round(sr / 128 / 20)) {
      this.levelCounter = 0;
      this.port.postMessage({ type: 'level', peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
