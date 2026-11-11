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
  favs: store.get('favs', [90, 100, 120, 140]),
  swiped: store.get('swiped', false),
  chair: store.get('chair', false),
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
  marker: $('marker'), zone: $('zone'), dev: $('devText'), pulse: $('pulse'),
  favs: $('favs'), addFav: $('addFav'), stop: $('stopBtn'), lockBadge: $('lockBadge'),
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
    return showStartError('The microphone needs a secure (https) connection. Open Pocket from its https link.');
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
  requestWakeLock();
  loop();
  if (!store.get('tipsSeen', false)) showTips();
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
  el.pulse.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => el.pulse.classList.remove('on')));
  update();
}

function update() {
  const t = now();
  const dt = lastUpdateAt ? Math.min(0.5, t - lastUpdateAt) : 0;
  lastUpdateAt = t;
  state.reading = follower.update(t, state.target);
  updateStatus();
  session.add(dt);
  const r = state.reading;
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
  reset() { this.t = 0; this.sumBpm = 0; this.sumDev = 0; this.locked = 0; this.rush = 0; this.drag = 0; },
  add(dt) {
    const r = state.reading;
    if (!state.running || r.mode !== 'live' || r.bpm == null || !dt) return;
    this.t += dt;
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
    };
  },
};
session.reset();

function showSummary(s) {
  const pct = (x) => Math.round(x * 100) + '%';
  const devR = Math.round(s.dev * 10) / 10;
  $('sumAvg').textContent = Math.round(s.avg);
  $('sumDev').textContent = devR === 0 ? '±0' : (devR > 0 ? '+' : '−') + Math.abs(devR);
  const m = Math.floor(s.seconds / 60);
  $('sumTime').textContent = m + ':' + String(Math.round(s.seconds % 60)).padStart(2, '0');
  $('sumLock').textContent = pct(s.locked);
  $('sumRush').textContent = pct(s.rush);
  $('sumDrag').textContent = pct(s.drag);
  $('sumBarDrag').style.width = pct(s.drag);
  $('sumBarLock').style.width = pct(s.locked);
  $('sumBarRush').style.width = pct(s.rush);
  let verdict;
  if (s.locked >= 0.75) verdict = 'Solid. In the pocket most of the time.';
  else if (s.rush > s.drag + 0.1 && s.rush > 0.15) verdict = 'You tended to rush. Try sitting back on the beat.';
  else if (s.drag > s.rush + 0.1 && s.drag > 0.15) verdict = 'You tended to drag. Try pushing the time forward.';
  else verdict = 'Some drift both ways. Keep an eye on the slider.';
  $('sumVerdict').textContent = verdict;
  const cs = chair.stats();
  $('sumChairs').hidden = !state.usedChair;
  $('sumTaken').textContent = cs.taken;
  $('sumDodged').textContent = cs.dodged;
  const bs = Math.floor(cs.bestStreak);
  $('sumStreak').textContent = Math.floor(bs / 60) + ':' + String(bs % 60).padStart(2, '0');
  el.summary.hidden = false;
}
$('sumDone').addEventListener('click', () => { el.summary.hidden = true; });

// ---------- render ----------
const FEEL_TEXT = { half: 'HALF-TIME FEEL', double: 'DOUBLE-TIME FEEL' };

function render() {
  const s = state.running ? state.status : 'idle';
  app.className = 'state-' + s + (state.locked ? ' locked' : '') + (state.swiped ? ' swiped' : '') + (state.chair ? ' chair-on' : '');
  el.target.textContent = state.target;
  el.overlayBpm.textContent = state.target;

  const range = Math.max(4, state.target * 0.08); // meter full scale: ±8% of target
  el.zone.style.width = Math.min(100, (state.tolerance / range) * 100) + '%';

  const r = state.reading;
  const feel = state.running && r.mode === 'live' ? FEEL_TEXT[r.feel] : null;
  el.feel.hidden = !feel;
  if (feel) el.feel.textContent = feel;

  if (!state.running || r.bpm == null || s === 'listen') {
    el.live.textContent = '---';
    el.status.classList.remove('blink');
    el.status.textContent = 'LISTENING';
    el.tip.textContent = state.running ? 'start playing' : '';
    el.marker.style.left = '50%';
    el.dev.textContent = '±0';
    return;
  }

  const dev = r.bpm - state.target;
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

function setTarget(bpm, { bump = true } = {}) {
  const b = clampBpm(bpm);
  if (b === state.target) return;
  state.target = b;
  store.set('target', b);
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
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setTarget(60 / avg, { bump: false });
  }
}

