export class AudioSubsystem {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.audioElement = null;
    this.sourceNode = null;
    this.dataArray = null;
    
    // Extracted features
    this.energy = 0;
    this.bass = 0;
    this.mids = 0;
    this.treble = 0;
    
    // Smoothing factors (per-feature — mids and treble have different time constants)
    this.smoothVars = { energy: 0, bass: 0, mids: 0, treble: 0 };
    this.smoothing = 0.7;       // bass / energy — slightly faster than before
    this.smoothingMids = 0.6;   // slower — alignment should breathe with musical phrases
    this.smoothingTreble = 0.2; // faster — flutter should snap to transients

    // Adaptive energy normalization: sliding window min/max over ~5s (300 frames).
    // Floor = local minimum in the window, so a quiet breakdown quickly pulls it
    // toward 0. Ceiling = local maximum, so the loudest recent moment = 1.0.
    const ENERGY_WINDOW = 300;
    this._energyWindow  = new Float32Array(ENERGY_WINDOW);
    this._energyWinIdx  = 0;

    // EMA applied to the final normalized energy output (smooths adaptive-window step-changes)
    this._energyEMA = 0;
    this._energyEMAAlpha = 0.15; // ~100ms time constant @ 60fps

    // Previous treble-band spectrum for spectral flux calculation
    this._prevTrebleBins = new Float32Array(141); // bins 46-186
    
    // Kick onset detector
    this.kick = 0;                  // current kick intensity (0-1), decays over time
    this._kickDecay = 0.88;         // punchy but smooth tail (~5.5 frame half-life)
    this._kickCooldown = 0;         // frames to wait before next kick can fire
    this._kickCooldownMax = 8;      // ~133ms at 60fps — tight enough for fast kick patterns

    // 2-frame moving average buffer for kick band (minimal smoothing, preserves transients)
    this._kickSmooth = [0, 0];

    // Previous smoothed kick-band value for derivative
    this._prevKickSmoothed = 0;

    // Previous lower-mids energy for gating
    this._prevMidsLowRaw = 0;

    // Adaptive threshold: rolling mean of half-wave-rectified derivatives.
    // Tracking the derivative (not raw energy) means sustained bass doesn't inflate
    // the threshold — only actual transients count.
    this._kickDerivHistory = new Float32Array(120); // ~2s at 60fps
    this._kickDerivIdx = 0;
    
