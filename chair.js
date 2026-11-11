// Pocket — CHAIR MODE.
//
// Drift majorly out of the pocket and a folding chair comes flying.
//   • HEAT builds only while you're MAJORLY off (a % of the target, set by difficulty);
//     further off = faster. It drains when you're back in the zone.
//   • Full heat + still majorly off → wind-up: the chair appears top-right,
//     wobbling, for ~1.1 s.
//   • Get back in the pocket during the wind-up → DODGED (it flies past).
//     Don't → HIT (screen shake, glass crack shoots out, fades in ~1 s).
//   • Infinite chairs. Nothing ever stops: keep playing and save the song.
// Purely visual: no sound, so the mic never hears it.

// ---------- 8-bit sprites ----------
// '#' body/outline, '+' highlight, '.' transparent
// Black metal folding chair, front-on: post tips, backrest panel, open back,
// seat with a metal edge highlight, front legs full length, back legs set in.
const CHAIR = [
  '.#.........#....',
  '.#.........#....',
  '.###########....',
  '.#+++++++++#....',
  '.#+++++++++#....',
  '.###########....',
  '.#.........#....',
  '.#.........#....',
  '.#.........#....',
  '.#.........##...',
  '.##############.',
  '#++++++++++++++#',
  '################',
  '##.#.......#..##',
  '##.#.......#..##',
  '##.#.......#..##',
  '##.#.......#..##',
  '##.#.......#..##',
  '##.#.......#..##',
  '##............##',
  '##............##',
  '##............##',
];

function spriteSVG(map, colors) {
  const h = map.length;
  const w = map[0].length;
  let rects = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = colors[map[y][x]];
      if (c) rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// Shattered-glass crack (like a real phone screen): a chipped impact point,
// 14–18 long, thin, tapering radial cracks with the odd branch, and a couple of
// partial rings joining neighbouring cracks. White with a faint warm glow.
// Each radial crack is its own group so it can shoot out from the centre.
function crackSVG() {
  const C = 150;
  const f = (v) => v.toFixed(1);
  const rand = (a, b) => a + Math.random() * (b - a);

  // tapered sliver along a polyline: wide at the root, a point at the tip
  const sliver = (pts, w0) => {
    const left = [], right = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const w = w0 * (1 - k / (pts.length - 1));
      const nx = (-dy / len) * w, ny = (dx / len) * w;
      left.push(`${f(pts[k][0] + nx)},${f(pts[k][1] + ny)}`);
      right.unshift(`${f(pts[k][0] - nx)},${f(pts[k][1] - ny)}`);
    }
    return left.concat(right).join(' ');
  };
  // a slightly jagged, mostly straight line heading out at angle a
  const crackLine = (x, y, a, len, segs) => {
    const pts = [[x, y]];
    for (let k = 1; k <= segs; k++) {
      a += rand(-0.12, 0.12);
      x += Math.cos(a) * (len / segs);
      y += Math.sin(a) * (len / segs);
      pts.push([x, y]);
    }
    return pts;
  };

  const n = 14 + Math.floor(Math.random() * 5);
  const spin = Math.random() * Math.PI * 2;
  const rays = [];
  let arms = '';
  for (let i = 0; i < n; i++) {
    const a = spin + (i / n) * Math.PI * 2 + rand(-0.15, 0.15);
    const len = Math.random() < 0.35 ? rand(110, 145) : rand(45, 100);
    const r0 = rand(5, 9);                                   // start at the edge of the chipped hole
    const pts = crackLine(C + Math.cos(a) * r0, C + Math.sin(a) * r0, a, len, 5);
    rays.push({ a, pts, len });
    let g = `<polygon points="${sliver(pts, rand(1.3, 2.2))}" fill="#f6efe2"/>`;
    g += `<polyline points="${pts.map((p) => f(p[0]) + ',' + f(p[1])).join(' ')}" fill="none" stroke="#fff" stroke-width=".45"/>`;
    if (Math.random() < 0.35) {                              // a short branch off the middle
      const m = pts[2 + Math.floor(Math.random() * 2)];
      const b = crackLine(m[0], m[1], a + (Math.random() < 0.5 ? -1 : 1) * rand(0.3, 0.6), len * rand(0.25, 0.45), 3);
      g += `<polygon points="${sliver(b, 0.9)}" fill="#f6efe2"/>`;
    }
    arms += `<g class="crk">${g}</g>`;
  }

  // partial concentric rings: jagged links between neighbouring cracks
  let rings = '';
  for (const r of [rand(24, 34), rand(52, 66)]) {
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.45) continue;
      const A = rays[i], B = rays[(i + 1) % n];
      if (A.len < r + 5 || B.len < r + 5) continue;
      const pa = [C + Math.cos(A.a) * r, C + Math.sin(A.a) * r];
      const pb = [C + Math.cos(B.a) * r * rand(0.9, 1.1), C + Math.sin(B.a) * r * rand(0.9, 1.1)];
      const mid = (A.a + B.a + (B.a < A.a ? Math.PI * 2 : 0)) / 2;
      const pm = [C + Math.cos(mid) * r * rand(1.0, 1.05), C + Math.sin(mid) * r * rand(1.0, 1.05)];
      rings += `<path d="M${f(pa[0])} ${f(pa[1])} Q${f(pm[0])} ${f(pm[1])} ${f(pb[0])} ${f(pb[1])}" fill="none" stroke="#f6efe2" stroke-width=".9" stroke-linecap="round"/>`;
    }
  }

  // chipped impact hole
  let hole = '';
  const hk = 9;
  for (let k = 0; k < hk; k++) {
    const a = (k / hk) * Math.PI * 2, r = rand(4, 8);
    hole += `${f(C + Math.cos(a) * r)},${f(C + Math.sin(a) * r)} `;
  }

  return `<svg viewBox="0 0 300 300" aria-hidden="true">
    <g class="crk-ring">${rings}</g>${arms}
    <g class="crk-core"><circle cx="${C}" cy="${C}" r="16" fill="#fff" opacity=".18"/><polygon points="${hole}" fill="#fff" opacity=".9"/></g>
  </svg>`;
}