// ---------- favourites ----------
function renderFavs() {
  el.favs.innerHTML = '';
  if (!state.favs.length) {
    const s = document.createElement('span');
    s.className = 'favs-empty';
    s.textContent = 'save tempos with ＋';
    el.favs.appendChild(s);
    return;
  }
  for (const bpm of state.favs) {
    const b = document.createElement('button');
    b.className = 'chip' + (bpm === state.target ? ' active' : '');
    b.textContent = bpm;
    b.setAttribute('aria-label', `Set target to ${bpm} BPM (hold to remove)`);
    let holdTimer = 0;
    let held = false;
    b.addEventListener('pointerdown', () => {
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        b.classList.add('removing');
        if (navigator.vibrate) navigator.vibrate(20);
        setTimeout(() => {
          state.favs = state.favs.filter((x) => x !== bpm);
          store.set('favs', state.favs);
          renderFavs();
          toast(`Removed ${bpm}`);
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
      setTarget(bpm);
    });
    el.favs.appendChild(b);
  }
  el.favs.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

el.addFav.addEventListener('click', () => {
  if (state.favs.includes(state.target)) return toast(`${state.target} is already saved`);
  if (state.favs.length >= 12) return toast('Max 12. Hold one to remove it');
  state.favs = [...state.favs, state.target].sort((a, b) => a - b);
  store.set('favs', state.favs);
  renderFavs();
  if (!store.get('favHint', false)) { store.set('favHint', true); toast(`Saved ${state.target}. Hold to remove`); }
  else toast(`Saved ${state.target}`);
});

// ---------- lock (set in Settings; the 🔒 LOCKED badge unlocks with one tap) ----------
function setLocked(on) {
  state.locked = on;
  toast(on ? 'Target locked' : 'Target unlocked');
  renderSettings();
  render();
}
el.lockBadge.addEventListener('click', () => setLocked(false));

// ---------- settings ----------
function renderSettings() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', String(state[key]) === b.dataset.value);
      if (key === 'difficulty') b.disabled = !state.chair;
    });
  });
}
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    if (key === 'chair') return setChair(b.dataset.value === 'true');
    if (key === 'locked') return setLocked(b.dataset.value === 'true');
    const value = key === 'tolerance' ? Number(b.dataset.value) : b.dataset.value;
    state[key] = value;
    if (key === 'difficulty') chair.setDifficulty(value);
    store.set(key, value);
    if (key === 'sensitivity' && audio) audio.node.port.postMessage({ sensitivity: value });
    renderSettings();
    if (state.running) updateStatus();
    render();
  });
});
el.settingsBtn.addEventListener('click', () => { renderSettings(); el.settings.hidden = false; });
el.closeSettings.addEventListener('click', () => { el.settings.hidden = true; });
el.settings.addEventListener('click', (e) => { if (e.target === el.settings) el.settings.hidden = true; });

function onLevel(peak) {
  if (el.settings.hidden) return;
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
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

// ---------- wire up ----------
el.start.addEventListener('click', startListening);
el.stop.addEventListener('click', stop);
setChair(state.chair, { announce: false });
renderFavs();
render();
if (isDemo) {
  document.querySelector('.start-sub').textContent = 'demo mode: simulated drummer';
  window.__pocket = { chair, state }; // for poking at it from the console
}

// offline support (skipped on localhost so edits show up straight away while developing)
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
