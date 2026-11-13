import { TempoFollower } from './tempo.js';
import { ChairMode } from './chair.js';

// ---------- settings & persistence ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('pocket.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('pocket.' + key, JSON.stringify(value)); } catch {}
  },
};

const MIN_BPM = 30;
const MAX_BPM = 300;
const clampBpm = (b) => Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(b)));

const state = {
  target: clampBpm(store.get('target', 120)),
  tolerance: store.get('tolerance', 2),
  sensitivity: store.get('sensitivity', 'medium'),
  // favourites hold a tempo and a time signature (older saves were plain numbers)
  favs: store.get('favs', [90, 100, 120, 140]).map((f) => (typeof f === 'number' ? { bpm: f, meter: '4/4' } : f)),
  swiped: store.get('swiped', false),
  chair: store.get('chair', false),
  flash: store.get('flash', true),
  flashStyle: store.get('flashStyle', 'full'), // full | edge | swing | onoff
  meter: store.get('meter', '4/4'),            // time signature: sets beat-1 accent + count-in length
  countIn: null,
  difficulty: store.get('difficulty', 'strict'),
  usedChair: false,
  locked: false,
  running: false,
  reading: { mode: 'listen', bpm: null, feel: null },
  status: 'listen', // listen | hold | locked | rush | drag
};

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const app = $('app');
const el = {
  target: $('targetBpm'), live: $('liveBpm'), status: $('status'), tip: $('tip'), feel: $('feel'),
  marker: $('marker'), zone: $('zone'), dev: $('devText'), mic: $('micBtn'), beatFlash: $('beatFlash'),
  favs: $('favs'), addFav: $('addFav'), stop: $('stopBtn'),
  lockBtn: $('lockBtn'), flashBtn: $('flashBtn'), targetLabel: $('targetLabel'),
  tsBtn: $('tsBtn'), tsText: $('tsText'), tsPicker: $('tsPicker'), beatDots: $('beatDots'),
  plus: $('plusBtn'), minus: $('minusBtn'),
  targetBlock: $('targetBlock'), liveBlock: $('liveBlock'),
  overlay: $('swipeOverlay'), overlayBpm: $('overlayBpm'), toast: $('toast'),
  start: $('startBtn'), startErr: $('startErr'),
  settings: $('settings'), settingsBtn: $('settingsBtn'), closeSettings: $('closeSettings'),
  level: $('levelBar'),
  summary: $('summary'),
  chairBtn: $('chairBtn'),
};

// ---------- chair mode ----------
const chair = new ChairMode({
  app,
  liveEl: el.live,
  hud: $('chairLine'),
  onHaptic: (p) => { if (navigator.vibrate) navigator.vibrate(p); },
});
chair.setDifficulty(state.difficulty);

function setChair(on, { announce = true } = {}) {
  state.chair = on;
  store.set('chair', on);
  chair.setEnabled(on);
  if (on && state.running) state.usedChair = true;
  el.chairBtn.setAttribute('aria-pressed', String(on));
  if (announce) toast(on ? 'Chair mode on' : 'Chair mode off');
  renderSettings();
  render();
}
el.chairBtn.addEventListener('click', () => setChair(!state.chair));


// ---------- audio ----------
const follower = new TempoFollower();
let audio = null; // { ctx, stream, node }
let demo = null;
const isDemo = new URLSearchParams(location.search).has('demo');

function now() {
  if (demo) return performance.now() / 1000;
  return audio ? Math.max(audio.ctx.currentTime, follower.tracker.lastOnset()) : 0;
}

async function startListening() {
  el.startErr.hidden = true;
  if (isDemo) { startDemo(); return onStarted(); }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showStartError('The microphone needs a secure (https) connection. Open PocketBot from its https link.');
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    const resumed = ctx.resume(); // must start inside the tap on iOS
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await resumed;
    await ctx.audioWorklet.addModule('worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'onset-processor', { numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination); // keeps the graph running; silent
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'onset') onHit(m.t, m.level);
      else if (m.type === 'level') onLevel(m.peak);
    };
    node.port.postMessage({ sensitivity: state.sensitivity });
    audio = { ctx, stream, node };
    onStarted();
  } catch (err) {
    console.error(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      showStartError('Microphone access was blocked. Allow the mic for this site in your browser settings, then tap Start again.');
    } else if (err && err.name === 'NotFoundError') {
      showStartError('No microphone found on this device.');
    } else {
      showStartError('Could not start the microphone (' + (err?.message || err) + ').');
    }
    stopAudio();
  }
}

