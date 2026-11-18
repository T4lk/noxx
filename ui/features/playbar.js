// Player bar settings, ported from riff:
//   Interface > Show wave visualizer in bottom bar, Visualizer opacity / smoothness / sensitivity
//   Tracks    > Wavy progress bar, Progress bar knob, Progress bar background, Crossfade
// The visualizer reads riff.getAnalyser() (an AnalyserNode tapped from the fx.js audio graph).
// The progress bar itself is drawn by app.js (drawWave), which reads the body.no-wavy / no-knob /
// no-progress-bg classes set here; crossfade lives in app.js too and reads the 'crossfade' pref.
(() => {
  const R = window.riff;

  const DEF = { barWave: true, vizOpacity: 85, vizSmooth: 70, vizSens: 100, wavyProgress: true, progressKnob: true, progressBg: true, crossfade: 0 };
  const P = {};
  for (const [k, v] of Object.entries(DEF)) {
    const got = R.load(k, v);
    P[k] = typeof v === 'boolean' ? got !== false : (Number.isFinite(+got) ? +got : v);
  }
  const set = (k, v) => { P[k] = v; R.store(k, v); };

  // ------------------------------------------------------------ visualizer settings (shared with the karaoke view)

  /** riff's vizSettings(): smooth 0-0.95, sens 0.3-3, plus the karaoke visualizer opacity 0.1-1. */
  R.vizSettings = () => ({
    smooth: Math.min(0.95, Math.max(0, P.vizSmooth / 100)),
    sens: Math.min(3, Math.max(0.3, P.vizSens / 100)),
    opacity: Math.min(1, Math.max(0.1, P.vizOpacity / 100)),
  });
  function applyVizVars() {
    document.documentElement.style.setProperty('--viz-opacity', String(R.vizSettings().opacity));
    R.emit('vizsettings', R.vizSettings());
  }

  // ------------------------------------------------------------ progress bar flags

  function applyProgress() {
    const b = document.body.classList;
    b.toggle('no-wavy', !P.wavyProgress);
    b.toggle('no-knob', !P.progressKnob);
    b.toggle('no-progress-bg', !P.progressBg);
    R.redrawWave?.();
  }

  // ------------------------------------------------------------ bottom bar wave visualizer (riff #visualizer-canvas)

  // riff: a 60x24 canvas at the start of the right side of the player bar, 12 bars 3px wide with 2px gaps,
  // bar i = frequency bin i*2 of a 128-point FFT (smoothing 0.8), at least 2px tall, radius 2.
  const W = 60, H = 24, BARS = 12, BAR_W = 3, GAP = 2;
  const box = document.createElement('div');
  box.className = 'pb-viz visualizer-container';
  box.title = 'Visualizer';
  const cv = document.createElement('canvas');
  box.append(cv);
  (document.querySelector('.pb-right') || document.body).prepend(box);
  const c2 = cv.getContext('2d');
  let freq = null, color = '#fff', loop = 0, drawn = false;

  function sizeCanvas() {
    const r = cv.getBoundingClientRect();
    const k = Math.max(1, (r.width ? r.width / W : 1) * (window.devicePixelRatio || 1));
    const w = Math.round(W * k), h = Math.round(H * k);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    c2.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  }
  const refreshColor = () => { color = getComputedStyle(box).color || '#fff'; };

  function draw() {
    c2.clearRect(0, 0, W, H);
    drawn = false;
    if (R.audio.paused) return;
    const an = R.getAnalyser('bar');
    if (!an) return;
    if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(freq);
    c2.fillStyle = color;
    const startX = (W - BARS * (BAR_W + GAP)) / 2;
    c2.beginPath();
    for (let i = 0; i < BARS; i++) {
      const h = Math.max(2, ((freq[i * 2] || 0) / 255) * (H - 4));
      c2.roundRect(startX + i * (BAR_W + GAP), H - h, BAR_W, h, 2);
    }
    c2.fill();
    drawn = true;
  }
  function tick() {
    loop = 0;
    if (!P.barWave || document.body.classList.contains('perf')) { c2.clearRect(0, 0, W, H); return; }
    draw();
    if (!R.audio.paused) loop = R.nextFrame(tick, R.FPS_PLAYING);
  }
  function kick() { if (!loop && P.barWave) loop = R.nextFrame(tick, R.FPS_PLAYING); }

  function applyBarWave() {
    box.style.display = P.barWave ? '' : 'none';
    if (P.barWave) { R.getAnalyser('bar'); sizeCanvas(); refreshColor(); kick(); }
    else { R.releaseAnalyser('bar'); c2.clearRect(0, 0, W, H); }
  }
  R.audio.addEventListener('play', kick);
  R.audio.addEventListener('playing', kick);
  R.audio.addEventListener('pause', () => kick());   // one last tick clears the bars
  R.on('theme', () => refreshColor());
  window.addEventListener('resize', () => { if (P.barWave) sizeCanvas(); });
  document.fonts?.ready.then(() => { if (P.barWave) sizeCanvas(); });

  // ------------------------------------------------------------ settings rows (same markup as themes.js)

  const row = (name, desc) => {
    const el = document.createElement('div');
    el.className = 'th-item setting-item';
    el.innerHTML = `<div class="th-top"><div class="th-col"><span class="th-name">${name}</span>${desc ? `<span class="th-desc">${desc}</span>` : ''}</div></div>`;
    return el;
  };
  function toggleRow(k, name, desc, after) {
    const el = row(name, desc);
    el.firstChild.append(R.switch(P[k], (on) => { set(k, on); after(); }, { label: name }));
    return el;
  }
  function sliderRow(k, name, desc, min, max, step, fmt, hints, after) {
    const el = row(name, desc);
    el.firstChild.insertAdjacentHTML('beforeend', '<span class="th-side"><span class="th-val"></span></span>');
    el.insertAdjacentHTML('beforeend', `<div class="th-sl"><div class="th-sl-on"></div><div class="th-sl-off"></div><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${name}"></div>`
      + (hints ? `<div class="th-hints">${hints.map((h) => `<span>${h}</span>`).join('')}</div>` : ''));
    const input = el.querySelector('input'), lbl = el.querySelector('.th-val');
    const sync = () => {
      lbl.textContent = fmt(+input.value);
      input.parentElement.style.setProperty('--v', (+input.value - min) / (max - min));
    };
    input.value = P[k];
    sync();
    input.addEventListener('input', () => { set(k, +input.value); sync(); after(); });
    return el;
  }
  const pct = (v) => `${v}%`;

  R.addSettings(() => {
    const g = R.add('<div class="th-group" data-group="interface-visualizer"></div>');
    g.append(
      toggleRow('barWave', 'Show wave visualizer in bottom bar', '', applyBarWave),
      sliderRow('vizOpacity', 'Visualizer opacity', 'Adjust transparency of the TV karaoke visualizer', 10, 100, 5, pct, null, applyVizVars),
      sliderRow('vizSmooth', 'Visualizer smoothness', 'Higher = calmer, slower bars', 0, 95, 1, pct, null, applyVizVars),
      sliderRow('vizSens', 'Visualizer sensitivity', 'Higher = taller bars', 30, 300, 5, pct, null, applyVizVars),
    );
  }, 'interface');

  R.addSettings((view) => {
    const groups = (view || document).querySelectorAll('[data-group="tracks-playback"]');
    const g = groups[groups.length - 1] || R.add('<div class="th-group" data-group="tracks-playback"></div>');
    g.append(
      toggleRow('wavyProgress', 'Wavy progress bar', '', applyProgress),
      toggleRow('progressKnob', 'Progress bar knob', '', applyProgress),
      toggleRow('progressBg', 'Progress bar background', 'Show the uncompleted track rail in the playbar', applyProgress),
      sliderRow('crossfade', 'Crossfade', '', 0, 12, 1, (v) => (v > 0 ? `${v}s` : 'Off'), ['Off', '6s', '12s'], () => {}),
    );
  }, 'tracks');

  applyProgress();
  applyVizVars();
  applyBarWave();

  // ------------------------------------------------------------ selftest

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ok = (c) => (c ? 'OK' : 'FAILED');
    const saved = { ...P };
    const b = document.body.classList;
    try {
      // 1. analyser tap
      let an = R.getAnalyser('selftest');
      for (let i = 0; !an && i < 20; i++) { await wait(100); an = R.getAnalyser('selftest'); }
      if (an) {
        log(`playbar analyser ${ok(an instanceof AnalyserNode && an.fftSize === 128 && Math.abs(an.smoothingTimeConstant - 0.8) < 1e-6 && /\+viz$/.test(R.fx?.routing || ''))}: fft=${an.fftSize} smoothing=${an.smoothingTimeConstant} routing=${R.fx?.routing} holders=${R.analyserHolders ? R.analyserHolders().join(',') : '?'}`);
      } else log('playbar analyser: skipped (audio graph not started: no gesture or playback yet)');
      R.releaseAnalyser('selftest');

      // 2. bar visualizer draws while playing
      set('barWave', true); applyBarWave();
      if (!R.audio.paused && an) {
        await wait(300);
        draw();
        const px = c2.getImageData(0, 0, cv.width, cv.height).data;
        let lit = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
        log(`playbar visualizer ${ok(drawn && lit > 0 && box.offsetParent !== null)}: ${lit} lit px on ${cv.width}x${cv.height}`);
      } else log('playbar visualizer: skipped (nothing playing)');
      set('barWave', false); applyBarWave();
      log(`playbar visualizer off ${ok(box.style.display === 'none' && !/\+viz$/.test(R.fx?.routing || ''))}: routing=${R.fx?.routing}`);

      // 3. progress bar prefs -> body classes
      set('wavyProgress', false); set('progressKnob', false); set('progressBg', false); applyProgress();
      const off = b.contains('no-wavy') && b.contains('no-knob') && b.contains('no-progress-bg');
      set('wavyProgress', true); set('progressKnob', true); set('progressBg', true); applyProgress();
      const on = !b.contains('no-wavy') && !b.contains('no-knob') && !b.contains('no-progress-bg');
      log(`playbar progress prefs ${ok(off && on && R.load('wavyProgress', null) === true)}: off=${off} on=${on}`);

      // 4. viz settings mapping (riff clamps)
      set('vizSmooth', 70); set('vizSens', 100); set('vizOpacity', 85); applyVizVars();
      const vs = R.vizSettings();
      log(`playbar viz settings ${ok(vs.smooth === 0.7 && vs.sens === 1 && vs.opacity === 0.85 && getComputedStyle(document.documentElement).getPropertyValue('--viz-opacity').trim() === '0.85')}: ${JSON.stringify(vs)}`);

      // 5. crossfade: jump near the end with a 4 s crossfade and watch fade-out -> next track -> fade-in
      set('crossfade', 4);
      const from = R.player.current, d = R.duration();
      if (from && !R.audio.paused && d > 10 && (R.upcoming(1).length || R.player.repeat === 'all')) {
        R.audio.currentTime = d - 3.5;
        let minGain = 1, changed = false, back = false;
        for (let i = 0; i < 120 && !back; i++) {
          await wait(100);
          const xf = R.crossfade;
          minGain = Math.min(minGain, xf.gain);
          if (R.player.current !== from) changed = true;
          if (changed && !R.audio.paused && xf.gain > 0.95) back = true;
        }
        log(`playbar crossfade ${ok(minGain < 0.2 && changed && back)}: min gain ${minGain.toFixed(2)}, next track ${changed}, faded back in ${back}`);
      } else log(`playbar crossfade: skipped (needs a playing track with something after it; playing=${!R.audio.paused} dur=${Math.round(d || 0)})`);
      set('crossfade', 0);
      log(`playbar crossfade off ${ok(R.crossfade.secs === 0)}`);
    } catch (e) {
      log('playbar selftest error: ' + R.errText(e));
    } finally {
      for (const [k, v] of Object.entries(saved)) set(k, v);
      applyProgress(); applyVizVars(); applyBarWave();
    }
  });
})();
