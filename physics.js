import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

const WIDTH = 64; // 64x64 = 4096 boids
const BOUNDS = 800;

const positionShader = `
uniform float time;
uniform float delta;

void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 tmpPos = texture2D(texturePosition, uv);
    vec3 position = tmpPos.xyz;
    vec3 velocity = texture2D(textureVelocity, uv).xyz;

    float phase = tmpPos.w;

    // Euler integration — moderate speed multiplier for readable motion
    position += velocity * delta * 15.0;

    gl_FragColor = vec4(position, phase);
}
`;

const velocityShader = `
uniform float time;
uniform float delta;
uniform float separationDistance;
uniform float alignmentDistance;
uniform float cohesionDistance;
uniform float audioEnergy;
uniform float audioBass;
uniform float audioMids;
uniform float audioTreble;
uniform float separationForce;
uniform float alignmentForce;
uniform float cohesionForce;
uniform float maxSpeedBase;
uniform float audioKick;
uniform float kickForce;

const float PI = 3.141592653589793;

// Hash function for pseudo-random sampling
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// 3D curl noise for smooth, divergence-free wander
vec3 curlNoise(vec3 p) {
    float e = 0.1;
    float n1, n2, a, b;

    // Partial derivatives via finite differences of a noise field
    n1 = hash(vec2(p.y + e, p.z)); n2 = hash(vec2(p.y - e, p.z));
    a = (n1 - n2) / (2.0 * e);
    n1 = hash(vec2(p.z + e, p.x)); n2 = hash(vec2(p.z - e, p.x));
    b = (n1 - n2) / (2.0 * e);
    float cx = a - b;

    n1 = hash(vec2(p.z + e, p.x)); n2 = hash(vec2(p.z - e, p.x));
    a = (n1 - n2) / (2.0 * e);
    n1 = hash(vec2(p.x + e, p.y)); n2 = hash(vec2(p.x - e, p.y));
    b = (n1 - n2) / (2.0 * e);
    float cy = a - b;

    n1 = hash(vec2(p.x + e, p.y)); n2 = hash(vec2(p.x - e, p.y));
    a = (n1 - n2) / (2.0 * e);
    n1 = hash(vec2(p.y + e, p.z)); n2 = hash(vec2(p.y - e, p.z));
    b = (n1 - n2) / (2.0 * e);
    float cz = a - b;

    return vec3(cx, cy, cz);
}

void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 selfPosition = texture2D(texturePosition, uv).xyz;
    vec3 selfVelocity = texture2D(textureVelocity, uv).xyz;

    float speed = length(selfVelocity);
    vec3 selfDir = speed > 0.001 ? selfVelocity / speed : vec3(0.0, 1.0, 0.0);

    // Dynamic speed based on audio
    float maxSpeed = maxSpeedBase + audioEnergy * 15.0;
    float cruiseSpeed = maxSpeed * 0.7; // Birds prefer a comfortable cruise

    // === TOPOLOGICAL NEIGHBOR SEARCH ===
    // Real starlings track ~7 nearest neighbors (Ballerini et al. 2008)
    // We approximate by sparse-sampling 64 random candidates from the texture
    // and keeping the 7 nearest, which is far more realistic than checking all 4096

    // Store the 7 nearest neighbors
    float nearDist[7];
    vec2 nearRef[7];
    vec3 nearPos[7];
    // Initialize with large distances
    for (int i = 0; i < 7; i++) {
        nearDist[i] = 99999.0;
        nearRef[i] = vec2(-1.0);
        nearPos[i] = vec3(0.0);
    }

    // Sparse sampling: check 64 random candidates from the texture
    for (int s = 0; s < 64; s++) {
        // Generate a pseudo-random UV to sample
        float fi = float(s);
        vec2 ref = vec2(
            fract(hash(uv + vec2(fi * 0.1, time * 0.01)) * resolution.x + 0.5),
            fract(hash(uv.yx + vec2(fi * 0.17, time * 0.013)) * resolution.y + 0.5)
        );
        ref = (floor(ref * resolution.xy) + 0.5) / resolution.xy;

        // Skip self
        if (abs(ref.x - uv.x) < 0.001 && abs(ref.y - uv.y) < 0.001) continue;

        vec3 otherPos = texture2D(texturePosition, ref).xyz;
        float d = distance(selfPosition, otherPos);

        // Insert into sorted nearest-neighbor list
        for (int i = 0; i < 7; i++) {
            if (d < nearDist[i]) {
                // Shift everything down
                for (int j = 6; j > i; j--) {
                    nearDist[j] = nearDist[j-1];
                    nearRef[j] = nearRef[j-1];
                    nearPos[j] = nearPos[j-1];
                }
                nearDist[i] = d;
                nearRef[i] = ref;
                nearPos[i] = otherPos;
                break;
            }
        }
    }

    // === COMPUTE FORCES FROM 7 NEAREST NEIGHBORS ===
    vec3 sepForce = vec3(0.0);
    vec3 alignVel = vec3(0.0);
    vec3 cohCenter = vec3(0.0);
    float sepCount = 0.0;
    float alignCount = 0.0;
    float cohCount = 0.0;

    for (int i = 0; i < 7; i++) {
        if (nearDist[i] > 9999.0) continue; // No valid neighbor

        float d = nearDist[i];
        vec3 nPos = nearPos[i];
        vec3 toNeighbor = nPos - selfPosition;
        vec3 dirN = d > 0.001 ? toNeighbor / d : vec3(0.0);

        // Vision cone: ~240 degree forward vision (blind spot behind)
        float facing = dot(selfDir, dirN);

        // 1. Separation — always active, even behind (collision avoidance is omnidirectional)
        if (d < separationDistance) {
            float repel = 1.0 - (d / separationDistance);
            sepForce -= dirN * repel * repel;
            sepCount += 1.0;
        }

        // 2. Alignment — only for neighbors in the forward arc
        if (facing > -0.3) {
            vec3 nVel = texture2D(textureVelocity, nearRef[i]).xyz;
            alignVel += nVel;
            alignCount += 1.0;
        }

        // 3. Cohesion — neighbors in view
        if (facing > -0.3) {
            cohCenter += nPos;
            cohCount += 1.0;
        }
    }

    // === APPLY FORCES (heavily audio-modulated) ===
    vec3 steer = vec3(0.0);

    // Audio-driven separation: bass pushes birds apart but not explosively
    float dynamicSep = separationForce * (1.0 + audioBass * 2.0);
    if (sepCount > 0.0) {
        sepForce /= sepCount;
        steer += normalize(sepForce + vec3(0.0001)) * dynamicSep;
    }

    // Alignment: mids make them lock into tight formations
    // Low mids = loose, drifting streams; high mids = crisp synchronized waves
    float dynamicAlign = alignmentForce * (0.3 + audioMids * 3.0);
    if (alignCount > 0.0) {
        alignVel /= alignCount;
        vec3 desiredDir = normalize(alignVel + vec3(0.0001));
        steer += (desiredDir * cruiseSpeed - selfVelocity) * dynamicAlign;
    }

    // Cohesion: controls sub-flock splitting and merging
    // During QUIET passages: cohesion is strong — sub-flocks merge into one
    // During LOUD passages: cohesion weakens — flock splits into 2-3 sub-groups
    // But never drops to zero, so they always stay as recognizable groups
    float energyInverse = 1.0 - clamp(audioEnergy * 1.5, 0.0, 0.6);
    float dynamicCoh = cohesionForce * (energyInverse + 0.4);
    if (cohCount > 0.0) {
        cohCenter /= cohCount;
        vec3 toCoh = cohCenter - selfPosition;
        float cohDist = length(toCoh);
        if (cohDist > 1.0) {
            steer += normalize(toCoh) * dynamicCoh;
        }
    }

    // === VIEWPORT-AWARE BOUNDARY ===
    // Wide in X/Y (birds can sweep across the full screen) but tight in Z
    // (prevents them from flying toward/behind the camera)
    vec3 boundSize = vec3(600.0, 400.0, 200.0); // wide, tall, shallow
    vec3 overshoot3 = max(abs(selfPosition) - boundSize, vec3(0.0));
    vec3 returnDir = -sign(selfPosition) * overshoot3 * overshoot3 * 0.01;
    steer += returnDir;

    // === CURL NOISE WANDER ===
    vec3 wanderSample = selfPosition * 0.003 + time * 0.15;
    vec3 wander = curlNoise(wanderSample);
    // Moderate turbulence — enough to create sub-flock drift, not chaos
    float wanderStrength = 5.0 + audioEnergy * 15.0 + audioTreble * 8.0;
    steer += wander * wanderStrength;

    // === BASS SCATTER EVENT ===
    // Moderate scatter that pushes sub-flocks apart without total fragmentation
    if (audioBass > 0.3) {
        vec3 burstDir = curlNoise(selfPosition * 0.01 + time * 2.0);
        steer += burstDir * (audioBass - 0.3) * 60.0;
    }

    // === TREBLE SWIRL ===
    if (audioTreble > 0.3) {
        vec3 swirlAxis = normalize(selfPosition + vec3(0.001));
        vec3 swirlForce = cross(swirlAxis, selfDir) * (audioTreble - 0.3) * 25.0;
        steer += swirlForce;
    }

    // === KICK SCATTER ===
    // On detected kick drums, repel birds radially outward from their local neighbour centroid
    if (audioKick > 0.05) {
        vec3 localCenter = cohCount > 0.0 ? cohCenter / cohCount : selfPosition;
        vec3 outward = normalize(selfPosition - localCenter + vec3(0.001));
        steer += outward * audioKick * kickForce;
    }

    // === ANGULAR VELOCITY LIMITING ===
    // Real birds bank and turn — they can't reverse direction instantly.
    // But during kicks, allow much sharper turns so the scatter is visible.
    vec3 desiredVel = selfVelocity + steer * delta;
    float desiredSpeed = length(desiredVel);

    if (desiredSpeed > 0.001 && speed > 0.001) {
        vec3 desiredDir = desiredVel / desiredSpeed;

        // Widen turn rate during kicks
        float maxTurnRate = 0.06 + audioEnergy * 0.02 + audioKick * 0.5;
        float cosAngle = clamp(dot(selfDir, desiredDir), -1.0, 1.0);

        if (cosAngle < cos(maxTurnRate)) {
            // Slerp-like interpolation: blend current direction toward desired
            vec3 turnAxis = cross(selfDir, desiredDir);
            float turnAxisLen = length(turnAxis);
            if (turnAxisLen > 0.0001) {
                turnAxis /= turnAxisLen;
                // Rodrigues' rotation: rotate selfDir by maxTurnRate around turnAxis
                float c = cos(maxTurnRate);
                float s = sin(maxTurnRate);
                vec3 newDir = selfDir * c + cross(turnAxis, selfDir) * s + turnAxis * dot(turnAxis, selfDir) * (1.0 - c);
                desiredVel = normalize(newDir) * desiredSpeed;
            }
        }
    }

    // === SPEED REGULATION ===
    // Birds maintain a fairly constant speed — they adjust direction, not velocity magnitude
    float finalSpeed = length(desiredVel);
    if (finalSpeed > 0.001) {
        vec3 finalDir = desiredVel / finalSpeed;
        // Gently pull speed toward cruise speed
        float targetSpeed = mix(finalSpeed, cruiseSpeed, 0.05);
        targetSpeed = clamp(targetSpeed, maxSpeed * 0.4, maxSpeed);
        selfVelocity = finalDir * targetSpeed;
    } else {
        // Kick stationary birds into motion
        selfVelocity = selfDir * cruiseSpeed * 0.5;
    }

    gl_FragColor = vec4(selfVelocity, 1.0);
}
`;