function showStartError(msg) {
  el.startErr.textContent = msg;
  el.startErr.hidden = false;
}

function stopAudio() {
  if (audio) {
    audio.stream?.getTracks().forEach((t) => t.stop());
    audio.ctx?.close().catch(() => {});
    audio = null;
  }
  if (demo) { clearTimeout(demo.timer); demo = null; }
}

function onStarted() {
  state.running = true;
  follower.reset();
  state.reading = { mode: 'listen', bpm: null, feel: null };
  state.status = 'listen';
  session.reset();
  chair.reset();
  state.usedChair = state.chair;
  lastHeard = Date.now();
  flash.restart(performance.now() / 1000 + 0.6);
  beatLoop();
  requestWakeLock();
  loop();
  if (!store.get('tipsSeen', false)) showTips();
  store.set('sessions', store.get('sessions', 0) + 1);
}

// ---------- first-run tips ----------
function showTips() { el.settings.hidden = true; $('tips').hidden = false; }
$('tipsDone').addEventListener('click', () => { $('tips').hidden = true; store.set('tipsSeen', true); });
$('showTips').addEventListener('click', showTips);

function stop() {
  const summary = session.summary();
  state.running = false;
  stopAudio();
  releaseWakeLock();
  render();
  renderDots();
  if (summary) showSummary(summary);
}

// ---------- demo mode (?demo): a simulated drummer, for trying the UI without a mic ----------
// Cycles normal → half-time → double-time feels, drifting ±6 BPM, with a break now and then.
function startDemo() {
  const t0 = performance.now() / 1000;
  let next = t0 + 0.5;
  let step = 0; // 16th-note steps
  demo = { timer: 0 };
  const tick = () => {
    const t = performance.now() / 1000;
    while (next <= t + 0.02) {
      const at = next;
      const el = at - t0;
      const section = Math.floor(el / 16) % 4; // 0 normal, 1 half, 2 double, 3 normal with a break
      const inBreak = section === 3 && el % 16 > 10 && el % 16 < 13;
      const s16 = step % 16;
      let hit = null;
      if (s16 % 2 === 0) hit = 0.2; // 8th hats
      if (section === 1) { if (s16 === 0 || s16 === 8) hit = 0.9; }
      else if (section === 2) { if (s16 % 4 === 0 || s16 % 4 === 2) hit = 0.9; }
      else if (s16 % 4 === 0) hit = 0.9;
      if (hit && !inBreak) {
        const delay = Math.max(0, (at - performance.now() / 1000) * 1000);
        const j = (Math.random() - 0.5) * 0.012;
        setTimeout(() => onHit(at + j, hit), delay);
      }
      const bpm = state.target + 6 * Math.sin((el / 20) * 2 * Math.PI);
      next += 60 / bpm / 4;
      step++;
    }
    demo.timer = setTimeout(tick, 30);
  };
  tick();
}

// ---------- hits → tempo ----------
let lastUpdateAt = 0;

let lastHeard = 0;
function onHit(t, level) {
  if (!state.running) return;
  lastHeard = Date.now();
  follower.hit(t, level);
  // the mic button lights up on every hit it hears
  el.mic.classList.add('hit');
  clearTimeout(onHit.t);
  onHit.t = setTimeout(() => el.mic.classList.remove('hit'), 90);
  // gently pull the beat flash into line with the drummer's accents
  const tp = demo ? t : performance.now() / 1000 - Math.max(0, audio.ctx.currentTime - t);
  flash.nudge(tp, level);
  update();
}

