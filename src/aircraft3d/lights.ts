/**
 * Exterior lighting: nav lights (red left / green right / white tail), red beacon blinking
 * at 1 Hz, white wing-tip strobes double-flashing every 1.5 s, landing and taxi spotlights.
 * Spotlights are only switched on when allowed (external camera or night) to save cost.
 */
import * as THREE from 'three';
import type { ControlInputs } from '../core/types';
import type { C172Layout } from './c172Layout';
import type { ModelMaterials } from './materials';

export interface LightOptions {
  landingIntensity?: number;
  taxiIntensity?: number;
  /** cast shadows from the landing light (expensive, default false) */
  spotShadows?: boolean;
}

const BEACON_PERIOD = 1.0, BEACON_ON = 0.12;
const STROBE_PERIOD = 1.5, STROBE_FLASH = 0.05, STROBE_GAP = 0.12;
/** common multiple of the periods so the clock can wrap */
const CLOCK_WRAP = 3.0;

export class AircraftLights {
  readonly group = new THREE.Group();
  readonly landingLight: THREE.SpotLight;
  readonly taxiLight: THREE.SpotLight;
  /** internal clock, s */
  private t = 0;
  private readonly nav: THREE.Object3D[] = [];
  private readonly beacon: THREE.Object3D[] = [];
  private readonly strobes: THREE.Object3D[] = [];
  private readonly lenses: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(l: C172Layout['lights'], mats: ModelMaterials, opts: LightOptions = {}) {
    this.group.name = 'lights';
    const bulbGeo = new THREE.SphereGeometry(0.03, 8, 6);
    this.geometries.push(bulbGeo);
    const lamp = (pos: THREE.Vector3, bulb: THREE.MeshBasicMaterial, halo: THREE.SpriteMaterial, haloScale: number, into: THREE.Object3D[]) => {
      const g = new THREE.Group();
      g.position.copy(pos);
      const m = new THREE.Mesh(bulbGeo, bulb);
      const s = new THREE.Sprite(halo);
      s.scale.setScalar(haloScale);
      g.add(m, s);
      g.visible = false;
      this.group.add(g);
      into.push(g);
    };
    lamp(l.navLeft, mats.navRed, mats.haloRed, 0.35, this.nav);
    lamp(l.navRight, mats.navGreen, mats.haloGreen, 0.35, this.nav);
    lamp(l.navTail, mats.navWhite, mats.haloWhite, 0.3, this.nav);
    lamp(l.beacon, mats.navRed, mats.haloRed, 0.6, this.beacon);
    lamp(l.strobeLeft, mats.navWhite, mats.haloWhite, 0.9, this.strobes);
    lamp(l.strobeRight, mats.navWhite, mats.haloWhite, 0.9, this.strobes);

    const makeSpot = (pos: THREE.Vector3, intensity: number, angleDeg: number, pitchDownDeg: number): THREE.SpotLight => {
      const s = new THREE.SpotLight(0xfff1dc, intensity, 600, (angleDeg * Math.PI) / 180, 0.5, 2);
      s.position.copy(pos);
      s.target.position.set(pos.x, pos.y - 60 * Math.tan((pitchDownDeg * Math.PI) / 180), pos.z - 60);
      s.castShadow = opts.spotShadows ?? false;
      s.visible = false;
      this.group.add(s, s.target);
      // lens: a small emissive disc so the lamp is visible when on
      const lensGeo = new THREE.CircleGeometry(0.05, 10);
      this.geometries.push(lensGeo);
      const lens = new THREE.Mesh(lensGeo, mats.navWhite);
      lens.position.copy(pos).z -= 0.005;
      lens.rotation.y = Math.PI; // face forward (−Z)
      lens.visible = false;
      this.group.add(lens);
      this.lenses.push(lens);
      return s;
    };
    this.landingLight = makeSpot(l.landing, opts.landingIntensity ?? 4000, 11, 1.5);
    this.taxiLight = makeSpot(l.taxi, opts.taxiIntensity ?? 2500, 24, 7);
  }

  /**
   * @param spotlightsAllowed  enable the landing/taxi SpotLights (false in daylight cockpit view)
   */
  update(dt: number, lights: ControlInputs['lights'], spotlightsAllowed: boolean): void {
    this.t += dt;
    if (this.t >= CLOCK_WRAP) this.t -= CLOCK_WRAP * Math.floor(this.t / CLOCK_WRAP);
    const beaconOn = lights.beacon && (this.t % BEACON_PERIOD) < BEACON_ON;
    const sp = this.t % STROBE_PERIOD;
    const strobeOn = lights.strobe && (sp < STROBE_FLASH || (sp >= STROBE_GAP && sp < STROBE_GAP + STROBE_FLASH));
    for (const n of this.nav) n.visible = lights.nav;
    for (const b of this.beacon) b.visible = beaconOn;
    for (const s of this.strobes) s.visible = strobeOn;
    this.landingLight.visible = lights.landing && spotlightsAllowed;
    this.taxiLight.visible = lights.taxi && spotlightsAllowed;
    this.lenses[0].visible = lights.landing;
    this.lenses[1].visible = lights.taxi;
  }

  /** For tests: beacon / strobe currently lit. */
  get beaconLit(): boolean { return this.beacon[0].visible; }
  get strobeLit(): boolean { return this.strobes[0].visible; }
  get navLit(): boolean { return this.nav[0].visible; }
  get clock(): number { return this.t; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.landingLight.dispose();
    this.taxiLight.dispose();
  }
}
