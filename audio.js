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
    
    // Smoothing factors
    this.smoothVars = { energy: 0, bass: 0, mids: 0, treble: 0 };
    this.smoothing = 0.8;
    
    // Kick onset detector
    this.kick = 0;              // current kick intensity (0-1), decays over time
    this._prevKickBand = 0;     // previous frame's narrow kick-band energy
    this._prevMidsLowRaw = 0;   // previous frame's lower-mids energy (for gating)
    this._kickDecay = 0.92;     // how fast the kick pulse fades
    this._kickThreshold = 0.025; // minimum kick-band jump to register as a kick
    this._kickCooldown = 0;     // frames to wait before next kick can fire
    this._kickCooldownMax = 6;  // ~100ms at 60fps to avoid double-triggers
    
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

  playUrl(url) {
    this.init();
    this.audioElement.src = url;
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
    this.audioElement.play();
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
    
    // Calculate bands (0 to 255 bins for 512 fftSize, roughly 0-11kHz)
    let b = 0, m = 0, t = 0;
    
    // Bass (0-10 bins)
    for (let i = 0; i < 10; i++) b += this.dataArray[i];
    // Mids (10-100 bins)
    for (let i = 10; i < 100; i++) m += this.dataArray[i];
    // Treble (100-250 bins)
    for (let i = 100; i < 250; i++) t += this.dataArray[i];
    
    b = b / (10 * 255);
    m = m / (90 * 255);
    t = t / (150 * 255);
    let total = (b + m + t) / 3;

    // Smooth values to prevent jarring jumps
    this.smoothVars.bass = this.smoothVars.bass * this.smoothing + b * (1 - this.smoothing);
    this.smoothVars.mids = this.smoothVars.mids * this.smoothing + m * (1 - this.smoothing);
    this.smoothVars.treble = this.smoothVars.treble * this.smoothing + t * (1 - this.smoothing);
    this.smoothVars.energy = this.smoothVars.energy * this.smoothing + total * (1 - this.smoothing);

    this.bass = this.smoothVars.bass;
    this.mids = this.smoothVars.mids;
    this.treble = this.smoothVars.treble;
    this.energy = this.smoothVars.energy;

    // Kick onset detection: bins 1-6 (~86-516Hz) captures kick fundamental + body
    // without reaching into bass guitar / lower-mids territory.
    let kickBand = 0;
    for (let i = 1; i <= 6; i++) kickBand += this.dataArray[i];
    kickBand = kickBand / (6 * 255);

    // Lower-mids gate (bins 10-40, ~860Hz-3.4kHz): if mids are also spiking,
    // the transient is likely a chord hit or vocal — not a kick drum.
    let midsLow = 0;
    for (let i = 10; i < 40; i++) midsLow += this.dataArray[i];
    midsLow = midsLow / (30 * 255);

    const kickDerivative = kickBand - this._prevKickBand;
    const midsDerivative = midsLow - this._prevMidsLowRaw;
    this._prevKickBand = kickBand;
    this._prevMidsLowRaw = midsLow;

    // Decay existing kick
    this.kick *= this._kickDecay;

    // Cooldown prevents double-triggers on the same beat
    if (this._kickCooldown > 0) {
      this._kickCooldown--;
    } else if (kickDerivative > this._kickThreshold && kickDerivative > midsDerivative * 1.5) {
      // Bass spike must be at least 1.5x the simultaneous mids spike to pass the gate
      this.kick = Math.min(1.0, kickDerivative * 5.0);
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