// ---------- beat flash: visual count-in + guide ----------
// Screen edges blink on the target beat. 4 full-brightness blinks to count in;
// then dimmer while you're locked in, full brightness the further you drift.
const flash = {
  origin: 0, last: -1, counting: false, lockedFor: 0, accentMax: 0, nudged: null,
  barOffset: 0, // which beat counts as "1" (moved by tapping the beat dots)
  restart(at) { this.origin = at; this.last = -1; this.counting = true; this.barOffset = 0; },
  nudge(tp, level) {
    this.accentMax = Math.max(level, this.accentMax * 0.98);
    if (this.counting || state.reading.mode !== 'live' || level < this.accentMax * 0.6) return;
    const P = 60 / state.target;
    let e = ((tp - this.origin) % P + P) % P;
    if (e > P / 2) e -= P;
    const beat = Math.round((tp - this.origin) / P);
    if (beat === this.nudged) return;          // at most one nudge per beat
    this.nudged = beat;
    if (Math.abs(e) < P * 0.25) this.origin += e * 0.08;
  },
};
function beatLoop() {
  clearTimeout(beatLoop.t);
  if (!state.running) { state.countIn = null; return; }
  const P = 60 / state.target;
  const now = performance.now() / 1000;
  const n = Math.floor((now - flash.origin) / P + 0.002);
  if (n >= 0 && n !== flash.last) { flash.last = n; onBeat(n, P); }
  // sleep until the next beat (re-checked often enough to follow tempo changes)
  const next = flash.origin + (Math.max(n, -1) + 1) * P;
  beatLoop.t = setTimeout(beatLoop, Math.max(4, Math.min(100, (next - now) * 1000)));
}
const beatsPerBar = () => parseInt(state.meter, 10) || 4;
// count in one bar (two bars of 2/4)
const countLen = () => { const b = beatsPerBar(); return b < 3 ? b * 2 : b; };
function onBeat(n, P) {
  const counting = flash.counting && n < countLen();
  if (flash.counting && !counting) flash.counting = false;
  state.countIn = counting ? n : null;
  render();
  const r = state.reading;
  const bpb = beatsPerBar();
  const bar = (((n - flash.barOffset) % bpb) + bpb) % bpb;
  renderDots(bar);
  // every beat flashes the same (the beat numbers show where 1 is); slightly softer while locked in
  if (!state.flash) return;
  const i = !counting && r.mode === 'live' && state.status === 'locked' ? 0.85 : 1;
  const style = state.flashStyle;
  if (style === 'onoff' && bar % 2) return; // on for a beat, off for a beat
  const f = el.beatFlash;
  f.className = 'beat-flash ' + style + (style === 'swing' ? (bar % 2 ? ' r' : ' l') : '');
  // a hard blink: straight on, hold, straight off (no fade)
  const dur = style === 'onoff' ? P * 970 : Math.min(130, Math.max(80, P * 220));
  f.getAnimations().forEach((a) => a.cancel());
  f.animate([{ opacity: i }, { opacity: i, offset: 0.99 }, { opacity: 0 }], { duration: dur, easing: 'linear' });
}

// ---------- beat dots: where you are in the bar; tap them on your "1" to move beat 1 ----------
function renderDots(bar = -1) {
  const bpb = beatsPerBar();
  if (el.beatDots.children.length !== bpb) {
    el.beatDots.innerHTML = '';
    for (let k = 0; k < bpb; k++) { const d = document.createElement('i'); d.textContent = k + 1; el.beatDots.appendChild(d); }
  }
  [...el.beatDots.children].forEach((d, k) => d.classList.toggle('on', k === bar));
}
el.beatDots.addEventListener('click', () => {
  if (!state.running) return toast('Press START first');
  const P = 60 / state.target;
  const n = Math.round((performance.now() / 1000 - flash.origin) / P);
  flash.barOffset = ((n % beatsPerBar()) + beatsPerBar()) % beatsPerBar();
  renderDots(0);
  toast('Beat 1 moved');
});

// ---------- time signature: the pill on the main screen opens a picker ----------
el.tsBtn.addEventListener('click', () => { renderSettings(); el.tsPicker.hidden = false; });
$('tsDone').addEventListener('click', () => { el.tsPicker.hidden = true; });
el.tsPicker.addEventListener('click', (e) => {
  if (e.target === el.tsPicker) el.tsPicker.hidden = true;
  if (e.target.closest('.seg button')) setTimeout(() => { el.tsPicker.hidden = true; }, 180);
});

function update() {
  const t = now();
  const dt = lastUpdateAt ? Math.min(0.5, t - lastUpdateAt) : 0;
  lastUpdateAt = t;
  state.reading = follower.update(t, state.target);
  updateStatus();
  session.add(dt);
  const r = state.reading;
  flash.lockedFor = r.mode === 'live' && state.status === 'locked' ? flash.lockedFor + dt : 0;
  chair.update(dt, {
    running: state.running, mode: r.mode, status: state.status,
    dev: r.bpm == null ? 0 : r.bpm - state.target, tol: state.tolerance, target: state.target,
  });
  render();
}

