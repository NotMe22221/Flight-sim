/**
 * Annunciator panel: red warnings on the top row, amber cautions below. Lit cells are bright with
 * dark text; unlit cells show dim text so the pilot can read the legend (press-to-test look).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

interface Cell { label: string; color: string; lit: (r: InstrumentReadings) => boolean }

const CELLS: Cell[][] = [
  [
    { label: 'LOW VOLTS', color: GAUGE_COLORS.red, lit: (r) => r.annunciators.lowVolts },
    { label: 'OIL PRESS', color: GAUGE_COLORS.red, lit: (r) => r.annunciators.oilPress },
    { label: 'STALL', color: GAUGE_COLORS.red, lit: (r) => r.annunciators.stallWarn },
  ],
  [
    { label: 'L LOW FUEL', color: GAUGE_COLORS.yellow, lit: (r) => r.annunciators.lowFuelL },
    { label: 'R LOW FUEL', color: GAUGE_COLORS.yellow, lit: (r) => r.annunciators.lowFuelR },
    { label: 'LOW VAC', color: GAUGE_COLORS.yellow, lit: (r) => r.annunciators.vacuum },
  ],
];

export class Annunciators extends Gauge {
  override readonly aspect = 0.3;
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, size, h);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect, pad = size * 0.012;
    const cols = CELLS[0].length, rows = CELLS.length;
    const cw = (size - pad * (cols + 1)) / cols, ch = (h - pad * (rows + 1)) / rows;
    const font = gaugeFont(ch * 0.36, true);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const cell = CELLS[i][j];
        const x = -size / 2 + pad + j * (cw + pad), y = -h / 2 + pad + i * (ch + pad);
        const lit = cell.lit(r);
        ctx.fillStyle = lit ? cell.color : '#141416';
        ctx.fillRect(x, y, cw, ch);
        drawText(ctx, cell.label, x + cw / 2, y + ch / 2, font, lit ? '#111' : '#3c3c40');
      }
    }
  }
}