const CHAIR_COLORS = { '#': '#1b1b1d', '+': '#5c5c62' };

// major: how far off (as % of the target tempo) counts as a MAJOR rush/drag.
// fill:  seconds of playing exactly that far off before the chair is thrown
//        (further off = faster; half as far off = no heat at all).
const DIFFICULTY = {
  gentle:     { major: 6,   fill: 4 },   // 120 BPM → 7+ BPM off
  strict:     { major: 4,   fill: 3 },   // 120 BPM → ~5 BPM off
  relentless: { major: 2.5, fill: 2.5 }, // 120 BPM → 3 BPM off
};

export class ChairMode {
  constructor({ app, liveEl, hud, onHaptic }) {
    this.app = app;
    this.liveEl = liveEl;
    this.onHaptic = onHaptic || (() => {});
    this.enabled = false;
    this.difficulty = 'strict';

    // chair line (its space is always reserved in the layout): streak · heat · score
    hud.innerHTML = `
      <span>STREAK <b id="hudStreak">0:00</b></span>
      <div class="heat"><div id="hudHeat" class="heat-fill"></div></div>
      <span>HIT <b id="hudHit">0</b> · DODGED <b id="hudDodge">0</b></span>`;
    this.hud = {
      streak: hud.querySelector('#hudStreak'), hit: hud.querySelector('#hudHit'),
      dodge: hud.querySelector('#hudDodge'), heat: hud.querySelector('#hudHeat'),
    };

    // flying chair + crack + impact flash
    this.layer = document.createElement('div');
    this.layer.className = 'chair-layer';
    this.layer.innerHTML = `<div class="chair-sprite">${spriteSVG(CHAIR, CHAIR_COLORS)}</div><div class="crack"></div><div class="flash"></div>`;
    document.body.appendChild(this.layer);
    this.chairEl = this.layer.querySelector('.chair-sprite');
    this.crackEl = this.layer.querySelector('.crack');
    this.flashEl = this.layer.querySelector('.flash');

    this.reset();
  }

