/**
 * Clickable cockpit (MSFS-style): hovering an instrument on the steam panel shows a tooltip
 * with its live value, the mouse wheel turns its knob and a click operates it. Picks are made
 * by ray-casting the panel mesh and mapping the hit UV into the panel layout.
 *
 * Wheel events over a knob are captured on the container before the input layer's canvas
 * listener sees them, so the camera does not zoom while a knob is being turned.
 *
 * G1000 panel: the hit UV goes to the plugin's `G1000Panel` (instruments/g1000/panel.ts): hover
 * highlights the control and shows its tooltip, click presses a softkey/key or pushes a knob, the
 * wheel turns the knob ring under the pointer (Shift: outer ring). While a G1000 window is open,
 * Enter/Escape (ENT/CLR) and ident letters reach the G1000 before the key bindings.
 */
import * as THREE from 'three';
import type { SimAction } from '../core/types';
import { FPM, FT, INHG, KT, RAD } from '../core/units';
import { C172_STEAM_LAYOUT } from '../instruments/SteamPanel';
import type { G1000PanelLike, Simulator } from './Simulator';

interface Knob {
  id: string;
  title: string;
  /** current value as text */
  value: (sim: Simulator) => string;
  /** action for wheel up / down (one notch) */
  wheel?: [SimAction, SimAction];
  /** action on click (left button); optional upper/lower halves for two-way switches */
  click?: SimAction | ((v: number) => SimAction);
  hint: string;
}

const KNOBS: Record<string, Knob> = {
  alt: { id: 'alt', title: 'Altimeter', value: (s) => `${Math.round(s.snapshot.aircraft.altitudeIndicatedM / FT).toLocaleString()} ft · ${(s.aircraft.qnhSetPa / INHG).toFixed(2)} inHg`, wheel: ['altimeterInc', 'altimeterDec'], click: 'altimeterStd', hint: 'Scroll: Kollsman setting · Click: set local QNH' },
  hi: { id: 'hi', title: 'Heading indicator', value: (s) => `HDG ${pad3(Math.round(s.snapshot.aircraft.headingMagRad * RAD))}° · bug ${pad3(Math.round(s.autopilot.state.headingBugDeg))}°`, wheel: ['headingBugInc', 'headingBugDec'], click: 'apHdgSync', hint: 'Scroll: heading bug · Click: sync bug to heading' },
  asi: { id: 'asi', title: 'Airspeed indicator', value: (s) => `${Math.round(s.snapshot.aircraft.aero.ias / KT)} KIAS`, hint: 'Indicated airspeed' },
  ai: { id: 'ai', title: 'Attitude indicator', value: (s) => `pitch ${(s.snapshot.aircraft.euler[1] * RAD).toFixed(0)}° · bank ${(s.snapshot.aircraft.euler[0] * RAD).toFixed(0)}°`, hint: 'Artificial horizon' },
  vsi: { id: 'vsi', title: 'Vertical speed', value: (s) => `${Math.round(s.snapshot.aircraft.verticalSpeedMs / FPM / 10) * 10} fpm`, hint: 'Rate of climb (lags a few seconds)' },
  tc: { id: 'tc', title: 'Turn coordinator', value: (s) => `${(s.snapshot.aircraft.rates[2] * RAD).toFixed(1)}°/s`, hint: 'Standard-rate mark = 3°/s; centre the ball with rudder' },
  tach: { id: 'tach', title: 'Tachometer', value: (s) => `${Math.round(s.aircraft.engine.rpm / 10) * 10} rpm`, wheel: ['throttleIncSmall', 'throttleDecSmall'], hint: 'Scroll: throttle' },
  flaps: { id: 'flaps', title: 'Flaps', value: (s) => `${Math.round(s.aircraft.surfaces.flapDeg)}°`, wheel: ['flapsUp', 'flapsDown'], click: (v) => (v < 0.5 ? 'flapsUp' : 'flapsDown'), hint: 'Click upper half: up a notch · lower half: down a notch' },
  trim: { id: 'trim', title: 'Elevator trim', value: (s) => `${Math.round(s.snapshot.inputs.pitchTrim * 100)} %`, wheel: ['trimNoseUp', 'trimNoseDown'], hint: 'Scroll: trim nose up / down' },
  radios: { id: 'radios', title: 'NAV 1', value: (s) => `${(s.radios.tuning[0].activeKHz / 1000).toFixed(2)} ↔ ${(s.radios.tuning[0].standbyKHz / 1000).toFixed(2)} · OBS ${pad3(Math.round(s.radios.tuning[0].obsDeg))}°`, wheel: ['nav1Inc', 'nav1Dec'], click: 'nav1Swap', hint: 'Scroll: standby frequency · Click: swap' },
  compass: { id: 'compass', title: 'Magnetic compass', value: (s) => `${pad3(Math.round(s.snapshot.aircraft.headingMagRad * RAD))}°`, hint: 'Wet compass (turning and acceleration errors)' },
  clock: { id: 'clock', title: 'Clock / OAT', value: (s) => `${new Date(s.time.utcMs).toISOString().slice(11, 16)}Z · ${(s.aircraft.atmosphere.temperatureK - 273.15).toFixed(0)} °C`, hint: 'UTC time and outside air temperature' },
  fuelL: { id: 'fuelL', title: 'Fuel left', value: (s) => `${(s.aircraft.fuelKg[0] / 2.725).toFixed(1)} gal`, hint: 'Usable fuel in the left tank' },
  fuelR: { id: 'fuelR', title: 'Fuel right', value: (s) => `${(s.aircraft.fuelKg[1] / 2.725).toFixed(1)} gal`, hint: 'Usable fuel in the right tank' },
  ff: { id: 'ff', title: 'Fuel flow', value: (s) => `${((s.aircraft.engine.fuelFlowKgS * 3600) / 2.725).toFixed(1)} gph`, wheel: ['mixtureInc', 'mixtureDec'], hint: 'Scroll: mixture' },
  egt: { id: 'egt', title: 'EGT', value: (s) => `${Math.round((s.aircraft.engine.egtK - 273.15) * 1.8 + 32)} °F`, wheel: ['mixtureInc', 'mixtureDec'], hint: 'Lean for peak EGT, then enrich slightly' },
  oilT: { id: 'oilT', title: 'Oil temperature', value: (s) => `${Math.round((s.aircraft.engine.oilTempK - 273.15) * 1.8 + 32)} °F`, hint: '' },
  oilP: { id: 'oilP', title: 'Oil pressure', value: (s) => `${Math.round(s.aircraft.engine.oilPressurePa / 6894.76)} psi`, hint: '' },
};

