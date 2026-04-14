import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

export class RenderingSubsystem {
  constructor(canvas) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf5f5f0);
    this.scene.fog = new THREE.FogExp2(0xf5f5f0, 0.0004); // Very subtle fog — birds always visible

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 3000);
    this.camera.position.z = 600;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Create the Ribbon Boids
    this.WIDTH = 64;
    this.boidsCount = this.WIDTH * this.WIDTH;
    this.initGeometry();

    // Post processing — just a clean render pass
    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }
  
  getRenderer() {
      return this.renderer;
  }

  initGeometry() {
    // Small, elongated diamond shape — reads as a bird silhouette at distance
    const referenceGeometry = new THREE.ConeGeometry(0.5, 4.0, 4);
    referenceGeometry.rotateX(Math.PI / 2); // align with Z axis (flight direction)

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.instanceCount = this.boidsCount;
    this.geometry.index = referenceGeometry.index;
    this.geometry.attributes.position = referenceGeometry.attributes.position;
    this.geometry.attributes.normal = referenceGeometry.attributes.normal;
    this.geometry.attributes.uv = referenceGeometry.attributes.uv;

    const referenceUVs = new Float32Array(this.boidsCount * 2);
    for (let i = 0; i < this.boidsCount; i++) {
        const x = (i % this.WIDTH) / this.WIDTH;
        const y = ~~(i / this.WIDTH) / this.WIDTH;
        referenceUVs[i * 2] = x;
        referenceUVs[i * 2 + 1] = y;
    }
    this.geometry.setAttribute('reference', new THREE.InstancedBufferAttribute(referenceUVs, 2));

    this.material = new THREE.ShaderMaterial({
        uniforms: {
            texturePosition: { value: null },
            textureVelocity: { value: null },
            audioEnergy: { value: 0.0 },
            kick: { value: 0.0 }
        },
        vertexShader: `
            uniform sampler2D texturePosition;
            uniform sampler2D textureVelocity;
            uniform float audioEnergy;
            uniform float kick;
            
            attribute vec2 reference;
            
            varying float vShade;
            varying float vDepth;

            void main() {
                vec4 tmpPos = texture2D(texturePosition, reference);
                vec3 pos = tmpPos.xyz;
                vec3 velocity = texture2D(textureVelocity, reference).xyz;

                float speed = length(velocity);
                vec3 localPosition = position;
                
                // Elongate based on speed
                localPosition.z *= 1.0 + clamp(speed / 20.0, 0.0, 2.0);
                // Slightly widen when slow (wings spread)
                localPosition.x *= 1.0 + clamp(1.0 - speed / 30.0, 0.0, 0.5);

                // Kick pulse: birds swell on detected kick drums
                float beatPulse = kick * 2.5;
                localPosition *= 1.0 + beatPulse;

                // Align to velocity direction
                vec3 dir = normalize(velocity + vec3(0.0001, 0.0, 0.0));
                vec3 up = vec3(0.0, 1.0, 0.0);
                if (abs(dir.y) > 0.999) up = vec3(1.0, 0.0, 0.0);
                vec3 right = normalize(cross(up, dir));
                up = cross(dir, right);
                
                mat3 rot = mat3(right, up, dir);
                vec3 newPosition = rot * localPosition + pos;

                // Depth-based shading: birds further away are lighter (atmospheric perspective)
                vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
                vDepth = clamp(-mvPosition.z / 1200.0, 0.0, 1.0);
                
                // Shade based on orientation relative to a soft "sky light" from above
                float topLight = dot(dir, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
                vShade = mix(0.15, 0.55, topLight);
                
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            varying float vShade;
            varying float vDepth;
            uniform float kick;
            
            void main() {
                float finalShade = mix(vShade, 0.75, vDepth * vDepth);
                // Kick pulse: flash darker on kick hits
                finalShade *= (1.0 - kick * 0.6);
                gl_FragColor = vec4(vec3(finalShade), 1.0);
            }
        `,
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: true
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  update(physicsSubsystem, audioFeatures) {
    this.material.uniforms.texturePosition.value = physicsSubsystem.getPositionTexture();
    this.material.uniforms.textureVelocity.value = physicsSubsystem.getVelocityTexture();
    this.material.uniforms.audioEnergy.value = audioFeatures.energy;
    this.material.uniforms.kick.value = audioFeatures.kick;

    // Very slow, gentle camera orbit — mimics a distant observer
    const time = Date.now() * 0.00006;
    const camRadius = 800 + Math.sin(time * 0.7) * 100;
    this.camera.position.x = Math.sin(time) * camRadius;
    this.camera.position.z = Math.cos(time) * camRadius;
    this.camera.position.y = Math.sin(time * 0.3) * 200 + 100; // Slightly elevated
    this.camera.lookAt(0, 0, 0);

    this.composer.render();
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