  reset() {
    this.heat = 0;
    this.phase = 'idle'; // idle | windup | cooldown
    this.phaseT = 0;
    this.flash = null;   // { kind: 'hit'|'dodge', t }
    this.streak = 0;
    this.bestStreak = 0;
    this.taken = 0;
    this.dodged = 0;
    this._hideChair();
    this._renderHud();
  }

  setEnabled(on) {
    this.enabled = on;
    this.app.classList.toggle('chair-on', on);
    if (!on) { this.phase = 'idle'; this.heat = 0; this._hideChair(); }
    this._renderHud();
  }

  setDifficulty(d) { if (DIFFICULTY[d]) this.difficulty = d; }

  stats() { return { taken: this.taken, dodged: this.dodged, bestStreak: this.bestStreak }; }

  /**
   * Called on every tempo update.
   * ctx: { running, mode: 'live'|'hold'|'listen', status, dev, tol, target }
   */
  update(dt, ctx) {
    if (this.flash) {
      this.flash.t -= dt;
      if (this.flash.t <= 0) this.flash = null;
    }
    const live = ctx.running && ctx.mode === 'live';

    // streak runs whatever the mode, so the summary has it
    if (live && ctx.status === 'locked') {
      this.streak += dt;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else if (live) {
      this.streak = 0;
    }

    if (!this.enabled) return;
    const d = DIFFICULTY[this.difficulty];
    const pct = ctx.target ? (Math.abs(ctx.dev) / ctx.target) * 100 : 0;
    const outside = Math.abs(ctx.dev) > ctx.tol;
    const ratio = pct / d.major;            // 1 = a major rush/drag
    const major = live && outside && ratio >= 1;

    if (this.phase === 'windup') {
      this.phaseT -= dt;
      if (!live || ctx.status === 'locked') return this._dodge();
      if (this.phaseT <= 0) return this._hit();
    } else {
      if (this.phase === 'cooldown') {
        this.phaseT -= dt;
        if (this.phaseT <= 0) this.phase = 'idle';
      }
      if (live && outside && ratio >= 0.5) this.heat += (dt * ratio) / d.fill;
      else this.heat -= dt * (live && !outside ? 0.4 : 0.15);
      this.heat = Math.max(0, Math.min(1, this.heat));

      if (this.phase === 'idle' && this.heat >= 1 && major) this._windup();
    }
    this._renderHud();
  }

  /** text overrides for the status line, or null */
  text(status, big) {
    if (!this.enabled) return null;
    if (this.phase === 'windup') return { status: 'INCOMING', tip: 'lock in to dodge!', blink: true };
    if (this.flash?.kind === 'hit') return { status: 'AGAIN.', tip: 'save the song' };
    if (this.flash?.kind === 'dodge') return { status: 'DODGED', tip: 'nice save' };
    if (status === 'locked') return { status: 'LOCKED IN', tip: 'keep it there.' };
    if (status === 'rush') return { status: 'RUSHING', tip: big ? 'WAY too fast.' : 'too fast.' };
    if (status === 'drag') return { status: 'DRAGGING', tip: big ? 'pick it UP.' : 'dragging.' };
    if (status === 'hold') return { status: 'BREAK', tip: "don't lose it." };
    return null;
  }

  // ---------- phases ----------
  _windup() {
    this.phase = 'windup';
    this.phaseT = 1.1;
    const o = this._origin();
    this.chairEl.style.left = o.x + 'px';
    this.chairEl.style.top = o.y + 'px';
    this.chairEl.getAnimations().forEach((a) => a.cancel());
    this.chairEl.style.opacity = '1';
    this.chairEl.animate(
      [{ transform: 'translate(30px,-20px) rotate(0deg)', opacity: 0 },
       { transform: 'translate(0,0) rotate(-14deg)', opacity: 1, offset: 0.25 },
       { transform: 'translate(0,0) rotate(-24deg)', offset: 0.6 },
       { transform: 'translate(0,0) rotate(-18deg)', offset: 0.8 },
       { transform: 'translate(0,0) rotate(-28deg)' }],
      { duration: 1100, fill: 'forwards', easing: 'ease-in-out' },
    );
  }

  _hit() {
    this.taken++;
    this._endThrow('hit');
    const o = this._origin();
    const t = this._targetPoint();
    const dx = t.x - o.x - 24, dy = t.y - o.y - 27;
    const a = this.chairEl.animate(
      [{ transform: 'translate(0,0) rotate(-28deg) scale(1)' },
       { transform: `translate(${dx}px,${dy}px) rotate(560deg) scale(2.1)`, offset: 0.7 },
       { transform: `translate(${dx}px,${dy + 30}px) rotate(600deg) scale(2.2)`, opacity: 1, offset: 0.8 },
       { transform: `translate(${dx - 30}px,${dy + 600}px) rotate(700deg) scale(2)`, opacity: 0 }],
      { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.5,0,.8,1)' },
    );
    setTimeout(() => {
      // impact
      this.crackEl.innerHTML = crackSVG();
      this.crackEl.style.left = t.x + 'px';
      this.crackEl.style.top = t.y + 'px';
      // cracks shoot out from the impact point, one after another, then everything fades
      this.crackEl.querySelectorAll('.crk').forEach((g, i) => g.animate(
        [{ transform: 'scale(0)' }, { transform: 'scale(1.06)', offset: 0.75 }, { transform: 'scale(1)' }],
        { duration: 160, delay: Math.random() * 70, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' },
      ));
      this.crackEl.querySelector('.crk-ring').animate(
        [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: 90, fill: 'backwards' },
      );
      this.crackEl.querySelector('.crk-core').animate(
        [{ transform: 'scale(0)' }, { transform: 'scale(1.35)', offset: 0.6 }, { transform: 'scale(1)' }],
        { duration: 220, easing: 'ease-out' },
      );
      this.crackEl.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 1300, fill: 'forwards' });
      this.flashEl.animate([{ opacity: 0.35 }, { opacity: 0 }], { duration: 280, fill: 'forwards' });
      this.app.animate(
        [{ transform: 'translate(0,0)' }, { transform: 'translate(-7px,4px)' }, { transform: 'translate(6px,-5px)' },
         { transform: 'translate(-4px,-2px)' }, { transform: 'translate(3px,3px)' }, { transform: 'translate(0,0)' }],
        { duration: 320, easing: 'ease-out' },
      );
      this.onHaptic([40, 30, 60]);
    }, 630);
    a.onfinish = () => this._hideChair();
  }

