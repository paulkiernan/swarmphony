import * as THREE from 'three';
import { AudioSubsystem } from './audio.js?v=37';
import { PhysicsSubsystem } from './physics.js?v=37';
import { RenderingSubsystem } from './rendering.js?v=37';

let audioSystem;
let physicsSystem;
let renderingSystem;
let clock;

const statusEl = document.getElementById('status');
const nowPlayingEl = document.getElementById('now-playing');
const nowPlayingText = document.getElementById('now-playing-text');
let nowPlayingInterval = null;

let isDevMode = false;
let spectrogramCanvas, spectrogramCtx;
let kickCanvas, kickCtx;
let kickHistory = [];
const KICK_HISTORY_LEN = 300;
const devPanel = document.getElementById('dev-mode-panel');
const devStats = document.getElementById('dev-stats');

function init() {
  const canvas = document.getElementById('canvas');
  spectrogramCanvas = document.getElementById('spectrogram-canvas');
  spectrogramCtx = spectrogramCanvas.getContext('2d');
  kickCanvas = document.getElementById('kick-canvas');
  kickCtx = kickCanvas.getContext('2d');

  audioSystem = new AudioSubsystem();
  renderingSystem = new RenderingSubsystem(canvas);
  physicsSystem = new PhysicsSubsystem(renderingSystem.getRenderer());
  clock = new THREE.Clock();

  // Dev Mode Toggle (button, not checkbox)
  const devBtn = document.getElementById('dev-btn');
  devBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isDevMode = !isDevMode;
    devBtn.classList.toggle('active', isDevMode);
    devPanel.classList.toggle('hidden', !isDevMode);
  });

  // What's this popover
  const whatsThisBtn = document.getElementById('whats-this-btn');
  const whatsThisPanel = document.getElementById('whats-this-panel');
  whatsThisBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    whatsThisPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!whatsThisPanel.contains(e.target) && e.target !== whatsThisBtn) {
      whatsThisPanel.classList.add('hidden');
    }
  });

  // Mute / play toggle — clicking the note icon also starts the stream the first time
  const muteBtn = document.getElementById('mute-btn');
  const muteIcon = document.getElementById('mute-icon');
  let streamStarted = false;
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!streamStarted) {
      audioSystem.playUrl('https://ice2.somafm.com/defcon-128-mp3');
      streamStarted = true;
      startNowPlaying();
      muteIcon.textContent = '\u266A';
    } else {
      const el = audioSystem.audioElement;
      if (!el) return;
      el.muted = !el.muted;
      muteIcon.textContent = el.muted ? '\uD83D\uDD07' : '\u266A';
    }
  });

  // Sliders
  const sliders = [
    { id: 'sl-sep-dist', valId: 'val-sep-dist', param: 'sepDist' },
    { id: 'sl-ali-dist', valId: 'val-ali-dist', param: 'aliDist' },
    { id: 'sl-coh-dist', valId: 'val-coh-dist', param: 'cohDist' },
    { id: 'sl-sep-force', valId: 'val-sep-force', param: 'sepForce' },
    { id: 'sl-ali-force', valId: 'val-ali-force', param: 'aliForce' },
    { id: 'sl-coh-force', valId: 'val-coh-force', param: 'cohForce' },
    { id: 'sl-max-speed', valId: 'val-max-speed', param: 'maxSpeed' },
    { id: 'sl-kick-force', valId: 'val-kick-force', param: 'kickForce' }
  ];

  sliders.forEach(s => {
    const el = document.getElementById(s.id);
    const valEl = document.getElementById(s.valId);
    el.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      valEl.innerText = val.toFixed(1);
      const params = {};
      params[s.param] = val;
      physicsSystem.updateParams(params);
    });
  });

  // Start animation loop
  animate();
}

async function fetchNowPlaying() {
  try {
    const res = await fetch('https://api.somafm.com/songs/defcon.json');
    if (!res.ok) return;
    const data = await res.json();
    const song = data.songs?.[0];
    if (!song) return;
    const label = `${song.artist} \u2014 ${song.title}`;
    if (nowPlayingText.textContent !== label) {
      nowPlayingEl.style.opacity = '0';
      setTimeout(() => {
        nowPlayingText.textContent = label;
        nowPlayingEl.classList.remove('hidden');
        nowPlayingEl.style.opacity = '';
      }, 400);
    }
  } catch (_) {
    // silently ignore network errors
  }
}

function startNowPlaying() {
  fetchNowPlaying();
  nowPlayingInterval = setInterval(fetchNowPlaying, 30_000);
}

