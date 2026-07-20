(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const screens = {
    safety: $('safety-screen'), main: $('main-screen'), session: $('session-screen'),
    preparation: $('preparation-view'), active: $('active-view')
  };
  const phaseViews = ['breathing', 'retention', 'recovery', 'transition', 'complete'];
  const STORAGE_HISTORY = 'souffle-history-v1';
  const STORAGE_SAFETY = 'souffle-safety-v1';
  // Cadence mesurée sur la vidéo : environ 3,8 s par respiration complète.
  const BREATH_SECONDS = 3.8;
  const INHALE_SECONDS = 1.8;

  const state = {
    rounds: 3, control: 'both', phase: 'idle', round: 1, breath: 1,
    startedAt: 0, raf: 0, lastBreath: -1, lastInhaling: null,
    lastAnnouncement: 0, retentions: [], saved: false,
    wakeLock: null, audio: null, analyser: null, audioStream: null,
    noiseFloor: 0.008, calibrating: false, calibration: [],
    listening: false, speechBlockedUntil: 0, aboveSince: 0, lastTrigger: 0,
    microphoneStatus: 'off', leadInTimer: 0, leadInInterval: 0
  };
  const cueAudio = {
    inhale: new Audio('./inspiration.wav?v=6'),
    exhale: new Audio('./expiration.wav?v=6'),
    time: new Audio('./temps-30-secondes.wav?v=6')
  };
  Object.values(cueAudio).forEach(audio => { audio.preload = 'auto'; audio.volume = 0.46; });

  function show(element, visible = true) { element.classList.toggle('hidden', !visible); }
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function spokenTime(seconds) {
    if (seconds < 60) return `${seconds} secondes`;
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    const base = minutes === 1 ? 'une minute' : `${minutes} minutes`;
    return rest ? `${base} et ${rest} secondes` : base;
  }

  function playCue(kind) {
    const audio = cueAudio[kind];
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (_) {}
  }

  function unlockCues() {
    Object.values(cueAudio).forEach(audio => {
      const volume = audio.volume;
      audio.volume = 0;
      audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = volume;
      }).catch(() => { audio.volume = volume; });
    });
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  async function releaseWakeLock() {
    try { await state.wakeLock?.release(); } catch (_) {}
    state.wakeLock = null;
  }

  function modeUsesMicrophone() { return state.control === 'sound' || state.control === 'both'; }
  function modeUsesTap() { return state.control === 'tap' || state.control === 'both'; }
  function microphoneFallback() { return state.microphoneStatus === 'denied' || state.microphoneStatus === 'unavailable'; }

  async function prepareMicrophone() {
    if (!modeUsesMicrophone()) return;
    state.microphoneStatus = 'preparing';
    updateMicroStatus('Demande d’autorisation du microphone…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
      state.audioStream = stream;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      state.audio = new AudioContext();
      await state.audio.resume();
      const source = state.audio.createMediaStreamSource(stream);
      state.analyser = state.audio.createAnalyser();
      state.analyser.fftSize = 1024;
      state.analyser.smoothingTimeConstant = 0.18;
      source.connect(state.analyser);
      state.microphoneStatus = 'calibrating';
      state.calibrating = true;
      state.calibration = [];
      updateMicroStatus('Écoute du silence de la pièce pendant 2 secondes…');
      monitorAudio();
      setTimeout(() => {
        if (state.calibration.length) {
          const values = [...state.calibration].sort((a, b) => a - b);
          state.noiseFloor = Math.max(0.004, values[Math.floor((values.length - 1) * .85)]);
        }
        state.calibrating = false;
        state.microphoneStatus = 'ready';
        updateMicroStatus('Détection de l’inspiration prête');
      }, 2000);
    } catch (error) {
      state.microphoneStatus = error?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
      updateMicroStatus('Microphone indisponible — le toucher sera utilisé');
    }
  }

  function monitorAudio() {
    if (!state.analyser) return;
    const data = new Float32Array(state.analyser.fftSize);
    const read = () => {
      if (!state.analyser) return;
      state.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const sample of data) sum += sample * sample;
      const rms = Math.sqrt(sum / data.length);
      if (state.calibrating) state.calibration.push(rms);
      detectInhale(rms);
      requestAnimationFrame(read);
    };
    read();
  }

  function detectInhale(level) {
    const now = performance.now();
    if (!state.listening || now <= state.speechBlockedUntil) return;
    const threshold = Math.max(state.noiseFloor * 3.2, 0.018);
    if (level > threshold) {
      if (!state.aboveSince) state.aboveSince = now;
      if (now - state.aboveSince > 160 && now - state.lastTrigger > 2000) {
        state.lastTrigger = now;
        state.aboveSince = 0;
        finishRetention('sound');
      }
    } else state.aboveSince = 0;
  }

  function updateMicroStatus(text) {
    $('micro-status').textContent = `◉ ${text}`;
    show($('micro-status'), true);
  }
  function stopMicrophone() {
    state.listening = false;
    state.analyser = null;
    state.audioStream?.getTracks().forEach(track => track.stop());
    state.audioStream = null;
    state.audio?.close().catch(() => {});
    state.audio = null;
  }

  function showPhase(name) {
    phaseViews.forEach(phase => show($(`${phase}-view`), phase === name));
    state.phase = name;
  }
  function beginBreathing() {
    showPhase('breathing');
    state.startedAt = performance.now();
    state.lastBreath = -1;
    state.lastInhaling = null;
    state.listening = false;
    $('round-label').textContent = `Cycle ${state.round} sur ${state.rounds}`;
    $('session-hint').textContent = 'L’écran reste éveillé pendant la séance';
  }
  function beginRetention() {
    showPhase('retention');
    state.startedAt = performance.now();
    state.lastAnnouncement = 0;
    state.listening = modeUsesMicrophone() && state.microphoneStatus === 'ready';
    $('retention-time').textContent = '0:00';
    if (microphoneFallback()) $('session-hint').textContent = 'Microphone indisponible — touche l’écran lorsque tu inspires';
    else if (state.control === 'tap') $('session-hint').textContent = 'Touche l’écran lorsque tu inspires';
    else if (state.control === 'sound') $('session-hint').textContent = 'L’application écoute ta reprise d’inspiration';
    else $('session-hint').textContent = 'Inspire naturellement ou touche l’écran';
  }
  function finishRetention(source) {
    if (state.phase !== 'retention') return;
    if (source === 'tap' && !modeUsesTap() && !microphoneFallback()) return;
    const duration = (performance.now() - state.startedAt) / 1000;
    state.retentions.push(duration);
    state.listening = false;
    showPhase('recovery');
    state.startedAt = performance.now();
    $('recovery-time').textContent = '15';
    playCue('inhale');
  }
  function finishRecovery() {
    playCue('exhale');
    if (state.round >= state.rounds) completeSession();
    else {
      showPhase('transition');
      state.startedAt = performance.now();
      $('session-hint').textContent = 'L’écran reste éveillé pendant la séance';
    }
  }
  function completeSession() {
    showPhase('complete');
    state.listening = false;
    cancelAnimationFrame(state.raf);
    $('round-label').textContent = '';
    $('session-hint').textContent = '';
    $('session-results').innerHTML = state.retentions.map((value, index) => `<div class="result-row"><span>Cycle ${index + 1}</span><strong>${formatTime(value)}</strong></div>`).join('');
    if (!state.saved) { saveSession(); state.saved = true; }
    playCue('time');
    releaseWakeLock();
  }

  function announceBreath(index, inhaling) {
    if (index !== state.lastBreath) {
      state.lastBreath = index;
      const number = index + 1;
      playCue('inhale');
      if (number === 21) $('session-hint').textContent = 'Dix respirations encore';
      else if (number === 26) $('session-hint').textContent = 'Cinq encore — sans forcer';
      else if (number === 30) $('session-hint').textContent = 'La dernière respiration';
      else if (number === 6) $('session-hint').textContent = 'Du ventre vers la poitrine';
      else if (number === 13) $('session-hint').textContent = 'Laisse repartir l’air, sans pousser';
      else if (number === 18) $('session-hint').textContent = 'Un mouvement continu, comme une vague';
    }
    if (inhaling !== state.lastInhaling) {
      state.lastInhaling = inhaling;
      if (!inhaling) playCue('exhale');
    }
  }

  function tick(now) {
    const elapsed = (now - state.startedAt) / 1000;
    if (state.phase === 'breathing') {
      const index = Math.floor(elapsed / BREATH_SECONDS);
      if (index >= 30) beginRetention();
      else {
        const within = elapsed % BREATH_SECONDS;
        const inhaling = within < INHALE_SECONDS;
        const exhaleSeconds = BREATH_SECONDS - INHALE_SECONDS;
        const progress = inhaling ? within / INHALE_SECONDS : (within - INHALE_SECONDS) / exhaleSeconds;
        $('breath-number').textContent = index + 1;
        $('breath-label').textContent = inhaling ? 'INSPIRE' : 'RELÂCHE';
        $('breath-circle').style.transform = `scale(${inhaling ? .72 + .28 * progress : 1 - .28 * progress})`;
        announceBreath(index, inhaling);
      }
    } else if (state.phase === 'retention') {
      $('retention-time').textContent = formatTime(elapsed);
      const interval = Math.floor(elapsed / 30);
      if (interval > 0 && interval > state.lastAnnouncement) {
        state.lastAnnouncement = interval;
        playCue('time');
      }
    } else if (state.phase === 'recovery') {
      const remaining = Math.max(0, 15 - elapsed);
      $('recovery-time').textContent = Math.ceil(remaining);
      $('recovery-progress').style.strokeDashoffset = 616 * (1 - Math.min(1, elapsed / 15));
      if (elapsed >= 15) finishRecovery();
    } else if (state.phase === 'transition' && elapsed >= 3) {
      state.round += 1;
      beginBreathing();
    }
    if (!['idle', 'complete'].includes(state.phase)) state.raf = requestAnimationFrame(tick);
  }

  function startSession() {
    unlockCues();
    state.round = 1; state.retentions = []; state.saved = false;
    show(screens.preparation, false); show(screens.active, true);
    showPhase('breathing');
    state.phase = 'leadIn';
    $('round-label').textContent = `Cycle 1 sur ${state.rounds}`;
    $('breath-label').textContent = 'PRÉPARE-TOI';
    $('breath-number').textContent = '•';
    $('breath-circle').style.transform = 'scale(.72)';
    $('session-hint').textContent = 'La respiration commence après la préparation';
    requestWakeLock();
    cancelAnimationFrame(state.raf);
    clearTimeout(state.leadInTimer);
    clearInterval(state.leadInInterval);
    let countdown = 4;
    $('breath-number').textContent = countdown;
    state.leadInInterval = setInterval(() => {
      countdown -= 1;
      if (countdown > 0) $('breath-number').textContent = countdown;
    }, 1000);
    state.leadInTimer = setTimeout(() => {
      clearInterval(state.leadInInterval);
      beginBreathing();
      state.raf = requestAnimationFrame(tick);
    }, 4000);
  }
  function openPreparation() {
    state.rounds = Number($('rounds-value').value || $('rounds-value').textContent);
    state.control = $('control-mode').value;
    show(screens.main, false); show(screens.session, true);
    show(screens.preparation, true); show(screens.active, false);
    state.phase = 'idle';
    show($('micro-status'), modeUsesMicrophone());
    if (modeUsesMicrophone()) prepareMicrophone();
  }
  function exitSession() {
    cancelAnimationFrame(state.raf);
    clearTimeout(state.leadInTimer);
    clearInterval(state.leadInInterval);
    stopMicrophone();
    releaseWakeLock();
    state.phase = 'idle';
    show(screens.session, false); show(screens.main, true);
    $('exit-dialog').close();
    renderHistory();
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_HISTORY)) || []; } catch (_) { return []; }
  }
  function saveSession() {
    const history = getHistory();
    history.unshift({ id: crypto.randomUUID?.() || String(Date.now()), date: new Date().toISOString(), retentions: state.retentions });
    localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
  }
  function renderHistory() {
    const history = getHistory();
    show($('history-empty'), !history.length); show($('history-content'), !!history.length);
    if (!history.length) return;
    $('history-list').innerHTML = history.map(item => {
      const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.date));
      return `<article class="history-row"><div class="history-head"><strong>${date}</strong><small>${item.retentions.length} cycle${item.retentions.length > 1 ? 's' : ''}</small></div><div>${item.retentions.map(value => `<span class="duration-chip">${formatTime(value)}</span>`).join('')}</div></article>`;
    }).join('');
    drawChart(history.slice(0, 12).reverse());
  }
  function drawChart(items) {
    const svg = $('history-chart');
    const values = items.map(item => item.retentions.reduce((a, b) => a + b, 0) / item.retentions.length);
    const max = Math.max(60, ...values) * 1.12, min = 0, width = 600, height = 240, pad = 34;
    const x = index => items.length === 1 ? width / 2 : pad + index * (width - 2 * pad) / (items.length - 1);
    const y = value => height - pad - (value - min) / (max - min) * (height - 2 * pad);
    const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
    const grid = [0, .5, 1].map(f => `<line x1="${pad}" y1="${y(max * f)}" x2="${width - pad}" y2="${y(max * f)}" stroke="rgba(255,255,255,.09)"/><text x="2" y="${y(max * f) + 4}" fill="#94a5a9" font-size="12">${formatTime(max * f)}</text>`).join('');
    svg.innerHTML = `${grid}<polyline points="${points}" fill="none" stroke="#58d7df" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${values.map((value, index) => `<circle cx="${x(index)}" cy="${y(value)}" r="5" fill="#05090b" stroke="#58d7df" stroke-width="3"><title>${formatTime(value)}</title></circle>`).join('')}`;
  }

  function changeTab(pageId) {
    document.querySelectorAll('.tab-page').forEach(page => show(page, page.id === pageId));
    document.querySelectorAll('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === pageId));
    if (pageId === 'history-page') renderHistory();
    scrollTo(0, 0);
  }

  $('accept-safety').addEventListener('click', () => { localStorage.setItem(STORAGE_SAFETY, 'yes'); show(screens.safety, false); show(screens.main, true); });
  $('rounds-minus').addEventListener('click', () => { state.rounds = Math.max(1, state.rounds - 1); $('rounds-value').textContent = state.rounds; });
  $('rounds-plus').addEventListener('click', () => { state.rounds = Math.min(10, state.rounds + 1); $('rounds-value').textContent = state.rounds; });
  $('control-mode').addEventListener('change', event => { state.control = event.target.value; show($('privacy-note'), modeUsesMicrophone()); });
  $('start-preparation').addEventListener('click', openPreparation);
  $('begin-session').addEventListener('click', startSession);
  $('close-session').addEventListener('click', event => { event.stopPropagation(); if (state.phase === 'idle' || state.phase === 'complete') exitSession(); else $('exit-dialog').showModal(); });
  $('session-screen').addEventListener('click', () => finishRetention('tap'));
  $('begin-session').addEventListener('click', event => event.stopPropagation());
  $('finish-session').addEventListener('click', event => { event.stopPropagation(); exitSession(); });
  $('cancel-exit').addEventListener('click', () => $('exit-dialog').close());
  $('confirm-exit').addEventListener('click', exitSession);
  $('clear-history').addEventListener('click', () => { if (confirm('Effacer toutes les séances enregistrées ?')) { localStorage.removeItem(STORAGE_HISTORY); renderHistory(); } });
  document.querySelectorAll('.tab-button').forEach(button => button.addEventListener('click', () => changeTab(button.dataset.tab)));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !['idle', 'complete'].includes(state.phase)) requestWakeLock(); });

  // Retire toute ancienne version hors ligne ; la V6 privilégie toujours les fichiers publiés.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(registrations => registrations.forEach(registration => registration.unregister())).catch(() => {});
  if ('caches' in window) caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))).catch(() => {});
  const safetyAccepted = localStorage.getItem(STORAGE_SAFETY) === 'yes';
  show(screens.safety, !safetyAccepted); show(screens.main, safetyAccepted);
  renderHistory();
})();