  _dodge() {
    this.dodged++;
    this._endThrow('dodge');
    const o = this._origin();
    const dx = -o.x - 160;
    const dy = window.innerHeight * 0.25;
    const a = this.chairEl.animate(
      [{ transform: 'translate(0,0) rotate(-28deg)' },
       { transform: `translate(${dx}px,${dy}px) rotate(-560deg) scale(1.4)`, opacity: 1 }],
      { duration: 650, fill: 'forwards', easing: 'linear' },
    );
    a.onfinish = () => this._hideChair();
  }

  _endThrow(kind) {
    this.phase = 'cooldown';
    this.phaseT = 4;
    this.heat = kind === 'hit' ? 0.2 : 0.1;
    this.flash = { kind, t: 1.4 };
    this.chairEl.getAnimations().forEach((an) => an.cancel());
    this._renderHud();
  }

  _hideChair() {
    this.chairEl.getAnimations().forEach((a) => a.cancel());
    this.chairEl.style.opacity = '0';
  }

  // thrown in from the top-right corner; lands on the big number
  _origin() {
    return { x: window.innerWidth - 70, y: 70 };
  }
  _targetPoint() {
    const r = this.liveEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  _renderHud() {
    const s = Math.floor(this.streak);
    this.hud.streak.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    this.hud.hit.textContent = this.taken;
    this.hud.dodge.textContent = this.dodged;
    this.hud.heat.style.width = Math.round(this.heat * 100) + '%';
    this.hud.heat.classList.toggle('hot', this.heat > 0.7);
  }
}
