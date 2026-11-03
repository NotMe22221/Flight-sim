/**
 * Minimal replay bar: a "Replay" button during flight, and while replaying a transport bar with
 * play/pause, a scrub slider, playback speed and exit. Plain DOM, styled like the rest of the UI.
 */
import type { ReplayController } from './ReplayController';

const CSS = `
.rp-btn{position:absolute;right:16px;bottom:16px;z-index:30;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);
  background:rgba(10,14,22,.72);backdrop-filter:blur(8px);color:#e8eef6;font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;
  letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
.rp-btn:hover{border-color:#4cc3ff;color:#4cc3ff}
.rp-bar{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:31;display:flex;gap:10px;align-items:center;
  padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(10,14,22,.82);backdrop-filter:blur(10px);
  color:#e8eef6;font:500 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;min-width:min(720px,92vw)}
.rp-bar button{background:none;border:1px solid rgba(255,255,255,.2);color:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit}
.rp-bar button:hover{border-color:#4cc3ff;color:#4cc3ff}
.rp-bar input[type=range]{flex:1;accent-color:#4cc3ff}
.rp-tag{color:#4cc3ff;font-weight:700;letter-spacing:.12em}
.rp-time{font-variant-numeric:tabular-nums;min-width:86px;text-align:right;opacity:.85}
`;

export class ReplayBar {
  private readonly button: HTMLButtonElement;
  private readonly bar: HTMLDivElement;
  private readonly play: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly time: HTMLSpanElement;
  private readonly speed: HTMLButtonElement;
  private scrubbing = false;

  constructor(container: HTMLElement, private readonly rc: ReplayController, private readonly onToggle: (on: boolean) => void) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.button = el('button', 'rp-btn', 'Replay') as HTMLButtonElement;
    this.button.title = 'Replay the last five minutes';
    this.button.onclick = () => { if (this.rc.enter()) this.onToggle(true); };
    this.bar = el('div', 'rp-bar') as HTMLDivElement;
    const tag = el('span', 'rp-tag', 'REPLAY');
    this.play = el('button', '', 'Pause') as HTMLButtonElement;
    this.play.onclick = () => { this.rc.playing = !this.rc.playing; if (this.rc.playing && this.rc.t >= this.rc.end) this.rc.seek(this.rc.start); };
    this.slider = document.createElement('input');
    this.slider.type = 'range'; this.slider.min = '0'; this.slider.max = '1000'; this.slider.value = '0';
    this.slider.oninput = () => { this.scrubbing = true; this.rc.seek(this.rc.start + (Number(this.slider.value) / 1000) * (this.rc.end - this.rc.start)); };
    // drop focus after scrubbing: while a range input has focus the input module ignores flight keys
    this.slider.onchange = () => { this.scrubbing = false; this.slider.blur(); };
    this.time = el('span', 'rp-time', '0:00 / 0:00') as HTMLSpanElement;
    this.speed = el('button', '', '1×') as HTMLButtonElement;
    const speeds = [0.25, 0.5, 1, 2, 4];
    this.speed.onclick = () => { const i = (speeds.indexOf(this.rc.speed) + 1) % speeds.length; this.rc.speed = speeds[i]; this.speed.textContent = `${speeds[i]}×`; };
    const exit = el('button', '', 'Exit') as HTMLButtonElement;
    exit.onclick = () => { this.rc.exit(); this.onToggle(false); };
    this.bar.append(tag, this.play, this.slider, this.time, this.speed, exit);
    this.bar.style.display = 'none';
    this.button.style.display = 'none';
    container.append(this.button, this.bar);
  }

  update(inFlight: boolean): void {
    const rc = this.rc;
    this.button.style.display = inFlight && !rc.active && rc.available ? 'block' : 'none';
    this.bar.style.display = rc.active ? 'flex' : 'none';
    if (!rc.active) return;
    this.play.textContent = rc.playing ? 'Pause' : 'Play';
    const span = Math.max(rc.end - rc.start, 0.001);
    if (!this.scrubbing) this.slider.value = String(Math.round(((rc.t - rc.start) / span) * 1000));
    this.time.textContent = `${fmt(rc.t - rc.start)} / ${fmt(span)}`;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