    this.isPlaying = false;
  }

  init() {
    if (this.context) return;
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.4; // Low smoothing so transients punch through
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    
    this.audioElement = new Audio();
    this.audioElement.crossOrigin = "anonymous";
    this.sourceNode = this.context.createMediaElementSource(this.audioElement);
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.context.destination);

    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
    });
    this.audioElement.addEventListener('play', () => {
      this.isPlaying = true;
    });
    this.audioElement.addEventListener('pause', () => {
      this.isPlaying = false;
    });
  }

  playFile(file) {
    this.init();
    const url = URL.createObjectURL(file);
    this.playUrl(url);
  }

  playSample(url) {
    this.init();
    this.playUrl(url);
  }

  async playUrl(url) {
    this.init();
    this.audioElement.src = url;
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    try {
      await this.audioElement.play();
    } catch (e) {
      console.error('Audio play failed:', e);
    }

    // On iOS, createMediaElementSource often doesn't pipe streaming audio
    // through the Web Audio analyser. Detect this after a short delay and
    // fall back to a fetch-based analyser source.
    setTimeout(() => this._checkAndFixIOSAnalyser(url), 2000);
  }

  async _checkAndFixIOSAnalyser(url) {
    if (!this.analyser || !this.isPlaying) return;
    this.analyser.getByteFrequencyData(this.dataArray);
    const sum = this.dataArray.reduce((a, b) => a + b, 0);
    if (sum > 0) return; // analyser is working fine

    // Analyser is silent — iOS createMediaElementSource doesn't pipe streaming
    // audio through the Web Audio graph. Reroute: audio element plays directly
    // to speakers, fetch-based stream feeds the analyser for visualization only.
    console.warn('iOS analyser silent — switching to fetch-based analyser source');
    try {
      // Disconnect analyser from speakers so decoded viz data doesn't double-play
      this.analyser.disconnect(this.context.destination);
      // Route the audio element directly to speakers instead
      this.sourceNode.connect(this.context.destination);

      const response = await fetch(url);
      const reader = response.body.getReader();
      const chunks = [];
      let totalLength = 0;
      const CHUNK_DECODE_SIZE = 256 * 1024; // decode in 256KB batches

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLength += value.byteLength;

          if (totalLength >= CHUNK_DECODE_SIZE) {
            const merged = new Uint8Array(totalLength);
            let offset = 0;
            for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
            chunks.length = 0;
            totalLength = 0;

            try {
              const audioBuffer = await this.context.decodeAudioData(merged.buffer.slice(0));
              const src = this.context.createBufferSource();
              src.buffer = audioBuffer;
              // Connect to analyser only — NOT to destination (no audio output)
              src.connect(this.analyser);
              src.start();
              src.onended = () => src.disconnect();
            } catch (_) { /* skip undecodable chunks */ }
          }
        }
      };
      pump();
    } catch (e) {
      console.error('iOS fetch-based analyser fallback failed:', e);
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.audioElement.pause();
    } else {
      this.audioElement.play();
    }
  }

  update() {
    if (!this.analyser || !this.isPlaying) {
      this._decayValues();
      return;
    }

    this.analyser.getByteFrequencyData(this.dataArray);
    
    // === BASS (0-10 bins, ~0-860Hz) — raw energy, used for scatter/wander ===
    let b = 0;
    for (let i = 0; i < 10; i++) b += this.dataArray[i];
    b = b / (10 * 255);

    // === MIDS — spectral centroid over bins 3-46 (~260Hz-4kHz) ===
    // Spectral centroid is the energy-weighted center of the harmonic band.
    // It rises when harmonic content shifts upward (dense chords, bright synths)
    // and falls during bass-heavy or sparse passages — a much richer signal
    // for alignment than raw energy.
    let mWeightedSum = 0, mMagSum = 0;
    for (let i = 3; i <= 46; i++) {
      const mag = this.dataArray[i] / 255;
      mWeightedSum += i * mag;
      mMagSum += mag;
    }
    // Normalize centroid to 0-1 over the band range
    const m = mMagSum > 0.001 ? (mWeightedSum / mMagSum - 3) / (46 - 3) : 0;

    // === TREBLE — spectral flux over bins 46-186 (~4kHz-16kHz) ===
    // Spectral flux measures how rapidly the spectrum is changing frame-to-frame.
    // Caps at bin 186 (~16kHz) — the practical cutoff for 128kbps MP3 streams.
    // Flux spikes on every hi-hat hit, cymbal scrape, or transient burst,
    // making it ideal for driving turbulent flutter.
    let tFlux = 0, tMagSum = 0;
    for (let i = 46; i <= 186; i++) {
      const mag = this.dataArray[i] / 255;
      const prev = this._prevTrebleBins[i - 46];
      tFlux += Math.max(0, mag - prev); // half-wave rectify — only count increases
      tMagSum += mag;
      this._prevTrebleBins[i - 46] = mag;
    }
    // Normalise flux by total magnitude so a loud-but-static signal doesn't
    // inflate it — only genuine spectral change registers.
    const t = tMagSum > 0.001 ? Math.min(1, tFlux / (tMagSum + 0.001) * 4) : 0;

    const total = (b + m + t) / 3;

    // Smooth — each feature has its own time constant
    this.smoothVars.bass   = this.smoothVars.bass   * this.smoothing       + b * (1 - this.smoothing);
    this.smoothVars.mids   = this.smoothVars.mids   * this.smoothingMids   + m * (1 - this.smoothingMids);
    this.smoothVars.treble = this.smoothVars.treble * this.smoothingTreble + t * (1 - this.smoothingTreble);
    this.smoothVars.energy = this.smoothVars.energy * this.smoothing       + total * (1 - this.smoothing);

    this.bass   = this.smoothVars.bass;
    this.mids   = this.smoothVars.mids;
    this.treble = this.smoothVars.treble;

    // Adaptive normalization: sliding window min/max.
    // Store raw energy in a circular buffer, then scan for the local min/max.
    // Floor = window minimum (snaps toward 0 during quiet passages).
    // Ceiling = window maximum (the loudest moment in the last ~5s = 1.0).
    const rawEnergy = this.smoothVars.energy;
    this._energyWindow[this._energyWinIdx] = rawEnergy;
    this._energyWinIdx = (this._energyWinIdx + 1) % this._energyWindow.length;

    let eMin = rawEnergy, eMax = rawEnergy;
    for (let i = 0; i < this._energyWindow.length; i++) {
      if (this._energyWindow[i] < eMin) eMin = this._energyWindow[i];
      if (this._energyWindow[i] > eMax) eMax = this._energyWindow[i];
    }
    const energyRange = eMax - eMin;
    const normalizedEnergy = energyRange > 0.01
      ? (rawEnergy - eMin) / energyRange
      : 0;
    this._energyEMA = this._energyEMA * (1 - this._energyEMAAlpha) + normalizedEnergy * this._energyEMAAlpha;
    this.energy = this._energyEMA;

    // === KICK ONSET DETECTION ===

    // 1. Narrow kick band: bins 0-2 (~0-172Hz at 512 FFT / 44.1kHz)
    //    Kick drum fundamentals live at 50-130Hz — staying this tight minimises
    //    bass guitar and lower-vocal bleed.
    let kickRaw = 0;
    for (let i = 0; i <= 2; i++) kickRaw += this.dataArray[i];
    kickRaw = kickRaw / (3 * 255);

    // 2. 2-frame moving average — minimal smoothing, preserves attack transients
    this._kickSmooth.shift();
    this._kickSmooth.push(kickRaw);
    const kickSmoothed = (this._kickSmooth[0] + this._kickSmooth[1]) / 2;

    // 3. Derivative on the smoothed signal
    const kickDerivative = kickSmoothed - this._prevKickSmoothed;
    this._prevKickSmoothed = kickSmoothed;

    // 4. Lower-mids gate: bins 10-40 (~860Hz-3.4kHz)
    //    Chord hits and vocals spike here too; require kick derivative dominates.
    let midsLow = 0;
    for (let i = 10; i < 40; i++) midsLow += this.dataArray[i];
    midsLow = midsLow / (30 * 255);
    const midsDerivative = midsLow - this._prevMidsLowRaw;
    this._prevMidsLowRaw = midsLow;

    // 5. Adaptive threshold via half-wave-rectified derivative history.
    //    HWR only stores positive spikes, so the mean reflects typical transient
    //    strength rather than sustained bass energy level.
    const hwr = Math.max(0, kickDerivative);
    this._kickDerivHistory[this._kickDerivIdx] = hwr;
    this._kickDerivIdx = (this._kickDerivIdx + 1) % this._kickDerivHistory.length;
    let derivMean = 0;
    for (let i = 0; i < this._kickDerivHistory.length; i++) derivMean += this._kickDerivHistory[i];
    derivMean /= this._kickDerivHistory.length;
    // Require spike to be 2.0× the recent average transient — sensitive enough
    // to catch lighter kicks. Floor prevents lockout during silent passages.
    const adaptiveThreshold = Math.max(0.006, derivMean * 2.0);

    // Decay existing kick
    this.kick *= this._kickDecay;

    // 6. Fire if: derivative clears adaptive threshold AND kick dominates over mids
    if (this._kickCooldown > 0) {
      this._kickCooldown--;
    } else if (hwr > adaptiveThreshold && kickDerivative > midsDerivative * 1.5) {
      this.kick = Math.min(1.0, kickDerivative * 6.0);
      this._kickCooldown = this._kickCooldownMax;
    }
  }
  
  _decayValues() {
    const decay = 0.95;
    this.smoothVars.bass *= decay;
    this.smoothVars.mids *= decay;
    this.smoothVars.treble *= decay;
    this.smoothVars.energy *= decay;
    this.bass = this.smoothVars.bass;
    this.mids = this.smoothVars.mids;
    this.treble = this.smoothVars.treble;
    this.energy = this.smoothVars.energy;
    this.kick *= this._kickDecay;
  }
}