function updateStatus() {
  const r = state.reading;
  if (r.mode === 'listen' || r.bpm == null) return (state.status = 'listen');
  const dev = r.bpm - state.target;
  const tol = state.tolerance;
  let s = state.status;
  if (s !== 'rush' && s !== 'drag' && s !== 'locked') s = 'locked';
  // hysteresis so the label doesn't flicker at the edge of the zone
  if (s === 'rush') s = dev < tol * 0.6 ? (dev < -tol ? 'drag' : 'locked') : 'rush';
  else if (s === 'drag') s = dev > -tol * 0.6 ? (dev > tol ? 'rush' : 'locked') : 'drag';
  else if (dev > tol) s = 'rush';
  else if (dev < -tol) s = 'drag';
  else s = 'locked';
  state.zone = s; // where the reading sits, even during a break
  state.status = r.mode === 'hold' ? 'hold' : s;
}

function loop() {
  if (!state.running) return;
  // re-evaluate a few times a second even without new hits (breaks, silence)
  if (now() - lastUpdateAt > 0.1) update();
  // auto-stop after 5 minutes of silence, to save battery
  if (Date.now() - lastHeard > 5 * 60 * 1000) { stop(); toast('Stopped after 5 min of silence'); return; }
  setTimeout(loop, 100);
}

// ---------- session stats (for the summary on STOP) ----------
const session = {
  reset() { this.t = 0; this.sumBpm = 0; this.sumDev = 0; this.locked = 0; this.rush = 0; this.drag = 0; this.samples = []; this.lastSample = -1; },
  add(dt) {
    const r = state.reading;
    if (!state.running || r.mode !== 'live' || r.bpm == null || !dt) {
      // a break: leave a gap in the graph
      if (state.running && this.samples.length && this.samples[this.samples.length - 1]) this.samples.push(null);
      return;
    }
    this.t += dt;
    // tempo graph: one point every 0.25 s of playing (bpm, target, status)
    if (this.t - this.lastSample >= 0.25) {
      this.lastSample = this.t;
      this.samples.push({ t: this.t, bpm: r.bpm, target: state.target, s: state.status });
    }
    this.sumBpm += r.bpm * dt;
    this.sumDev += (r.bpm - state.target) * dt;
    if (state.status === 'locked') this.locked += dt;
    else if (state.status === 'rush') this.rush += dt;
    else if (state.status === 'drag') this.drag += dt;
  },
  summary() {
    if (this.t < 8) return null;
    return {
      seconds: this.t,
      avg: this.sumBpm / this.t,
      dev: this.sumDev / this.t,
      locked: this.locked / this.t,
      rush: this.rush / this.t,
      drag: this.drag / this.t,
      samples: this.samples,
    };
  },
};
session.reset();

const fmtTime = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
const signed = (x) => { const v = Math.round(x * 10) / 10; return v === 0 ? '±0' : (v > 0 ? '+' : '−') + Math.abs(v); };

function showSummary(s) {
  const pct = (x) => Math.round(x * 100) + '%';
  $('sumTime').textContent = fmtTime(s.seconds) + ' PLAYED';
  $('sumAvg').textContent = Math.round(s.avg);
  $('sumDev').textContent = signed(s.dev);
  $('sumLock').textContent = pct(s.locked);
  $('sumRush').textContent = pct(s.rush);
  $('sumDrag').textContent = pct(s.drag);
  const cs = chair.stats();
  $('sumChairs').hidden = !state.usedChair;
  $('sumTaken').textContent = cs.taken;
  $('sumDodged').textContent = cs.dodged;
  $('sumStreak').textContent = fmtTime(cs.bestStreak);
  $('sumTips').innerHTML = '';
  for (const tip of coachTips(s)) {
    const li = document.createElement('li');
    li.textContent = tip;
    $('sumTips').appendChild(li);
  }
  el.summary.hidden = false;
  drawGraph(s.samples); // after showing, so the graph can measure its width
}