const pad3 = (n: number) => String(((n % 360) + 360) % 360).padStart(3, '0');

export class CockpitInteraction {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly tip: HTMLDivElement;
  private hover: { knob: Knob; v: number } | null = null;
  private lastMove = { x: 0, y: 0, valid: false };
  private glassTip = false;

  constructor(private readonly sim: Simulator, private readonly container: HTMLElement) {
    this.tip = document.createElement('div');
    Object.assign(this.tip.style, {
      position: 'absolute', zIndex: '25', pointerEvents: 'none', display: 'none', padding: '6px 9px', borderRadius: '8px',
      background: 'rgba(10,14,22,.86)', border: '1px solid rgba(255,255,255,.16)', color: '#e8eef6', backdropFilter: 'blur(6px)',
      font: '500 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif', maxWidth: '280px', whiteSpace: 'nowrap',
    } as CSSStyleDeclaration);
    container.appendChild(this.tip);
    container.addEventListener('pointermove', this.onMove, { passive: true });
    container.addEventListener('pointerleave', () => { this.hover = null; this.clearGlass(); this.tip.style.display = 'none'; });
    container.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    container.addEventListener('click', this.onClick, { capture: true });
    window.addEventListener('keydown', this.onKey, { capture: true });
  }

  /** The clickable G1000 panel while it is shown in the cockpit view, else null. */
  private glass(): G1000PanelLike | null {
    const s = this.sim;
    if (!s.inFlight || s.cameras.state.mode !== 'cockpit' || s.panelVariant !== 'g1000' || s.input.isCaptured || document.pointerLockElement !== null) return null;
    return s.plugins.g1000?.interactive ?? null;
  }

