/**
 * PFD attitude indicator: sky/ground horizon rotating about (512, 330), pitch ladder at 4 px/°,
 * fixed roll scale with sky pointer + slip/skid bar, extreme-pitch chevrons, single-cue flight
 * director and the yellow aircraft symbol. Draws nothing but a red X when the AHRS is invalid.
 */
import { clamp } from '../../core/math';
import { DEG, RAD } from '../../core/units';
import type { AutopilotState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { G, PFD, cond } from './palette';
import { intLabels } from './labels';
import { redX, text } from './widgets';

const ROLL_TICKS = [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60];

export function drawAttitude(ctx: Ctx2D, r: InstrumentReadings, ap: AutopilotState): void {
  const { attCx: cx, attCy: cy, attRollR: R, attPxPerDeg: k } = PFD;
  const left = PFD.attLeft, right = PFD.attRight, top = PFD.attTop, bottom = PFD.attBottom;
  if (!r.ahrs.valid) {
    ctx.fillStyle = G.black; ctx.fillRect(left, top, right - left, bottom - top);
    redX(ctx, left, top, right - left, bottom - top);
    text(ctx, 'ATTITUDE FAIL', cx, cy, cond.get(28), G.red, 'center');
    return;
  }
  const roll = r.ahrs.rollDeg * DEG, pitch = r.ahrs.pitchDeg;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll);
  const hy = pitch * k; // horizon y below centre for nose-up pitch
  const big = 1400;
  ctx.fillStyle = G.sky; ctx.fillRect(-big, hy - big, big * 2, big);
  ctx.fillStyle = G.ground; ctx.fillRect(-big, hy, big * 2, big);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-big, hy); ctx.lineTo(big, hy); ctx.stroke();
  // pitch ladder (±45° drawn, viewport clips)
  ctx.font = cond.get(16); ctx.fillStyle = G.white; ctx.textBaseline = 'middle';
  for (let p = -45; p <= 45; p += 5) {
    if (p === 0) continue;
    const y = hy - p * k;
    if (Math.abs(y) > 260) continue;
    const major = p % 10 === 0;
    const w = major ? 60 : 30;
    ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
    if (major) {
      const lbl = intLabels.get(Math.abs(p));
      ctx.textAlign = 'right'; ctx.fillText(lbl, -w - 6, y);
      ctx.textAlign = 'left'; ctx.fillText(lbl, w + 6, y);
    }
  }
  // extreme pitch chevrons pointing at the horizon
  if (pitch >= 30) chevrons(ctx, hy - 50 * k, 1);
  if (pitch <= -15) chevrons(ctx, hy + 30 * k, -1);
  // sky pointer + slip/skid bar rotate with the horizon
  ctx.beginPath(); ctx.moveTo(0, -R + 2); ctx.lineTo(-12, -R + 24); ctx.lineTo(12, -R + 24); ctx.closePath();
  ctx.fillStyle = G.white; ctx.fill();
  const slip = clamp(r.turn.ballWidths, -1.5, 1.5) * 18;
  ctx.fillRect(-18 + slip, -R + 28, 36, 8);
  ctx.restore();
  // fixed roll scale
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (const t of ROLL_TICKS) {
    const a = (t - 90) * DEG, len = Math.abs(t) === 30 || Math.abs(t) === 60 ? 22 : 12;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R + len), Math.sin(a) * (R + len)); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(-12, -R - 20); ctx.lineTo(12, -R - 20); ctx.closePath();
  ctx.fillStyle = G.white; ctx.fill();
  // flight director single cue (inverted V) when FD or AP is on
  if (ap.flightDirector || ap.engaged) {
    const dp = (ap.fdPitchRad * RAD - pitch) * k;
    const dr = ap.fdRollRad - roll;
    ctx.save();
    ctx.translate(0, -clamp(dp, -150, 150));
    ctx.rotate(-clamp(dr, -60 * DEG, 60 * DEG));
    ctx.strokeStyle = G.magenta; ctx.lineWidth = 6; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-70, 30); ctx.lineTo(0, 0); ctx.lineTo(70, 30); ctx.stroke();
    ctx.restore();
  }
  // aircraft symbol: yellow wedge + wingtips
  ctx.fillStyle = G.yellow; ctx.strokeStyle = G.black; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-60, 34); ctx.lineTo(-44, 34); ctx.lineTo(0, 12); ctx.lineTo(44, 34); ctx.lineTo(60, 34); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillRect(-150, -3, 50, 6); ctx.strokeRect(-150, -3, 50, 6);
  ctx.fillRect(100, -3, 50, 6); ctx.strokeRect(100, -3, 50, 6);
  ctx.restore();
}

function chevrons(ctx: Ctx2D, y: number, dir: 1 | -1): void {
  ctx.strokeStyle = G.red; ctx.lineWidth = 5;
  for (let i = 0; i < 2; i++) {
    const yy = y - dir * i * 30;
    ctx.beginPath(); ctx.moveTo(-50, yy - dir * 20); ctx.lineTo(0, yy); ctx.lineTo(50, yy - dir * 20); ctx.stroke();
  }
}