// ---------- tempo graph: your BPM over the session vs the target and locked-in zone ----------
function drawGraph(samples) {
  const box = $('sumGraph');
  const W = Math.max(240, box.clientWidth), H = 170, L = 34, R = 6, T = 8, B = 20;
  const pts = samples.filter(Boolean);
  if (!pts.length) { box.innerHTML = ''; return; }
  const tEnd = pts[pts.length - 1].t;
  const tol = state.tolerance;
  // vertical scale: deviation from target, at least ±3× the zone
  let range = tol * 3;
  for (const p of pts) range = Math.max(range, Math.abs(p.bpm - p.target) * 1.1);
  range = Math.ceil(Math.min(range, 40));
  const x = (t) => L + (t / Math.max(tEnd, 1)) * (W - L - R);
  const y = (d) => T + (1 - (d + range) / (2 * range)) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    svg.appendChild(n);
    return n;
  };
  add('rect', { x: L, y: y(tol), width: W - L - R, height: y(-tol) - y(tol), class: 'g-zone' });
  add('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'g-target' });
  add('text', { x: L - 6, y: y(range) + 9, class: 'g-lbl', 'text-anchor': 'end' }, '+' + range);
  add('text', { x: L - 6, y: y(0) + 4, class: 'g-lbl g-lbl-t', 'text-anchor': 'end' }, Math.round(pts[0].target));
  add('text', { x: L - 6, y: y(-range) - 2, class: 'g-lbl', 'text-anchor': 'end' }, '−' + range);
  add('text', { x: L + 4, y: y(range) + 9, class: 'g-lbl' }, 'RUSH');
  add('text', { x: L + 4, y: y(-range) - 2, class: 'g-lbl' }, 'DRAG');
  for (const f of [0, 0.5, 1]) {
    add('text', { x: x(tEnd * f), y: H - 4, class: 'g-lbl', 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, fmtTime(tEnd * f));
  }
  // the line, coloured by locked / rushing / dragging, with gaps for breaks
  const cls = { locked: 'g-lock', rush: 'g-rush', drag: 'g-drag' };
  let run = [], runCls = null, prev = null;
  const flush = () => { if (run.length > 1) add('polyline', { points: run.join(' '), class: 'g-line ' + runCls }); run = []; };
  for (const p of samples) {
    if (!p) { flush(); prev = null; continue; }
    const c = cls[p.s] || 'g-lock';
    const xy = x(p.t).toFixed(1) + ',' + y(Math.max(-range, Math.min(range, p.bpm - p.target))).toFixed(1);
    if (c !== runCls) { flush(); if (prev) run.push(prev); runCls = c; }
    run.push(xy);
    prev = xy;
  }
  flush();
  box.innerHTML = '';
  box.appendChild(svg);
}

// ---------- coaching: what to work on next time ----------
function coachTips(s) {
  const tips = [];
  const pts = s.samples.filter(Boolean);
  const tol = state.tolerance;
  const dev = (a) => a.reduce((m, p) => m + (p.bpm - p.target), 0) / Math.max(1, a.length);
  const third = Math.floor(pts.length / 3);
  const trend = third >= 4 ? dev(pts.slice(-third)) - dev(pts.slice(0, third)) : 0;
  const mean = dev(pts);
  const wobble = Math.sqrt(pts.reduce((m, p) => m + (p.bpm - p.target - mean) ** 2, 0) / Math.max(1, pts.length));

  if (s.locked >= 0.75) tips.push('Solid: in the pocket ' + Math.round(s.locked * 100) + '% of the time. Try a tighter locked-in zone or a faster tempo.');
  else if (s.rush > s.drag + 0.1 && s.rush > 0.15) tips.push('You tended to rush. Sit back on the beat and let the backbeat (2 and 4) land a hair later.');
  else if (s.drag > s.rush + 0.1 && s.drag > 0.15) tips.push('You tended to drag. Push the time forward: think of the hi-hat driving the groove.');
  else tips.push('Some drift both ways. Keep the meter in the corner of your eye and correct small, early.');

  if (trend > tol) tips.push('You sped up as you went (' + signed(trend) + ' BPM by the end). Keep the first bars in your head, and use the beat flash as a check.');
  else if (trend < -tol) tips.push('You slowed down as you went (' + signed(trend) + ' BPM by the end). Practise in shorter sections and keep your energy up to the last bar.');
  if (wobble > tol * 2 && tips.length < 3) tips.push('Tempo wobbled a lot. Slow the target down 10 BPM and play a simple groove until it stays green.');
  if (s.seconds < 60 && tips.length < 3) tips.push('Short session. Play at least 2–3 minutes for a clearer graph.');
  return tips;
}

$('sumDone').addEventListener('click', () => { el.summary.hidden = true; });

// ---------- render ----------
const FEEL_TEXT = { half: 'HALF-TIME FEEL', double: 'DOUBLE-TIME FEEL' };

function render() {
  const s = state.running ? state.status : 'idle';
  app.className = 'state-' + s + (state.locked ? ' locked' : '') + (state.swiped ? ' swiped' : '') + (state.chair ? ' chair-on' : '');
  el.target.textContent = state.target;
  el.overlayBpm.textContent = state.target;
  el.tsText.textContent = state.meter;
  if (!tapTempo.t) el.targetLabel.textContent = store.get('sessions', 0) <= 5 && !state.locked ? 'TARGET · TAP IN TIME' : 'TARGET';

  const range = Math.max(4, state.target * 0.08); // meter full scale: ±8% of target
  el.zone.style.width = Math.min(100, (state.tolerance / range) * 100) + '%';

  const r = state.reading;
  const feel = state.running && r.mode === 'live' ? FEEL_TEXT[r.feel] : null;
  el.feel.hidden = !feel;
  if (feel) el.feel.textContent = feel;

  if (!state.running || r.bpm == null || s === 'listen') {
    const counting = state.running && state.countIn != null;
    // count-in: the big number counts the bar so you can read it from the kit
    el.live.textContent = counting ? String(state.countIn % beatsPerBar() + 1) : '---';
    el.live.classList.toggle('count', counting);
    el.status.classList.remove('blink');
    el.status.textContent = counting ? 'COUNT-IN' : 'LISTENING';
    el.tip.textContent = !state.running ? '' : counting ? state.meter : 'start playing';
    el.marker.style.left = '50%';
    el.dev.textContent = '±0';
    return;
  }

  const dev = r.bpm - state.target;
  el.live.classList.remove('count');
  el.live.textContent = Math.round(r.bpm);
  const devR = Math.round(dev);
  el.dev.textContent = devR === 0 ? '±0' : (devR > 0 ? '+' : '−') + Math.abs(devR);
  const pos = Math.max(-1, Math.min(1, dev / range));
  el.marker.style.left = 50 + pos * 46 + '%';

  const big = Math.abs(dev) > state.tolerance * 2.5;
  const over = chair.text(s, big);
  el.status.classList.toggle('blink', !!over?.blink);
  if (over) { el.status.textContent = over.status; el.tip.textContent = over.tip; return; }
  if (s === 'hold') { el.status.textContent = 'BREAK'; el.tip.textContent = 'holding last tempo'; }
  else if (s === 'locked') { el.status.textContent = 'LOCKED IN'; el.tip.textContent = 'in the pocket'; }
  else if (s === 'rush') { el.status.textContent = 'RUSHING'; el.tip.textContent = big ? 'ease back' : 'ease back a touch'; }
  else if (s === 'drag') { el.status.textContent = 'DRAGGING'; el.tip.textContent = big ? 'push' : 'push a touch'; }
}

function lockedToast() { toast('Target locked'); }

function setTarget(bpm, { bump = true, recount = true } = {}) {
  const b = clampBpm(bpm);
  if (b === state.target) return;
  state.target = b;
  store.set('target', b);
  // new tempo → a fresh count-in once you stop changing it
  clearTimeout(setTarget.recount);
  if (recount && state.running) setTarget.recount = setTimeout(() => flash.restart(performance.now() / 1000 + 0.3), 600);
  if (bump) {
    el.target.classList.add('bump');
    clearTimeout(setTarget.t);
    setTarget.t = setTimeout(() => el.target.classList.remove('bump'), 90);
  }
  if (state.running) updateStatus();
  render();
  renderFavs();
}

// ---------- swipe up/down to change target (target area + live area) ----------
(() => {
  const STEP_PX = 14;
  let startY = null;
  let acc = 0;
  let warned = false;
  let hideTimer = 0;
  const showOverlay = () => {
    clearTimeout(hideTimer);
    el.overlay.classList.add('show');
    el.liveBlock.classList.add('swiping');
  };
  const hideOverlay = () => {
    hideTimer = setTimeout(() => {
      el.overlay.classList.remove('show');
      el.liveBlock.classList.remove('swiping');
    }, 600);
  };
  let downAt = 0, moved = 0;
  for (const zone of [el.targetBlock, el.liveBlock]) {
    zone.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // −/＋ and the lock badge handle themselves
      startY = e.clientY; acc = 0; warned = false;
      downAt = performance.now() / 1000; moved = 0;
      zone.setPointerCapture(e.pointerId);
    });
    zone.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      moved += Math.abs(startY - e.clientY);
      acc += startY - e.clientY;
      startY = e.clientY;
      const steps = Math.trunc(acc / STEP_PX);
      if (!steps) return;
      acc -= steps * STEP_PX;
      if (state.locked) { if (!warned) lockedToast(); warned = true; return; }
      showOverlay();
      setTarget(state.target + steps, { bump: false });
      if (!state.swiped) { state.swiped = true; store.set('swiped', true); }
      if (navigator.vibrate) navigator.vibrate(4);
    });
    const end = (e) => {
      if (startY == null) return;
      startY = null;
      hideOverlay();
      // a tap (not a swipe) on the target area = tap tempo, timed from the finger going down
      if (e.type === 'pointerup' && zone === el.targetBlock && moved < 8) tapTempo(downAt);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }
})();