  /** Ray-cast the G1000 panel mesh: the hit UV (Three.js convention, v up), or null. */
  private glassUv(clientX: number, clientY: number): THREE.Vector2 | null {
    const canvas = this.sim.gfx.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.sim.cameras.camera);
    const hit = this.ray.intersectObject(this.sim.model.panelMeshG1000, false)[0];
    return hit && hit.uv ? hit.uv : null;
  }

  private clearGlass(): void {
    if (!this.glassTip) return;
    this.glassTip = false;
    this.sim.plugins.g1000?.interactive?.hover(-1, -1);
  }

  /** While a G1000 window or page cursor is open: Enter = ENT, Escape = CLR, letters/digits spell idents. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const s = this.sim;
    if (!s.inFlight || s.cameras.state.mode !== 'cockpit' || s.panelVariant !== 'g1000' || s.input.isCaptured) return;
    const g = s.plugins.g1000?.interactive?.g1000;
    if (!g || !g.wantsKeyboard) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (g.keyboard(e.key)) { e.preventDefault(); e.stopPropagation(); }
  };

  private active(): boolean {
    const s = this.sim;
    return s.inFlight && s.cameras.state.mode === 'cockpit' && s.panelVariant === 'steam' && !s.input.isCaptured && document.pointerLockElement === null;
  }

  private pick(clientX: number, clientY: number): { knob: Knob; v: number } | null {
    if (!this.active()) return null;
    const canvas = this.sim.gfx.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.sim.cameras.camera);
    const hit = this.ray.intersectObject(this.sim.model.panelMesh, false)[0];
    if (!hit || !hit.uv) return null;
    const L = C172_STEAM_LAYOUT;
    const px = hit.uv.x * L.width, py = (1 - hit.uv.y) * L.height;
    for (const it of L.items) {
      if (px >= it.x && px <= it.x + it.size && py >= it.y && py <= it.y + it.size) {
        const knob = KNOBS[it.id];
        if (knob) return { knob, v: (py - it.y) / it.size };
      }
    }
    return null;
  }

  private readonly onMove = (e: PointerEvent): void => {
    this.lastMove = { x: e.clientX, y: e.clientY, valid: true };
    const p = this.glass();
    if (p) {
      const uv = this.glassUv(e.clientX, e.clientY);
      const t = uv ? p.hover(uv.x, uv.y) : p.hover(-1, -1);
      this.glassTip = true;
      this.hover = null;
      if (t) this.show(e.clientX, e.clientY, t.title, '', t.hint); else this.tip.style.display = 'none';
      return;
    }
    this.clearGlass();
    this.hover = this.pick(e.clientX, e.clientY);
    this.render(e.clientX, e.clientY);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    const p = this.glass();
    if (p) {
      const uv = this.glassUv(e.clientX, e.clientY);
      // Shift+wheel arrives as deltaX in Chromium on Windows/Linux
      const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (uv && p.wheel(uv.x, uv.y, dy, { deltaMode: e.deltaMode, outer: e.shiftKey })) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    const h = this.pick(e.clientX, e.clientY);
    if (!h || !h.knob.wheel) return;
    e.preventDefault();
    e.stopPropagation();
    const steps = Math.max(1, Math.min(10, Math.round(Math.abs(e.deltaY) / 50)));
    const a = e.deltaY < 0 ? h.knob.wheel[0] : h.knob.wheel[1];
    for (let i = 0; i < steps; i++) this.sim.input.applyAction(a as never);
    this.hover = h;
    this.render(e.clientX, e.clientY);
  };

  private readonly onClick = (e: MouseEvent): void => {
    const p = this.glass();
    if (p) {
      const uv = this.glassUv(e.clientX, e.clientY);
      if (uv && p.click(uv.x, uv.y)) e.stopPropagation();
      return;
    }
    const h = this.pick(e.clientX, e.clientY);
    if (!h || !h.knob.click) return;
    e.stopPropagation();
    const a = typeof h.knob.click === 'function' ? h.knob.click(h.v) : h.knob.click;
    this.sim.input.applyAction(a as never);
  };

  /** Refresh the tooltip value every frame while hovering (values change with the aircraft). */
  update(): void {
    if (this.glassTip && !this.glass()) { this.clearGlass(); this.tip.style.display = 'none'; }
    if (!this.hover || !this.lastMove.valid) return;
    if (!this.active()) { this.hover = null; this.tip.style.display = 'none'; return; }
    this.render(this.lastMove.x, this.lastMove.y);
  }

  private render(x: number, y: number): void {
    const h = this.hover;
    if (!h) { this.tip.style.display = 'none'; return; }
    this.show(x, y, h.knob.title, h.knob.value(this.sim), h.knob.hint);
  }

  private show(x: number, y: number, title: string, value: string, hint: string): void {
    const r = this.container.getBoundingClientRect();
    this.tip.innerHTML = `<b style="color:#4cc3ff;letter-spacing:.04em">${title}</b> &nbsp;${value}${hint ? `<br><span style="opacity:.7">${hint}</span>` : ''}`;
    this.tip.style.left = `${Math.min(x - r.left + 16, r.width - 290)}px`;
    this.tip.style.top = `${Math.max(y - r.top - 48, 8)}px`;
    this.tip.style.display = 'block';
  }
}