export class PhysicsSubsystem {
    constructor(renderer) {
        this.gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        this.boidsCount = WIDTH * WIDTH;

        const dtPosition = this.gpuCompute.createTexture();
        const dtVelocity = this.gpuCompute.createTexture();

        this.fillPositionTexture(dtPosition);
        this.fillVelocityTexture(dtVelocity);

        this.velocityVariable = this.gpuCompute.addVariable("textureVelocity", velocityShader, dtVelocity);
        this.positionVariable = this.gpuCompute.addVariable("texturePosition", positionShader, dtPosition);

        this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable]);
        this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);

        this.positionUniforms = this.positionVariable.material.uniforms;
        this.velocityUniforms = this.velocityVariable.material.uniforms;

        this.positionUniforms["time"] = { value: 0.0 };
        this.positionUniforms["delta"] = { value: 0.0 };
        this.velocityUniforms["time"] = { value: 0.0 };
        this.velocityUniforms["delta"] = { value: 0.0 };

        // Tuned defaults from user testing
        this.velocityUniforms["separationDistance"] = { value: 20.0 };
        this.velocityUniforms["alignmentDistance"] = { value: 136.0 };
        this.velocityUniforms["cohesionDistance"] = { value: 150.0 };

        this.velocityUniforms["audioEnergy"] = { value: 0.0 };
        this.velocityUniforms["audioBass"] = { value: 0.0 };
        this.velocityUniforms["audioMids"] = { value: 0.0 };
        this.velocityUniforms["audioTreble"] = { value: 0.0 };

        this.velocityUniforms["separationForce"] = { value: 25.0 };
        this.velocityUniforms["alignmentForce"] = { value: 3.5 };
        this.velocityUniforms["cohesionForce"] = { value: 5.0 };
        this.velocityUniforms["maxSpeedBase"] = { value: 25.0 };
        this.velocityUniforms["audioKick"] = { value: 0.0 };
        this.velocityUniforms["kickForce"] = { value: 120.0 };

        this.velocityVariable.wrapS = THREE.RepeatWrapping;
        this.velocityVariable.wrapT = THREE.RepeatWrapping;
        this.positionVariable.wrapS = THREE.RepeatWrapping;
        this.positionVariable.wrapT = THREE.RepeatWrapping;

        const error = this.gpuCompute.init();
        if (error !== null) {
            console.error(error);
        }
    }

    fillPositionTexture(texture) {
        const theArray = texture.image.data;
        for (let k = 0, kl = theArray.length; k < kl; k += 4) {
            // Spawn in a moderately spread sphere — not too tight, not too loose
            const r = Math.random() * 200;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const x = r * Math.sin(phi) * Math.cos(theta);
            const y = r * Math.sin(phi) * Math.sin(theta);
            const z = r * Math.cos(phi);
            theArray[k + 0] = x;
            theArray[k + 1] = y;
            theArray[k + 2] = z;
            theArray[k + 3] = 1;
        }
    }

    fillVelocityTexture(texture) {
        const theArray = texture.image.data;
        // Give all birds a common initial direction with slight variation
        // This seeds the alignment behavior immediately
        for (let k = 0, kl = theArray.length; k < kl; k += 4) {
            theArray[k + 0] = 5.0 + (Math.random() - 0.5) * 3;
            theArray[k + 1] = 3.0 + (Math.random() - 0.5) * 3;
            theArray[k + 2] = 2.0 + (Math.random() - 0.5) * 3;
            theArray[k + 3] = 1;
        }
    }

    update(delta, time, audioFeatures) {
        this.positionUniforms["time"].value = time;
        this.positionUniforms["delta"].value = delta;
        this.velocityUniforms["time"].value = time;
        this.velocityUniforms["delta"].value = delta;

        this.velocityUniforms["audioEnergy"].value = audioFeatures.energy;
        this.velocityUniforms["audioBass"].value = audioFeatures.bass;
        this.velocityUniforms["audioMids"].value = audioFeatures.mids;
        this.velocityUniforms["audioTreble"].value = audioFeatures.treble;
        this.velocityUniforms["audioKick"].value = audioFeatures.kick;

        this.gpuCompute.compute();
    }

    updateParams(params) {
        if (params.sepDist !== undefined) this.velocityUniforms["separationDistance"].value = params.sepDist;
        if (params.aliDist !== undefined) this.velocityUniforms["alignmentDistance"].value = params.aliDist;
        if (params.cohDist !== undefined) this.velocityUniforms["cohesionDistance"].value = params.cohDist;
        if (params.sepForce !== undefined) this.velocityUniforms["separationForce"].value = params.sepForce;
        if (params.aliForce !== undefined) this.velocityUniforms["alignmentForce"].value = params.aliForce;
        if (params.cohForce !== undefined) this.velocityUniforms["cohesionForce"].value = params.cohForce;
        if (params.maxSpeed !== undefined) this.velocityUniforms["maxSpeedBase"].value = params.maxSpeed;
        if (params.kickForce !== undefined) this.velocityUniforms["kickForce"].value = params.kickForce;
    }

    getPositionTexture() {
        return this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;
    }

    getVelocityTexture() {
        return this.gpuCompute.getCurrentRenderTarget(this.velocityVariable).texture;
    }
}