// ---------- −/＋ buttons (hold to repeat) ----------
function stepButton(btn, delta) {
  let delay = 0, repeat = 0;
  const stopRepeat = () => { clearTimeout(delay); clearInterval(repeat); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state.locked) return lockedToast();
    setTarget(state.target + delta);
    delay = setTimeout(() => { repeat = setInterval(() => setTarget(state.target + delta), 70); }, 400);
  });
  btn.addEventListener('pointerup', stopRepeat);
  btn.addEventListener('pointerleave', stopRepeat);
  btn.addEventListener('pointercancel', stopRepeat);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
stepButton(el.plus, +1);
stepButton(el.minus, -1);

// ---------- tap tempo (tap the target number in time) ----------
let taps = [];
function tapTempo(t) {
  if (state.locked) return lockedToast();
  if (taps.length && t - taps[taps.length - 1] > 2) taps = [];
  taps.push(t);
  if (taps.length > 6) taps.shift();
  el.target.classList.add('tapped');
  setTimeout(() => el.target.classList.remove('tapped'), 90);
  // one dot per tap, so you can see each one land
  el.targetLabel.textContent = 'TAP ' + Array(taps.length).fill('●').join(' ');
  clearTimeout(tapTempo.t);
  tapTempo.t = setTimeout(() => { tapTempo.t = 0; render(); }, 2000);
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setTarget(60 / avg, { bump: false, recount: false });
    // the count-in carries on in time with your taps
    if (state.running) flash.restart(t + avg);
  }
}

