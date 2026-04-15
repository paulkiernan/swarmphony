# swarmphony

A generative murmuration — 4,096 birds simulated in real time on the GPU, reacting live to a radio stream.

## How it works

The simulation is built on the topological neighbor model described by [Ballerini et al. (2008)](https://www.pnas.org/doi/10.1073/pnas.0711437105). Each bird tracks only its **7 nearest neighbors** — not all birds within a fixed radius — and follows three rules:

- **Separation** — avoid collisions
- **Alignment** — match heading with neighbors
- **Cohesion** — stay close to the local group

The sweeping, organic motion emerges entirely from these local interactions. All 4,096 velocity updates run in parallel on the GPU via a WebGL compute pass using Three.js `GPUComputationRenderer`.

### Audio reactivity

The simulation is driven by a live stream from [DEF CON Radio](https://somafm.com/defcon/) on SomaFM:

| Signal | Effect |
|--------|--------|
| Kick drum | Scatters each bird away from its local flock center |
| Bass | Pushes sub-flocks apart with curl-noise bursts |
| Mids | Tightens alignment — birds lock into synchronized waves |
| Treble | Drives turbulent flutter via curl noise |
| Energy | Modulates overall speed and turn rate |

Kick detection uses an onset detector on a narrow frequency band (~86–516 Hz) with a lower-mids gate to avoid false triggers from chords and vocals.

## Running locally

No build step — it's plain ES modules.

```bash
# Any static file server works, e.g.:
npx serve .
# or
python3 -m http.server
```

Then open `http://localhost:3000` (or whatever port) and click the music note to start the stream.

## Controls

| Control | Description |
|---------|-------------|
| ♪ (bottom right) | Start stream / toggle mute |
| what's this? | About the project |
| dev | Toggle dev panel — spectrogram, kick detector graph, and parameter sliders |

### Dev panel sliders

- **Sep/Ali/Coh Dist** — neighbor detection radii for each boid rule
- **Sep/Ali/Coh Force** — strength of each rule
- **Max Speed** — top boid velocity
- **Kick Force** — how violently kicks scatter the flock

## Stack

- [Three.js](https://threejs.org/) — rendering and GPU compute
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) — stream analysis
- [SomaFM DEF CON Radio](https://somafm.com/defcon/) — audio source
