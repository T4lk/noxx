'use strict';
// fx: riff's audio menu (Enhancer, Speed & Pitch, Audio FX, Equalizer, Sleep timer, plus the presets that riff
// keeps in its rail drawer). The numbers, node types and chain order are riff's audio-engine.js one to one.
// Speed / pitch only touch the <audio> element. Everything else runs through one Web Audio graph that is
// built the first time a non-default effect is used; whenever every effect is back at its default the
// element is wired straight to the speakers again, so normal playback stays untouched.
(() => {
  const R = window.riff;
  if (!R) return;
  const audio = R.audio;

  // Cross-origin media is zeroed inside Web Audio unless it is fetched with CORS. SoundCloud's CDNs answer
  // `Access-Control-Allow-Origin: *`, Tauri's asset protocol echoes the window origin, hls.js plays from a
  // same-origin MSE blob. Has to be set before the first src.
  try { if (!audio.getAttribute('src')) audio.crossOrigin = 'anonymous'; } catch (e) {}

  // ------------------------------------------------------------ settings (riff app.js defaults)

  const BAND_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const defAudio = () => ({ speed: 1, speedPitch: 1, pitch: 0, reverb: 0, distortion: 0, volume: 1, echo: 0, eq: { low: 0, mid: 0, high: 0 }, eqBands: BAND_FREQS.map(() => 0) });
  const defHq = () => ({ engine: 'hqmusic-3', preset: 'studio', vocal: 0, air: 0, bass: 0 });
  const ENGINES = [
    ['hqmusic-3', 'hqmusic-3 (Harmonic Restorer)'],
    ['glyphs-7B', 'glyphs-7B (High-End Upscaler)'],
    ['fyro1.1', 'fyro1.1 (Dynamic Depth)'],
  ];
  // riff's built-in presets (app.js defaultPresets)
  const PRESETS = [
    ['p_default', 'default', {}],
    ['p_speedup', 'speed up (orig pitch)', { speed: 1.35 }],
    ['p_speedup_pitch', 'speed up (tape pitch)', { speedPitch: 1.30 }],
    ['p_slowed', 'slowed + reverb', { speedPitch: 0.82, reverb: 65, echo: 15 }],
    ['p_nightcore', 'nightcore', { speedPitch: 1.25, reverb: 20 }],
    ['p_distortion', 'distortion hard', { distortion: 75, volume: 1.25 }],
  ].map(([id, name, s]) => ({ id, name, settings: { ...defAudio(), ...s } }));

  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  function cleanAudio(s) {
    s = s || {};
    const eq = s.eq || {};
    const bands = Array.isArray(s.eqBands) ? s.eqBands : [];
    return {
      speed: num(s.speed, 1, 0.5, 2),
      speedPitch: num(s.speedPitch, 1, 0.5, 2),
      pitch: num(s.pitch, 0, -12, 12),
      reverb: num(s.reverb, 0, 0, 100),
      distortion: num(s.distortion, 0, 0, 100),
      volume: num(s.volume, 1, 0, 2),
      echo: num(s.echo, 0, 0, 100),
      eq: { low: num(eq.low, 0, -12, 12), mid: num(eq.mid, 0, -12, 12), high: num(eq.high, 0, -12, 12) },
      eqBands: BAND_FREQS.map((_, i) => num(bands[i], 0, -12, 12)),
    };
  }
  function cleanHq(h) {
    h = h || {};
    return {
      engine: ENGINES.some(([v]) => v === h.engine) ? h.engine : 'hqmusic-3',
      preset: typeof h.preset === 'string' ? h.preset : 'studio',
      vocal: num(h.vocal, 0, -50, 50), air: num(h.air, 0, -50, 50), bass: num(h.bass, 0, -50, 50),
    };
  }
  const cleanPresets = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.id === 'string' && p.id.startsWith('custom_'))
    .map((p) => ({ id: p.id, name: String(p.name || 'preset').slice(0, 28), settings: cleanAudio(p.settings) }));

  // Like riff: High Quality, effects and the active preset are only restored at startup when
  // "Save sound settings" is on (off by default). Normalize, custom presets and smoothing always persist.
  const S = {};
  function loadState() {
    S.persist = !!R.load('fx.persist', false);
    S.a = S.persist ? cleanAudio(R.load('fx.audio', null)) : defAudio();
    S.hq = S.persist ? cleanHq(R.load('fx.hq', null) || defHq()) : defHq();
    S.hqOn = S.persist ? !!R.load('fx.hqOn', false) : false;
    S.active = S.persist ? (R.load('fx.active', 'p_default') || null) : 'p_default';
    S.norm = !!R.load('fx.norm', false);
    S.presets = cleanPresets(R.load('fx.presets', []));
    S.smooth = R.load('fx.smooth', true) !== false;
  }
  loadState();

  let saveTimer = null;
  function persist() {
    if (!S.persist) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      R.store('fx.audio', S.a); R.store('fx.hq', S.hq); R.store('fx.hqOn', S.hqOn);
      R.store('fx.active', S.active || '');
    }, 300);
  }
  const savePresets = () => R.store('fx.presets', S.presets);

  const eqActive = (a) => !!(a.eq.low || a.eq.mid || a.eq.high || a.eqBands.some((v) => v));
  const tempoModified = (a) => a.speed !== 1 || a.speedPitch !== 1 || a.pitch !== 0;
  // Visualizers tap the graph through an AnalyserNode (riff: fftSize 128, smoothing 0.8). Each user
  // registers a key; while any is registered the graph is built even with every effect off.
  const vizUsers = new Set();
  const needsGraph = () => S.hqOn || S.norm || eqActive(S.a) || S.a.reverb > 0 || S.a.echo > 0 || S.a.distortion > 0 || S.a.volume !== 1;
  // riff's audioEngine.isModified(): only the audio settings (not High Quality / normalize) light the dot.
  const isModified = () => { const a = S.a; return tempoModified(a) || a.reverb !== 0 || a.distortion !== 0 || a.volume !== 1 || a.echo !== 0 || eqActive(a); };

  // ------------------------------------------------------------ playback rate (no graph needed)

  // riff applySettings(): "Speed (pitch)" or Pitch set -> tape mode: preservesPitch off,
  // rate = speedPitch * 2^(pitch/12) (Speed is ignored then); otherwise rate = speed with pitch preserved.
  function rateFor(a) {
    const tape = a.speedPitch !== 1 || a.pitch !== 0;
    return { tape, rate: tape ? a.speedPitch * Math.pow(2, a.pitch / 12) : a.speed };
  }
  function applyRate() {
    const { tape, rate } = rateFor(S.a);
    audio.preservesPitch = !tape;
    audio.webkitPreservesPitch = !tape;
    // The load algorithm resets playbackRate to defaultPlaybackRate on every new src (and on hls attach).
    if (audio.defaultPlaybackRate !== rate) audio.defaultPlaybackRate = rate;
    if (audio.playbackRate !== rate) audio.playbackRate = rate;
  }
  audio.addEventListener('loadedmetadata', applyRate);
  audio.addEventListener('play', applyRate);

  // ------------------------------------------------------------ Web Audio graph (riff audio-engine.js)

  const G = { ctx: null, built: false, key: '', pending: false, failed: false, forceAllow: false, suspendTimer: null };
  const ECHO_TIME = 0.3, ECHO_FEEDBACK = 0.35;

  // 0.6 s stereo white noise with an exp(-t / 0.15 s) envelope (a fresh random impulse every build / flush)
  function reverbImpulse(ctx) {
    const rate = ctx.sampleRate, len = Math.floor(rate * 0.6);
    const buf = ctx.createBuffer(2, len, rate);
    const left = buf.getChannelData(0), right = buf.getChannelData(1);
    for (let i = 0; i < len; i++) {
      const decay = Math.exp(-i / (rate * 0.15));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }
    return buf;
  }
  function distortionCurve(amount) {
    const n = 256, curve = new Float32Array(n), k = amount * 2.5, deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = k <= 0 ? x : ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }
  function harmonicCurve(amount) {
    const n = 256, curve = new Float32Array(n), k = amount * 0.02;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = x - k * Math.pow(x, 3); }
    return curve;
  }

  // Every node parameter as riff computes it from the settings (pure, so the selftest can check it).
  function params(a = S.a, h = S.hq, hqOn = S.hqOn) {
    const c12 = (v) => Math.max(-12, Math.min(12, v));
    const c4 = (v) => Math.max(-4, Math.min(4, v));
    let bass = 0, air = 0, sat = 0, ratio = 1.5;
    if (h.engine === 'hqmusic-3') sat = 0.5;
    else if (h.engine === 'glyphs-7B') { sat = 0.2; air = 2.5; }
    else if (h.engine === 'fyro1.1') { sat = 0.2; bass = 3; ratio = 2; }
    const d = a.distortion > 0;
    return {
      eq: [c12(a.eq.low), c12(a.eq.mid), c12(a.eq.high)],
      bands: a.eqBands.map(c12),
      reverb: a.reverb / 100,
      echo: a.echo / 100,
      distGain: d ? (a.distortion / 100) * 0.75 : 0,
      dry: d ? 1 - (a.distortion / 100) * 0.4 : 1,
      master: a.volume,
      hq: { threshold: -12, knee: 10, ratio, attack: 0.01, release: 0.1, sat, bass: hqOn ? c4(bass + h.bass * 0.08) : 0, vocal: hqOn ? c4(h.vocal * 0.08) : 0, air: hqOn ? c4(air + h.air * 0.08) : 0 },
    };
  }

  // The AudioContext must be allowed to run: after a user gesture, while the element is already playing
  // (autoplay is permitted then), or in selftest mode. Otherwise wait, so playback never goes silent.
  const mayStartContext = () => G.forceAllow || !navigator.userActivation || navigator.userActivation.hasBeenActive || !audio.paused;

  function makeDelay() {
    const ctx = G.ctx;
    G.delay = ctx.createDelay(1); G.delay.delayTime.value = ECHO_TIME;
    G.feedback = ctx.createGain(); G.feedback.gain.value = ECHO_FEEDBACK;
    G.delay.connect(G.feedback).connect(G.delay);
    G.delay.connect(G.delayGain);
  }
  function makeReverb() {
    G.conv = G.ctx.createConvolver(); G.conv.buffer = reverbImpulse(G.ctx);
    G.conv.connect(G.revGain);
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = G.ctx = new AC({ latencyHint: 'playback' });
    const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const biquad = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; b.gain.value = 0; return b; };
    const comp = (th, knee, ratio, att, rel) => {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = th; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = att; c.release.value = rel;
      return c;
    };
    G.src = ctx.createMediaElementSource(audio);

    // Enhancer ("High Quality"): glue compressor -> bass / vocal / air shelves -> harmonic saturation -> limiter
    G.hqIn = gain();
    G.hqComp = comp(-12, 10, 1.5, 0.01, 0.1);
    G.hqBass = biquad('lowshelf', 80);
    G.hqVocal = biquad('peaking', 2500, 1.2);
    G.hqAir = biquad('highshelf', 9000);
    G.hqSat = ctx.createWaveShaper(); G.hqSat.oversample = '4x';
    G.hqLimit = comp(-1, 0, 20, 0.005, 0.05);
    G.hqIn.connect(G.hqComp).connect(G.hqBass).connect(G.hqVocal).connect(G.hqAir).connect(G.hqSat).connect(G.hqLimit);

    // Equalizer: 3-band tone (low shelf 200 Hz, peak 1 kHz Q 0.9, high shelf 4 kHz) + 10-band graphic (peaks, Q 1.1)
    G.eqLow = biquad('lowshelf', 200);
    G.eqMid = biquad('peaking', 1000, 0.9);
    G.eqHigh = biquad('highshelf', 4000);
    G.bands = BAND_FREQS.map((f) => biquad('peaking', f, 1.1));
    let tail = G.eqLow.connect(G.eqMid).connect(G.eqHigh);
    for (const b of G.bands) tail = tail.connect(b);
    G.eqTail = tail;

    // Effects bus: dry + distortion + echo + reverb, summed into master (volume gain)
    G.bus = gain();
    G.master = gain();
    G.dry = gain();
    G.dist = ctx.createWaveShaper(); G.dist.oversample = 'none'; G.dist.curve = distortionCurve(0);
    G.distGain = gain(0);
    G.delayGain = gain(0);
    G.revGain = gain(0);
    makeDelay();
    makeReverb();
    G.dry.connect(G.master);
    G.dist.connect(G.distGain).connect(G.master);
    G.delayGain.connect(G.master);
    G.revGain.connect(G.master);

    // Output: loudness-normalizer gain -> safety limiter -> output gain -> speakers
    G.norm = gain();
    G.limit = comp(-2, 0, 20, 0.003, 0.1);
    G.out = gain();
    G.level = ctx.createAnalyser(); G.level.fftSize = 2048; G.levelBuf = new Float32Array(2048);
    G.viz = ctx.createAnalyser(); G.viz.fftSize = 128; G.viz.smoothingTimeConstant = 0.8;
    G.master.connect(G.norm).connect(G.limit).connect(G.out).connect(ctx.destination);

    G.built = true;
    G.key = '';
    audio.addEventListener('play', resumeCtx);
    audio.addEventListener('pause', () => suspendCtxSoon());
    audio.addEventListener('ended', () => suspendCtxSoon());
    if (audio.paused) suspendCtxSoon(); else resumeCtx();
    R.log('info', `fx: audio graph built (${ctx.sampleRate} Hz, ${ctx.state})`);
  }

  function resumeCtx() {
    clearTimeout(G.suspendTimer); G.suspendTimer = null;
    if (G.ctx && G.ctx.state === 'suspended') return G.ctx.resume().catch(() => {});
    return Promise.resolve();
  }
  // An idle context still burns a render thread; park it a few seconds after playback stops.
  function suspendCtxSoon(ms = 5000) {
    clearTimeout(G.suspendTimer);
    G.suspendTimer = setTimeout(() => { if (G.ctx && G.ctx.state === 'running' && audio.paused) G.ctx.suspend().catch(() => {}); }, ms);
  }

  function route() {
    const a = S.a;
    const active = needsGraph();
    const parts = active ? [S.hqOn && 'hq', eqActive(a) && 'eq', a.distortion > 0 && 'dist', a.echo > 0 && 'echo', a.reverb > 0 && 'rev', S.norm && 'norm'].filter(Boolean) : [];
    const viz = vizUsers.size > 0;
    const key = (active ? 'fx:' + (parts.join('+') || 'gain') : 'bypass') + (viz ? '+viz' : '');
    if (key === G.key) return;
    G.key = key;
    for (const n of [G.src, G.hqLimit, G.eqTail, G.bus]) { try { n.disconnect(); } catch (e) {} }
    try { G.eqHigh.disconnect(G.level); } catch (e) {}
    try { G.out.disconnect(G.viz); } catch (e) {}
    if (viz) (active ? G.out : G.src).connect(G.viz);
    if (!active) { G.src.connect(G.ctx.destination); return; }
    let head = G.src;
    if (S.hqOn) { head.connect(G.hqIn); head = G.hqLimit; }
    // The normalizer meters right after the 3-band EQ, like riff (eqHigh -> levelAnalyser). riff only feeds
    // that point while the EQ is on; with a flat EQ the same signal is tapped at the EQ input instead.
    if (eqActive(a)) { head.connect(G.eqLow); G.eqHigh.connect(G.level); head = G.eqTail; }
    else head.connect(G.level);
    head.connect(G.bus);
    G.bus.connect(G.dry);
    if (a.distortion > 0) G.bus.connect(G.dist);
    if (a.echo > 0) G.bus.connect(G.delay);
    if (a.reverb > 0) G.bus.connect(G.conv);
  }

  // riff sets most values instantly (AudioParam.value); only the 10 bands and switching HQ off glide (tau 20 ms).
  function applyParams() {
    const p = params(), t = G.ctx.currentTime;
    const set = (param, v) => { param.cancelScheduledValues(t); param.setValueAtTime(v, t); };
    const glide = (param, v) => param.setTargetAtTime(v, t, 0.02);
    set(G.eqLow.gain, p.eq[0]); set(G.eqMid.gain, p.eq[1]); set(G.eqHigh.gain, p.eq[2]);
    G.bands.forEach((b, i) => glide(b.gain, p.bands[i]));
    set(G.revGain.gain, p.reverb);
    set(G.delayGain.gain, p.echo);
    if (S.a.distortion > 0 && G.distAmount !== S.a.distortion) { G.dist.curve = distortionCurve(S.a.distortion); G.distAmount = S.a.distortion; }
    set(G.distGain.gain, p.distGain);
    set(G.dry.gain, p.dry);
    set(G.master.gain, p.master);

    // Enhancer: the engine sets the base character, the three sliders add up to +-4 dB on top
    if (S.hqOn) {
      const c = G.hqComp;
      c.threshold.value = p.hq.threshold; c.knee.value = p.hq.knee; c.ratio.value = p.hq.ratio; c.attack.value = p.hq.attack; c.release.value = p.hq.release;
      if (G.satAmount !== p.hq.sat) { G.hqSat.curve = harmonicCurve(p.hq.sat); G.satAmount = p.hq.sat; }
      set(G.hqBass.gain, p.hq.bass); set(G.hqVocal.gain, p.hq.vocal); set(G.hqAir.gain, p.hq.air);
    } else {
      glide(G.hqBass.gain, 0); glide(G.hqVocal.gain, 0); glide(G.hqAir.gain, 0);
    }
  }

  function applyGraph() {
    if (!G.built) {
      if ((!needsGraph() && !vizUsers.size) || G.failed) { G.pending = false; return; }
      if (!mayStartContext()) { G.pending = true; return; }
      try { build(); } catch (e) { G.failed = true; R.log('error', 'fx: audio graph failed: ' + R.errText(e)); return; }
    }
    G.pending = false;
    applyParams();
    route();
    if (!audio.paused) resumeCtx();
  }

  function apply() {
    applyRate();
    applyGraph();
    persist();
    updatePill();
    normLoop();
  }
  // Saved non-default settings at startup: build on the first gesture / playback instead of at load.
  const retryPending = () => { if (G.pending) applyGraph(); };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, retryPending, { capture: true, passive: true });
  audio.addEventListener('playing', retryPending);

  // riff flushEffects(): pausing throws away the echo / reverb tails (fresh delay line, fresh random impulse).
  // riff does this in pauseSmooth only, so a track change or the natural end of a track keeps its tail.
  function flushEffects() {
    if (!G.built) return;
    try { G.delay.disconnect(); G.feedback.disconnect(); } catch (e) {}
    try { G.conv.disconnect(); } catch (e) {}
    makeDelay();
    makeReverb();
    G.key = '';
    route();
  }
  let playingTrack = null;
  audio.addEventListener('playing', () => { playingTrack = R.player.current; });
  audio.addEventListener('pause', () => {
    // core's playTrack() switches player.current before it pauses, and a natural end also fires 'pause'
    if (!G.built || audio.ended || R.player.current !== playingTrack) return;
    flushEffects();
  });

  // Volume normalizer (riff app.js): every 100 ms while playing, follow the RMS level and steer toward
  // -17 dBFS, at most +-9 dB, gain glides with tau 0.8 s. Off / new track -> back to 0 dB.
  let normTimer = null, levelAvg = -120;
  function levelDb() {
    G.level.getFloatTimeDomainData(G.levelBuf);
    let sum = 0;
    for (let i = 0; i < G.levelBuf.length; i++) sum += G.levelBuf[i] * G.levelBuf[i];
    const rms = Math.sqrt(sum / G.levelBuf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -120;
  }
  const setNormDb = (db) => { if (G.built) G.norm.gain.setTargetAtTime(Math.pow(10, db / 20), G.ctx.currentTime, 0.8); };
  function resetLevelWatcher() { levelAvg = -120; setNormDb(0); }
  function normLoop() {
    const want = S.norm && G.built && !audio.paused;
    if (want && !normTimer) {
      normTimer = setInterval(() => {
        if (!S.norm || !G.built || audio.paused) { clearInterval(normTimer); normTimer = null; return; }
        const db = levelDb();
        if (db <= -50) return;
        levelAvg = levelAvg <= -120 ? db : levelAvg + (db - levelAvg) * 0.05;
        setNormDb(Math.max(-9, Math.min(9, -17 - levelAvg)));
      }, 100);
    } else if (!want && normTimer) { clearInterval(normTimer); normTimer = null; }
  }
  audio.addEventListener('play', normLoop);
  R.on('trackchange', () => resetLevelWatcher());

  // ------------------------------------------------------------ presets

  const allPresets = () => [...PRESETS, ...S.presets];
  const copyAudio = (a) => cleanAudio(JSON.parse(JSON.stringify(a)));
  let tweenRaf = 0;

  // riff tweenSettings(): 400 ms smoothstep over every value, first frame applied right away.
  function setAudioSettings(target, smooth) {
    cancelAnimationFrame(tweenRaf); tweenRaf = 0;
    target = copyAudio(target);
    if (!smooth) { S.a = target; apply(); syncPanel(); return; }
    const from = copyAudio(S.a), t0 = performance.now();
    const mix = (x, y, e) => x + (y - x) * e;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 400), e = k * k * (3 - 2 * k);
      S.a = {
        speed: mix(from.speed, target.speed, e), speedPitch: mix(from.speedPitch, target.speedPitch, e), pitch: mix(from.pitch, target.pitch, e),
        reverb: mix(from.reverb, target.reverb, e), distortion: mix(from.distortion, target.distortion, e), volume: mix(from.volume, target.volume, e),
        echo: mix(from.echo, target.echo, e),
        eq: { low: mix(from.eq.low, target.eq.low, e), mid: mix(from.eq.mid, target.eq.mid, e), high: mix(from.eq.high, target.eq.high, e) },
        eqBands: from.eqBands.map((v, i) => mix(v, target.eqBands[i], e)),
      };
      if (k >= 1) { S.a = target; tweenRaf = 0; } else tweenRaf = requestAnimationFrame(step);
      apply(); syncPanel();
    };
    step(t0);
  }
  function applyPreset(p) {
    S.active = p.id;
    renderPresets();
    setAudioSettings(p.settings, S.smooth);
  }
  function savePreset(name) {
    name = String(name || '').trim().slice(0, 28);
    if (!name) return null;
    const p = { id: 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, settings: copyAudio(S.a) };
    S.presets.push(p);
    S.active = p.id;
    savePresets(); persist(); renderPresets();
    return p;
  }
  function renamePreset(id, name) {
    const p = S.presets.find((x) => x.id === id);
    name = String(name || '').trim().slice(0, 28);
    if (!p || !name) return false;
    p.name = name;
    savePresets(); renderPresets();
    return true;
  }
  function deletePreset(id) {
    const n = S.presets.length;
    S.presets = S.presets.filter((p) => p.id !== id);
    if (S.active === id) S.active = 'p_default';
    savePresets(); persist(); renderPresets();
    return S.presets.length < n;
  }
  function resetAll() {
    cancelAnimationFrame(tweenRaf); tweenRaf = 0;
    S.active = 'p_default';
    S.a = defAudio();
    S.hq = defHq();
    S.hqOn = false;
    apply(); syncPanel(); renderPresets();
  }
  const edited = () => { if (S.active) { S.active = null; renderPresets(); } };

  // ------------------------------------------------------------ sleep timer (riff app.js setSleepTimer)

  const sleep = { mode: null, minutes: 0, endsAt: 0, timer: null, swallow: false, fading: null };

  function restoreVolume() {
    if (!sleep.fading) return;
    cancelAnimationFrame(sleep.fading.raf);
    audio.volume = sleep.fading.v0;
    sleep.fading = null;
  }
  // riff fadeOutAndPause(): the volume slider position goes linearly to 0 over 4 s; riff's gain is the cube
  // of that position, so the element volume follows (1 - k)^3 of where it started. Then pause and restore.
  function fadeOutAndPause() {
    restoreVolume();
    const v0 = audio.volume, t0 = performance.now();
    if (!v0 || audio.muted) { audio.pause(); return; }
    const f = sleep.fading = { v0, raf: 0 };
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 4000);
      audio.volume = v0 * Math.pow(1 - k, 3);
      if (k < 1) { f.raf = requestAnimationFrame(step); return; }
      audio.pause();
      restoreVolume();
    };
    f.raf = requestAnimationFrame(step);
  }
  function setSleep(value) {
    clearInterval(sleep.timer); sleep.timer = null;
    sleep.swallow = false;
    restoreVolume();
    value = String(value);
    if (value === 'off') {
      sleep.mode = null;
    } else if (value === 'end') {
      sleep.mode = 'end';
      R.toast('Sleep timer: end of track');
    } else {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      Object.assign(sleep, { mode: 'minutes', minutes, endsAt: Date.now() + minutes * 60000 });
      R.toast(`Sleep timer: ${minutes} min`);
      sleep.timer = setInterval(() => {
        if (sleep.mode !== 'minutes') return;
        if (sleep.endsAt > Date.now()) { syncSleep(); updatePill(); return; }
        clearInterval(sleep.timer); sleep.timer = null; sleep.mode = null;
        syncSleep(); updatePill();
        fadeOutAndPause();
      }, 1000);
    }
    syncSleep(); updatePill();
  }
  function sleepLabel() {
    if (sleep.mode === 'end') return 'End of track';
    if (sleep.mode !== 'minutes') return 'Off';
    const left = Math.max(0, sleep.endsAt - Date.now());
    return `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  }
  // "End of track": riff plays the track out (no fade) and then does not advance. The core player moves on
  // by itself on 'ended', so the next track is held muted and paused as soon as it starts.
  R.on('ended', () => {
    if (sleep.mode !== 'end') return;
    sleep.mode = null;
    sleep.swallow = true;
    if (sleep.fading) cancelAnimationFrame(sleep.fading.raf);
    else sleep.fading = { v0: audio.volume, raf: 0 };
    audio.volume = 0;
    syncSleep(); updatePill();
    setTimeout(() => { if (sleep.swallow) { sleep.swallow = false; restoreVolume(); } }, 30000);
  });
  audio.addEventListener('play', () => {
    if (!sleep.swallow) return;
    sleep.swallow = false;
    audio.pause();
    setTimeout(restoreVolume, 50);
  });

  // ------------------------------------------------------------ UI

  const ico = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const I = {
    sliders: ico('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
    presets: ico('<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>'),
    enhance: ico('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
    tempo: ico('<path d="M12 15h.01"/><path d="M20.2 16.8A10 10 0 1 0 3.8 16.8"/><path d="M12 15l3.5-3.5"/>'),
    effects: ico('<path d="M2 10v4"/><path d="M6 7v10"/><path d="M10 4v16"/><path d="M14 7v10"/><path d="M18 9v6"/><path d="M22 11v2"/>'),
    sleep: ico('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    close: ico('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    edit: ico('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
    plus: ico('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    down: ico('<polyline points="6 9 12 15 18 9"/>'),
  };
  // riff's modal tabs in riff's order. riff shows presets in its rail drawer (no plug-in slot for that here),
  // so they get one extra tab after riff's five.
  const TABS = [['enhance', 'Enhancer'], ['tempo', 'Speed & Pitch'], ['effects', 'Audio FX'], ['eq', 'Equalizer'], ['sleep', 'Sleep'], ['presets', 'Presets']];
  const signed = (v, unit) => { const r = Math.round(v); return `${r > 0 ? '+' : ''}${r}${unit}`; };

  // Slider specs: key -> [label, min, max, step, default, format, get, set, isEnhancer, dblclickResets]
  // (riff index.html ranges / steps / labels; riff only resets the EQ sliders on double-click)
  const SLIDERS = {
    speed: ['Speed', 0.5, 2, 0.05, 1, (v) => `${v.toFixed(2)}x`, () => S.a.speed, (v) => { S.a.speed = v; S.a.speedPitch = 1; }],
    speedPitch: ['Speed (pitch)', 0.5, 2, 0.05, 1, (v) => `${v.toFixed(2)}x`, () => S.a.speedPitch, (v) => { S.a.speedPitch = v; S.a.speed = 1; }],
    pitch: ['Pitch', -12, 12, 1, 0, (v) => signed(v, ' st'), () => S.a.pitch, (v) => { S.a.pitch = v; }],
    gain: ['Volume gain', 0, 200, 1, 100, (v) => `${Math.round(v)}%`, () => S.a.volume * 100, (v) => { S.a.volume = v / 100; }],
    reverb: ['Reverb', 0, 100, 1, 0, (v) => `${Math.round(v)}%`, () => S.a.reverb, (v) => { S.a.reverb = v; }],
    distortion: ['Distortion', 0, 100, 1, 0, (v) => `${Math.round(v)}%`, () => S.a.distortion, (v) => { S.a.distortion = v; }],
    echo: ['Echo', 0, 100, 1, 0, (v) => `${Math.round(v)}%`, () => S.a.echo, (v) => { S.a.echo = v; }],
    vocal: ['Vocal Clarity', -50, 50, 1, 0, (v) => signed(v, '%'), () => S.hq.vocal, (v) => { S.hq.vocal = v; }, true],
    air: ['High-End Air', -50, 50, 1, 0, (v) => signed(v, '%'), () => S.hq.air, (v) => { S.hq.air = v; }, true],
    bass: ['Bass Depth', -50, 50, 1, 0, (v) => signed(v, '%'), () => S.hq.bass, (v) => { S.hq.bass = v; }, true],
    low: ['Low', -12, 12, 1, 0, (v) => signed(v, ' dB'), () => S.a.eq.low, (v) => { S.a.eq.low = v; }, false, true],
    mid: ['Mid', -12, 12, 1, 0, (v) => signed(v, ' dB'), () => S.a.eq.mid, (v) => { S.a.eq.mid = v; }, false, true],
    high: ['High', -12, 12, 1, 0, (v) => signed(v, ' dB'), () => S.a.eq.high, (v) => { S.a.eq.high = v; }, false, true],
  };
  const range = (k) => { const [, min, max, step, def, , , , , dbl] = SLIDERS[k]; return `<div class="fx-sl"><span class="fx-sl-on"></span><span class="fx-sl-off"></span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${def}"${dbl ? ' title="Double-click to reset"' : ''}></div>`; };
  const sliderItem = (k, cls = 'setting-item') => `<div class="${cls}"><div class="fx-top"><span class="fx-name">${SLIDERS[k][0]}</span><span class="fx-val" data-v="${k}"></span></div>${range(k)}</div>`;
  const eqRow = (k) => `<div class="fx-eq-row"><span class="fx-eq-name">${SLIDERS[k][0]}</span>${range(k)}<span class="fx-val" data-v="${k}"></span></div>`;
  // riff's .effect-switch-btn: thumb carries an X that morphs into a check mark when on
  const SW_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fx-sw-icon"/></svg>';
  const toggle = (id) => `<button type="button" class="fx-switch" data-t="${id}" role="switch"><span class="thumb">${SW_ICON}</span></button>`;
  const engineLabel = () => (ENGINES.find(([v]) => v === S.hq.engine) || ENGINES[0])[1];

  function panelHtml() {
    return `
    <div class="fx-head">
      <div class="fx-title">${I.sliders}<h3>Audio</h3></div>
      <button type="button" class="pill-btn" data-a="close" title="Close">${I.close}</button>
    </div>
    <div class="fx-layout">
      <nav class="fx-tabs">${TABS.map(([id, label]) => `<button type="button" class="fx-tab" data-tab="${id}">${I[id] || I.sliders}<span>${label}</span></button>`).join('')}</nav>
      <div class="fx-body">
        <div class="fx-panel" data-panel="sleep">
          <div class="setting-item">
            <div class="fx-top"><span class="fx-name">Sleep timer</span><span class="fx-val fx-sleep-status" data-sleep-status>Off</span></div>
            <div class="fx-sleep-opts">${['15', '30', '45', '60'].map((m) => `<button type="button" class="btn outline" data-sleep="${m}">${m} min</button>`).join('')}<button type="button" class="btn outline" data-sleep="end">End of track</button><button type="button" class="btn outline" data-sleep="off">Turn off</button></div>
            <span class="fx-hint">Fades out and pauses when the timer runs out.</span>
          </div>
        </div>
        <div class="fx-panel" data-panel="enhance">
          <div class="setting-item fx-hq">
            <div class="fx-top"><div class="fx-row"><span class="fx-name">High Quality</span><span class="fx-badge">BETA</span></div>${toggle('hq')}</div>
            <div class="fx-hq-wrap"><div class="fx-hq-content">
              <div class="fx-group">
                <span class="fx-label">Enhancement Engine</span>
                <div class="fx-dd">
                  <button type="button" class="fx-dd-trigger" data-a="engine"><span data-engine-label>${R.esc(engineLabel())}</span>${I.down}</button>
                  <div class="fx-dd-menu">${ENGINES.map(([v, l]) => `<button type="button" class="fx-dd-opt" data-engine="${v}">${R.esc(l)}</button>`).join('')}</div>
                </div>
              </div>
              ${['vocal', 'air', 'bass'].map((k) => sliderItem(k, 'fx-hq-slider')).join('')}
            </div></div>
          </div>
          <div class="setting-item">
            <div class="fx-top"><div class="fx-col"><span class="fx-name">Normalize volume</span><span class="fx-hint">Keeps loudness similar between tracks (adjusts live, up to 9 dB)</span></div>${toggle('norm')}</div>
          </div>
        </div>
        <div class="fx-panel" data-panel="tempo">${['speed', 'speedPitch', 'pitch', 'gain'].map((k) => sliderItem(k)).join('')}</div>
        <div class="fx-panel" data-panel="effects">${['reverb', 'distortion', 'echo'].map((k) => sliderItem(k)).join('')}</div>
        <div class="fx-panel" data-panel="eq">
          ${['low', 'mid', 'high'].map(eqRow).join('')}
          <div class="fx-eq10">
            <div class="fx-top"><span class="fx-name">10-band Equalizer</span><button type="button" class="btn outline fx-small" data-a="reset-bands">Reset</button></div>
            <div class="fx-faders">
              <div class="fx-scale"><span>+12</span><span>0</span><span>-12</span></div>
              <div class="fx-fader-area">
                <div class="fx-grid"><i class="max"></i><i class="mid"></i><i class="min"></i></div>
                <div class="fx-bands">${BAND_LABELS.map((l, i) => `<div class="fx-band"><span class="fx-band-val" data-bv="${i}"></span><div class="fx-band-box"><input type="range" class="fx-band-range" data-band="${i}" min="-12" max="12" step="1" value="0" title="Double-click to reset"></div><span class="fx-band-freq">${l}</span></div>`).join('')}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="fx-panel" data-panel="presets">
          <div class="setting-item">
            <div class="fx-top"><span class="fx-name">Audio presets</span><button type="button" class="btn outline fx-small" data-a="save">${I.plus}Save preset</button></div>
            <div class="fx-chips" data-presets></div>
          </div>
        </div>
      </div>
    </div>
    <div class="fx-foot"><button type="button" class="btn outline" data-a="reset">Reset audio settings</button></div>`;
  }

  let panel = null;
  const live = () => !!(panel && panel.isConnected);
  let curTab = 'tempo';

  function setTab(id) {
    if (!TABS.some(([t]) => t === id)) id = 'tempo';
    curTab = id;
    if (!live()) return;
    panel.querySelectorAll('.fx-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    panel.querySelectorAll('.fx-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === id));
  }

  const switchOn = (t) => (t === 'hq' ? S.hqOn : t === 'norm' ? S.norm : t === 'smooth' ? S.smooth : S.persist);
  const syncSwitch = (b) => { const on = switchOn(b.dataset.t); b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); };

  function syncPanel() {
    if (!live()) return;
    panel.querySelectorAll('input[data-k]').forEach((inp) => {
      const [, min, max, , , , get] = SLIDERS[inp.dataset.k];
      const v = get();
      inp.value = v;
      inp.parentElement.style.setProperty('--v', String((v - min) / (max - min)));
    });
    panel.querySelectorAll('[data-v]').forEach((e) => { const s = SLIDERS[e.dataset.v]; e.textContent = s[5](s[6]()); });
    panel.querySelectorAll('input[data-band]').forEach((inp) => { inp.value = S.a.eqBands[inp.dataset.band]; });
    panel.querySelectorAll('[data-bv]').forEach((e) => { e.textContent = signed(S.a.eqBands[e.dataset.bv], ' dB'); });
    panel.querySelector('.fx-hq').classList.toggle('open', S.hqOn);
    panel.querySelectorAll('.fx-switch').forEach(syncSwitch);
    panel.querySelector('[data-engine-label]').textContent = engineLabel();
    panel.querySelectorAll('[data-engine]').forEach((b) => b.classList.toggle('selected', b.dataset.engine === S.hq.engine));
    syncSleep();
  }
  function syncSleep() {
    if (!live()) return;
    const st = panel.querySelector('[data-sleep-status]');
    st.textContent = sleepLabel();
    st.classList.toggle('active', !!sleep.mode);
    const cur = sleep.mode === 'end' ? 'end' : sleep.mode === 'minutes' ? String(sleep.minutes) : null;
    panel.querySelectorAll('[data-sleep]').forEach((b) => b.classList.toggle('active', b.dataset.sleep === cur));
  }
  function renderPresets() {
    if (!live()) return;
    panel.querySelector('[data-presets]').innerHTML = allPresets().map((p) => {
      const custom = p.id.startsWith('custom_');
      return `<div class="fx-chip fx-preset${S.active === p.id ? ' active' : ''}" data-preset="${R.esc(p.id)}" role="button" tabindex="0"><span>${R.esc(p.name)}</span>${custom
        ? `<button type="button" class="fx-chip-act" data-rename="${R.esc(p.id)}" title="Rename">${I.edit}</button><button type="button" class="fx-chip-act" data-delete="${R.esc(p.id)}" title="Delete">${I.close}</button>`
        : ''}</div>`;
    }).join('');
  }

  // askText / confirmBox share the core modal, so the panel is reopened on the same tab afterwards.
  async function askAndReopen(fn) {
    const tab = curTab;
    try { await fn(); } finally { open(tab); }
  }

  function toggleSwitch(t) {
    if (t === 'hq') S.hqOn = !S.hqOn;
    else if (t === 'norm') { S.norm = !S.norm; R.store('fx.norm', S.norm); if (!S.norm) resetLevelWatcher(); }
    else if (t === 'smooth') { S.smooth = !S.smooth; R.store('fx.smooth', S.smooth); }
    else if (t === 'persist') { S.persist = !S.persist; R.store('fx.persist', S.persist); }
    apply();
  }

  function wire() {
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.k) {
        const s = SLIDERS[t.dataset.k];
        cancelAnimationFrame(tweenRaf); tweenRaf = 0;
        s[7](Number(t.value));
        if (!s[8]) edited();
      } else if (t.dataset.band != null) {
        S.a.eqBands[t.dataset.band] = Number(t.value);
        edited();
      } else return;
      apply(); syncPanel();
    });
    panel.addEventListener('dblclick', (e) => {
      const t = e.target;
      if (t.dataset.k && SLIDERS[t.dataset.k][9]) { const s = SLIDERS[t.dataset.k]; s[7](s[4]); edited(); }
      else if (t.dataset.band != null) { S.a.eqBands[t.dataset.band] = 0; edited(); }
      else return;
      apply(); syncPanel();
    });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button, [data-preset]');
      const dd = panel.querySelector('.fx-dd');
      if (!b || b.dataset.a !== 'engine') dd.classList.remove('open');
      if (!b) return;
      const d = b.dataset;
      if (d.tab) return setTab(d.tab);
      if (d.sleep) return setSleep(d.sleep);
      if (d.engine) { S.hq.engine = d.engine; apply(); syncPanel(); return; }
      if (d.t) { toggleSwitch(d.t); syncPanel(); return; }
      if (d.rename) {
        const p = S.presets.find((x) => x.id === d.rename);
        if (p) askAndReopen(async () => { const n = await R.askText('Rename preset', 'New preset name...', p.name); if (n != null) renamePreset(p.id, n); });
        return;
      }
      if (d.delete) {
        const p = S.presets.find((x) => x.id === d.delete);
        if (p) askAndReopen(async () => { if (await R.confirmBox('Delete preset', `Delete preset "${p.name}"?`, 'Delete')) deletePreset(p.id); });
        return;
      }
      if (d.preset) { const p = allPresets().find((x) => x.id === d.preset); if (p) applyPreset(p); return; }
      switch (d.a) {
        case 'close': R.closeModal(); break;
        case 'engine': dd.classList.toggle('open'); break;
        case 'reset': resetAll(); break;
        case 'reset-bands': S.a.eqBands = BAND_FREQS.map(() => 0); edited(); apply(); syncPanel(); break;
        case 'save': askAndReopen(async () => {
          const n = await R.askText('Save preset', 'Preset name...', '');
          const p = n && savePreset(n);
          if (p) R.toast(`Saved preset "${p.name}"`);
        }); break;
      }
    });
    panel.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.preset) { e.preventDefault(); e.target.click(); }
    });
  }

  // riff opens the audio menu on Speed & Pitch every time (other tabs only when asked for by name).
  function open(tab) {
    panel = R.openModal(panelHtml());
    panel.classList.add('fx-modal');
    wire();
    renderPresets();
    setTab(tab || 'tempo');
    syncPanel();
  }

  // Player-bar pill (riff's sliders icon); the dot shows while the audio settings differ from default.
  const pill = document.createElement('button');
  pill.className = 'pill-btn fx-pill';
  pill.title = 'Audio';
  pill.innerHTML = `${I.sliders}<span class="fx-dot"></span>`;
  pill.addEventListener('click', () => open());
  R.addPlaybarButton(pill, 'right');
  function updatePill() {
    const mod = isModified();
    pill.classList.toggle('modified', mod);
    pill.title = 'Audio' + (mod ? ' · effects on' : '') + (sleep.mode ? ` · sleep ${sleepLabel()}` : '');
  }

  // riff keeps "Smooth preset transitions" and "Save sound settings" in the Tracks tab of its Settings page.
  // Rendered as the first rows of that tab; playbar.js appends progress bar + crossfade rows to the same group.
  R.addSettings(() => {
    const row = (t, name, desc, on) => {
      const el = document.createElement('div');
      el.className = 'th-item setting-item';
      el.innerHTML = `<div class="th-top"><div class="th-col"><span class="th-name">${name}</span>${desc ? `<span class="th-desc">${desc}</span>` : ''}</div></div>`;
      el.firstChild.append(R.switch(on, () => toggleSwitch(t), { label: name }));
      return el;
    };
    const g = R.add('<div class="th-group" data-group="tracks-playback"></div>');
    g.append(row('smooth', 'Smooth preset transitions', '', S.smooth),
      row('persist', 'Save sound settings', 'Automatically save High Quality, effects and the active preset', S.persist));
  }, 'tracks');

  // Startup: re-apply saved settings (rate right away, the graph on first gesture / playback).
  apply();
  clearTimeout(saveTimer);

  /** The visualizer AnalyserNode (fftSize 128, smoothing 0.8), or null until the graph exists (it needs a
   *  user gesture or playback first). Calling it registers `key` as a user, which keeps the tap connected;
   *  releaseAnalyser(key) drops it. */
  R.getAnalyser = (key = 'api') => {
    if (!vizUsers.has(key)) { vizUsers.add(key); applyGraph(); }
    return G.built && G.viz ? G.viz : null;
  };
  R.releaseAnalyser = (key = 'api') => { if (vizUsers.delete(key) && G.built) route(); };
  R.analyserHolders = () => [...vizUsers];

  R.fx = {
    open, apply, isModified, setSleep, savePreset, renamePreset, deletePreset, resetAll, flushEffects, params,
    get settings() { return S; },
    get context() { return G.ctx; },
    get output() { return G.out || null; },
    get routing() { return G.key || 'none'; },
  };

  // ------------------------------------------------------------ selftest

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ok = (c) => (c ? 'OK' : 'FAILED');
    const near = (x, y) => Math.abs(x - y) < 1e-6;
    const fxKey = () => (G.key || '').replace(/\+viz$/, ''); // the visualizer tap rides on top of any routing
    const keys = ['fx.audio', 'fx.hq', 'fx.hqOn', 'fx.norm', 'fx.presets', 'fx.active', 'fx.smooth', 'fx.persist', 'fx.tab'];
    const saved = {};
    for (const k of keys) saved[k] = localStorage.getItem(k);
    const wasMuted = audio.muted;
    try {
      log(`fx crossOrigin ${ok(audio.crossOrigin === 'anonymous')}: ${audio.crossOrigin || 'none'}`);

      // 1. CORS on the real stream hosts (progressive files, HLS playlists + their first segment).
      //    A cors-mode fetch only resolves when Access-Control-Allow-Origin admits this origin.
      const pool = [...(R.state.search?.results || []), ...(R.state.trending || [])].filter((t) => t && !t.source).slice(0, 4);
      const corsCheck = async (url) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        try {
          const res = await fetch(url, { mode: 'cors', signal: ctl.signal, cache: 'no-store' });
          const text = /mpegurl/i.test(res.headers.get('content-type') || '') || /\.m3u8/.test(url) ? await res.text() : null;
          return { ok: res.ok, status: res.status, text };
        } catch (e) { return { ok: false, status: 'blocked (' + R.errText(e) + ')' }; }
        finally { clearTimeout(timer); ctl.abort(); }
      };
      if (!pool.length) log('fx cors: skipped (no SoundCloud tracks loaded)');
      for (const t of pool) {
        let s;
        try { s = await R.invoke('stream_url', { id: t.id }); } catch (e) { log(`fx cors: stream_url ${t.id} failed: ${R.errText(e)}`); continue; }
        const r = await corsCheck(s.url);
        log(`fx cors ${ok(r.ok)}: ${s.protocol} ${s.preset || ''} ${new URL(s.url).host} -> ${r.status}`);
        const seg = r.text && r.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (seg) {
          const segUrl = new URL(seg, s.url).href;
          const r2 = await corsCheck(segUrl);
          log(`fx cors ${ok(r2.ok)}: hls segment ${new URL(segUrl).host} -> ${r2.status}`);
        }
      }

      // 2. riff's numbers: built-in presets, slider mapping, enhancer engines, curves
      const RIFF_PRESETS = {
        p_default: [1, 1, 0, 0, 0, 1, 0], p_speedup: [1.35, 1, 0, 0, 0, 1, 0], p_speedup_pitch: [1, 1.3, 0, 0, 0, 1, 0],
        p_slowed: [1, 0.82, 0, 65, 0, 1, 15], p_nightcore: [1, 1.25, 0, 20, 0, 1, 0], p_distortion: [1, 1, 0, 0, 75, 1.25, 0],
      }; // speed, speedPitch, pitch, reverb, distortion, volume, echo
      const presetsOk = PRESETS.length === 6 && PRESETS.every((p) => {
        const w = RIFF_PRESETS[p.id], s = p.settings;
        return w && [s.speed, s.speedPitch, s.pitch, s.reverb, s.distortion, s.volume, s.echo].every((v, i) => near(v, w[i])) && !eqActive(s);
      });
      log(`fx riff presets ${ok(presetsOk)}: ${PRESETS.map((p) => p.name).join(' / ')}`);
      const pd = params({ ...defAudio(), distortion: 50, reverb: 40, echo: 25, volume: 1.5, eq: { low: 20, mid: -3, high: 0 } }, defHq(), false);
      log(`fx riff fx mapping ${ok(near(pd.distGain, 0.375) && near(pd.dry, 0.8) && near(pd.reverb, 0.4) && near(pd.echo, 0.25) && pd.master === 1.5 && pd.eq[0] === 12 && pd.eq[1] === -3)}: dist=${pd.distGain} dry=${pd.dry} rev=${pd.reverb} echo=${pd.echo} eqLow=${pd.eq[0]}`);
      const hq1 = params(defAudio(), { ...defHq(), engine: 'fyro1.1', bass: 25, vocal: -50, air: 30 }, true).hq;
      const hq2 = params(defAudio(), { ...defHq(), engine: 'glyphs-7B', air: 50 }, true).hq;
      const hq3 = params(defAudio(), { ...defHq(), engine: 'hqmusic-3', vocal: 15 }, true).hq;
      log(`fx riff enhancer ${ok(hq1.ratio === 2 && hq1.bass === 4 && near(hq1.vocal, -4) && near(hq1.air, 2.4) && hq1.sat === 0.2 && hq2.air === 4 && hq2.sat === 0.2 && hq2.ratio === 1.5 && hq3.sat === 0.5 && near(hq3.vocal, 1.2))}: fyro bass=${hq1.bass} ratio=${hq1.ratio} glyphs air=${hq2.air} hqmusic sat=${hq3.sat}`);
      const dc = distortionCurve(75), hc = harmonicCurve(0.5);
      log(`fx riff curves ${ok(dc.length === 256 && near(dc[0], ((3 + 187.5) * -1 * 20 * Math.PI / 180) / (Math.PI + 187.5)) && hc.length === 256 && near(hc[0], -1 + 0.01) && distortionCurve(0)[200] === (400 / 256 - 1))}: dist[0]=${dc[0].toFixed(4)} harm[0]=${hc[0].toFixed(4)}`);
      const rr = rateFor({ ...defAudio(), speed: 1.4, pitch: -3 });
      log(`fx riff rate ${ok(rr.tape && near(rr.rate, Math.pow(2, -3 / 12)) && !rateFor({ ...defAudio(), speed: 1.4 }).tape)}: pitch overrides speed -> ${rr.rate.toFixed(4)}`);

      // 3. Graph: turn effects on and play through it with the output gain at 0. CORS-tainted media
      //    reads as pure zeros inside Web Audio, so a real level proves the effects are audible.
      G.forceAllow = true;
      S.a = { ...defAudio(), reverb: 20, echo: 10, eq: { low: 3, mid: 0, high: 0 } };
      S.hqOn = true; S.norm = false;
      apply();
      log(`fx graph ${ok(G.built && fxKey() === 'fx:hq+eq+echo+rev')}: routing=${G.key} ctx=${G.ctx && G.ctx.state}`);
      if (G.built) {
        const bandsOk = G.bands.length === 10 && G.bands.every((b, i) => b.type === 'peaking' && b.frequency.value === BAND_FREQS[i] && near(b.Q.value, 1.1));
        const toneOk = G.eqLow.type === 'lowshelf' && G.eqLow.frequency.value === 200 && G.eqMid.type === 'peaking' && G.eqMid.frequency.value === 1000 && near(G.eqMid.Q.value, 0.9) && G.eqHigh.type === 'highshelf' && G.eqHigh.frequency.value === 4000;
        log(`fx riff eq ${ok(bandsOk && toneOk)}: bands=${G.bands.map((b) => b.frequency.value).join(',')} Q=${G.bands[0].Q.value.toFixed(2)} tone=200/1000(Q0.9)/4000`);
        const hqOk = G.hqBass.frequency.value === 80 && G.hqVocal.frequency.value === 2500 && near(G.hqVocal.Q.value, 1.2) && G.hqAir.frequency.value === 9000 && G.hqSat.oversample === '4x'
          && G.hqLimit.threshold.value === -1 && G.hqLimit.ratio.value === 20 && G.limit.threshold.value === -2 && near(G.limit.attack.value, 0.003);
        log(`fx riff enhancer nodes ${ok(hqOk)}: bass 80 / vocal 2500 Q1.2 / air 9000, limiter -1 dB, output limiter -2 dB`);
        const irOk = G.conv.buffer.length === Math.floor(G.ctx.sampleRate * 0.6) && G.conv.buffer.numberOfChannels === 2;
        log(`fx riff reverb/echo ${ok(irOk && near(G.delay.delayTime.value, 0.3) && near(G.feedback.gain.value, 0.35))}: ir=${G.conv.buffer.length} frames, delay=${G.delay.delayTime.value.toFixed(2)} s fb=${G.feedback.gain.value.toFixed(2)}`);
        const oldDelay = G.delay;
        flushEffects();
        log(`fx flush ${ok(G.delay !== oldDelay && near(G.delay.delayTime.value, 0.3) && near(G.feedback.gain.value, 0.35) && fxKey() === 'fx:hq+eq+echo+rev')}: routing=${G.key}`);
      }
      if (G.built && R.player.current) {
        G.out.gain.cancelScheduledValues(0); G.out.gain.value = 0;
        await wait(200);
        audio.muted = false;
        await resumeCtx();
        if (audio.paused) await audio.play().catch(() => {});
        let best = -120;
        for (let i = 0; i < 30; i++) { await wait(100); if (!audio.paused) best = Math.max(best, levelDb()); }
        audio.muted = true;
        audio.pause();
        await wait(100);
        G.out.gain.value = 1;
        log(`fx signal ${ok(best > -70)}: peak ${best.toFixed(1)} dBFS through the graph (ctx ${G.ctx.state}, t=${audio.currentTime.toFixed(1)}s)`);
      } else log('fx signal: skipped (no current track or no graph)');

      // 4. speed & pitch
      S.a = { ...defAudio(), speedPitch: 1.25, pitch: 2 };
      apply();
      const want = 1.25 * Math.pow(2, 2 / 12);
      log(`fx tape pitch ${ok(Math.abs(audio.playbackRate - want) < 0.01 && audio.preservesPitch === false)}: rate=${audio.playbackRate.toFixed(3)}`);
      S.a = { ...defAudio(), speed: 1.5 };
      apply();
      log(`fx speed ${ok(audio.playbackRate === 1.5 && audio.preservesPitch === true)}: rate=${audio.playbackRate}`);

      // 5. everything default -> element wired straight to the speakers
      resetAll();
      log(`fx bypass ${ok((!G.built || fxKey() === 'bypass') && audio.playbackRate === 1 && !isModified())}: routing=${G.key || 'none'} rate=${audio.playbackRate}`);

      // 6. presets: save / rename / apply built-in / delete
      const n0 = S.presets.length;
      const p = savePreset('selftest preset');
      const renamed = !!p && renamePreset(p.id, 'selftest renamed') && S.presets.find((x) => x.id === p.id).name === 'selftest renamed';
      S.smooth = false;
      applyPreset(PRESETS.find((x) => x.id === 'p_slowed'));
      const applied = S.a.speedPitch === 0.82 && S.a.reverb === 65 && S.a.echo === 15 && S.active === 'p_slowed';
      const deleted = !!p && deletePreset(p.id) && S.presets.length === n0;
      log(`fx presets ${ok(p && renamed && applied && deleted)}: save=${!!p} rename=${renamed} apply=${applied} delete=${deleted}`);
      resetAll();

      // 7. sleep timer (never allowed to fire here)
      setSleep('end'); const endLbl = sleepLabel();
      setSleep(15); const minLbl = sleepLabel();
      setSleep('off');
      log(`fx sleep ${ok(endLbl === 'End of track' && /^1[45]:\d\d$/.test(minLbl) && sleepLabel() === 'Off')}: "${endLbl}" / "${minLbl}"`);

      // 8. panel: riff's tab order, slider ranges, 10 faders, opens on Speed & Pitch
      open();
      const order = [...panel.querySelectorAll('.fx-tab')].map((b) => b.dataset.tab).join(',');
      const bands = panel.querySelectorAll('.fx-band-range').length;
      const activePanel = panel.querySelector('.fx-panel.active')?.dataset.panel;
      const rng = (k) => { const i = panel.querySelector(`input[data-k="${k}"]`); return `${i.min}/${i.max}/${i.step}`; };
      const rangesOk = rng('speed') === '0.5/2/0.05' && rng('speedPitch') === '0.5/2/0.05' && rng('pitch') === '-12/12/1' && rng('gain') === '0/200/1'
        && rng('reverb') === '0/100/1' && rng('vocal') === '-50/50/1' && rng('low') === '-12/12/1';
      R.closeModal();
      log(`fx panel ${ok(order === 'enhance,tempo,effects,eq,sleep,presets' && bands === 10 && activePanel === 'tempo' && rangesOk)}: tabs=${order} bands=${bands} active=${activePanel} ranges=${rangesOk}`);
    } catch (e) {
      log('fx selftest error: ' + R.errText(e));
    } finally {
      G.forceAllow = false;
      if (G.out) G.out.gain.value = 1;
      audio.muted = wasMuted;
      clearTimeout(saveTimer);
      for (const k of keys) { if (saved[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, saved[k]); }
      loadState();
      apply();
      clearTimeout(saveTimer);
      log(`fx selftest done (routing=${G.key || 'none'})`);
    }
  });
})();