// ---------- favourites: tempo + time signature, one tap sets both ----------
const sameFav = (f) => f.bpm === state.target && f.meter === state.meter;
function renderFavs() {
  el.favs.innerHTML = '';
  if (!state.favs.length) {
    const s = document.createElement('span');
    s.className = 'favs-empty';
    s.textContent = '＋ saves tempo + time sig';
    el.favs.appendChild(s);
    return;
  }
  for (const fav of state.favs) {
    const b = document.createElement('button');
    b.className = 'chip' + (sameFav(fav) ? ' active' : '');
    b.innerHTML = `<b>${fav.bpm}</b><small>${fav.meter}</small>`;
    b.setAttribute('aria-label', `${fav.bpm} BPM in ${fav.meter} (hold to remove)`);
    let holdTimer = 0;
    let held = false;
    b.addEventListener('pointerdown', () => {
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        b.classList.add('removing');
        if (navigator.vibrate) navigator.vibrate(20);
        setTimeout(() => {
          state.favs = state.favs.filter((x) => x !== fav);
          store.set('favs', state.favs);
          renderFavs();
          toast(`Removed ${fav.bpm} ${fav.meter}`);
        }, 280);
      }, 600);
    });
    const cancel = () => clearTimeout(holdTimer);
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (held) return;
      if (state.locked) return lockedToast();
      if (fav.meter !== state.meter) applySetting('meter', fav.meter);
      setTarget(fav.bpm);
      renderFavs();
    });
    el.favs.appendChild(b);
  }
  el.favs.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