function animate() {
  requestAnimationFrame(animate);

  const rawDelta = clock.getDelta();
  // Clamp delta: after tab-away rAF pauses and getDelta() returns a huge value,
  // which would teleport all boids. Cap at ~33ms (30fps) for smooth resume.
  const delta = Math.min(rawDelta, 0.033);
  const time = clock.getElapsedTime();

  audioSystem.update();
  const audioFeatures = {
    energy: audioSystem.energy,
    bass: audioSystem.bass,
    mids: audioSystem.mids,
    treble: audioSystem.treble,
    kick: audioSystem.kick
  };

  physicsSystem.update(delta, time, audioFeatures);
  renderingSystem.update(physicsSystem, audioFeatures);

  if (isDevMode && audioSystem.analyser) {
    drawVisualizer(audioFeatures);
  }
}

function drawVisualizer(features) {
  if (!audioSystem.analyser) return;

  // === SCROLLING SPECTROGRAM ===
  const data = audioSystem.dataArray;
  const bufferLength = audioSystem.analyser.frequencyBinCount;
  const sW = spectrogramCanvas.width;
  const sH = spectrogramCanvas.height;

  // Shift existing image 1px left
  const imgData = spectrogramCtx.getImageData(1, 0, sW - 1, sH);
  spectrogramCtx.putImageData(imgData, 0, 0);

  // Draw new column on the right edge
  for (let i = 0; i < sH; i++) {
    // Map canvas row to frequency bin (bottom = low freq, top = high freq)
    const binIndex = Math.floor((i / sH) * bufferLength);
    const value = data[binIndex] / 255;
    // Color: dark bg, bright warm colors for intensity
    const r = Math.floor(value * 255);
    const g = Math.floor(value * 100);
    const b = Math.floor((1 - value) * 80);
    spectrogramCtx.fillStyle = `rgb(${r},${g},${b})`;
    spectrogramCtx.fillRect(sW - 1, sH - 1 - i, 1, 1);
  }

  // === KICK TIMESERIES ===
  kickHistory.push(audioSystem.kick);
  if (kickHistory.length > KICK_HISTORY_LEN) kickHistory.shift();

  const kW = kickCanvas.width;
  const kH = kickCanvas.height;
  kickCtx.fillStyle = '#1a1a1a';
  kickCtx.fillRect(0, 0, kW, kH);

  // Draw threshold line
  kickCtx.strokeStyle = 'rgba(255, 80, 80, 0.4)';
  kickCtx.setLineDash([4, 4]);
  kickCtx.beginPath();
  const threshY = kH - (0.3 * kH); // rough visual threshold
  kickCtx.moveTo(0, threshY);
  kickCtx.lineTo(kW, threshY);
  kickCtx.stroke();
  kickCtx.setLineDash([]);

  // Draw kick waveform
  kickCtx.strokeStyle = '#ff6644';
  kickCtx.lineWidth = 1.5;
  kickCtx.beginPath();
  for (let i = 0; i < kickHistory.length; i++) {
    const x = (i / KICK_HISTORY_LEN) * kW;
    const y = kH - (kickHistory[i] * kH);
    if (i === 0) kickCtx.moveTo(x, y);
    else kickCtx.lineTo(x, y);
  }
  kickCtx.stroke();

  // Fill kicks as bars for emphasis
  kickCtx.fillStyle = 'rgba(255, 102, 68, 0.15)';
  for (let i = 0; i < kickHistory.length; i++) {
    if (kickHistory[i] > 0.3) {
      const x = (i / KICK_HISTORY_LEN) * kW;
      const barH = kickHistory[i] * kH;
      kickCtx.fillRect(x - 1, kH - barH, 2, barH);
    }
  }

  // === STATS TABLE ===
  devStats.innerHTML = `<table style="border-collapse:collapse;font-family:monospace;font-size:11px;width:100%">
    <tr><td style="color:#888">Energy</td><td style="text-align:right">${features.energy.toFixed(3)}</td>
        <td style="color:#888;padding-left:12px">Bass</td><td style="text-align:right">${features.bass.toFixed(3)}</td></tr>
    <tr><td style="color:#888">Mids</td><td style="text-align:right">${features.mids.toFixed(3)}</td>
        <td style="color:#888;padding-left:12px">Treble</td><td style="text-align:right">${features.treble.toFixed(3)}</td></tr>
    <tr><td style="color:#888">Kick</td><td style="text-align:right;color:#ff6644;font-weight:${features.kick > 0.3 ? 'bold' : 'normal'}">${features.kick.toFixed(3)}</td>
        <td style="color:#888;padding-left:12px">Boids</td><td style="text-align:right">${physicsSystem.boidsCount}</td></tr>
  </table>`;
}

// Start app
init();