el.addFav.addEventListener('click', () => {
  const label = `${state.target} ${state.meter}`;
  if (state.favs.some(sameFav)) return toast(`${label} is already saved`);
  if (state.favs.length >= 12) return toast('Max 12. Hold one to remove it');
  state.favs = [...state.favs, { bpm: state.target, meter: state.meter }]
    .sort((a, b) => a.bpm - b.bpm || a.meter.localeCompare(b.meter));
  store.set('favs', state.favs);
  renderFavs();
  if (!store.get('favHint', false)) { store.set('favHint', true); toast(`Saved ${label}. Hold to remove`); }
  else toast(`Saved ${label}`);
});

// ---------- quick toggles (main screen + Settings, always in sync) ----------
function setLocked(on) {
  state.locked = on;
  toast(on ? 'Target locked' : 'Target unlocked');
  renderSettings();
  render();
}
function setFlash(on) {
  state.flash = on;
  store.set('flash', on);
  toast(on ? 'Beat flash on' : 'Beat flash off');
  renderSettings();
}
el.lockBtn.addEventListener('click', () => setLocked(!state.locked));
el.flashBtn.addEventListener('click', () => setFlash(!state.flash));

// ---------- settings ----------
function renderSettings() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', String(state[key]) === b.dataset.value);
      if (key === 'difficulty') b.disabled = !state.chair;
      if (key === 'flashStyle') b.disabled = !state.flash;
    });
  });
  document.querySelectorAll('.switch').forEach((sw) => sw.setAttribute('aria-checked', String(!!state[sw.dataset.setting])));
  el.lockBtn.setAttribute('aria-pressed', String(state.locked));
  el.flashBtn.setAttribute('aria-pressed', String(state.flash));
  el.chairBtn.setAttribute('aria-pressed', String(state.chair));
}
function applySetting(key, value) {
  if (key === 'chair') return setChair(value);
  if (key === 'locked') return setLocked(value);
  if (key === 'flash') return setFlash(value);
  state[key] = value;
  store.set(key, value);
  if (key === 'difficulty') chair.setDifficulty(value);
  if (key === 'sensitivity' && audio) audio.node.port.postMessage({ sensitivity: value });
  if (key === 'meter') {
    if (state.running) flash.restart(performance.now() / 1000 + 0.4); // count in the new bar
    renderDots();
    renderFavs();
  }
  renderSettings();
  if (state.running) updateStatus();
  render();
}
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const key = seg.dataset.setting;
    applySetting(key, key === 'tolerance' ? Number(b.dataset.value) : b.dataset.value);
  });
});
document.querySelectorAll('.switch').forEach((sw) => {
  sw.addEventListener('click', () => applySetting(sw.dataset.setting, !state[sw.dataset.setting]));
});
el.settingsBtn.addEventListener('click', () => { renderSettings(); el.settings.hidden = false; });
el.closeSettings.addEventListener('click', () => { el.settings.hidden = true; });
el.settings.addEventListener('click', (e) => { if (e.target === el.settings) el.settings.hidden = true; });

function onLevel(peak) {
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
  const bars = el.mic.querySelectorAll('.mic-bars i');
  bars.forEach((b, k) => b.classList.toggle('on', db > [-48, -32, -18][k]));
  if (el.settings.hidden) return;
  el.level.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
}

// ---------- toast ----------
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), 1400);
}

// ---------- keep the screen awake ----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    }
  } catch {}
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) {
    if (!wakeLock) requestWakeLock();
    audio?.ctx.resume().catch(() => {});
  }
});

// ---------- no zooming: fast taps (tap tempo, −/＋) must never zoom the page ----------
// iPhone ignores "user-scalable=no", so swallow the second tap of a double tap and
// still deliver it as a click to whatever button it landed on.
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const t = e.timeStamp;
  if (t - lastTouchEnd < 400) {
    e.preventDefault();
    const b = e.target.closest?.('button');
    if (b && !b.disabled) b.click();
  }
  lastTouchEnd = t;
}, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// ---------- wire up ----------
el.start.addEventListener('click', startListening);
el.stop.addEventListener('click', stop);
setChair(state.chair, { announce: false });
renderFavs();
renderDots();
render();
if (isDemo) {
  document.querySelector('.start-sub').textContent = 'demo mode: simulated drummer';
  window.__pocket = { chair, state }; // for poking at it from the console
}

// offline support (skipped on localhost so edits show up straight away while developing)
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
