/**
 * Shared memoised labels for the G1000 widgets, so tape ticks and readouts redrawn at 30 Hz reuse
 * string instances instead of formatting new ones every frame.
 */
import { formatBaroInHg, formatThousands } from '../format';
import { LabelCache } from '../labelCache';

/** Integer → "123". */
export const intLabels = new LabelCache((v) => String(v));
/** Integer with thousands separators → "3,500". */
export const thousandsLabels = new LabelCache((v) => formatThousands(v));
/** Knots → "112KT". */
export const ktLabels = new LabelCache((v) => `${v}KT`);
/** Altimeter setting → "29.92IN". */
export const baroInLabels = new LabelCache((v) => `${formatBaroInHg(v)}IN`, 0.01);
/** VSI scale label for ±1 000 / ±2 000 fpm → "1" / "2". */
export const thousandsDigitLabels = new LabelCache((v) => String(Math.abs(v) / 1000), 1000);
/** Negative-aware hundreds for the altitude window: −3 → "-3", 0 → "", 35 → "35". */
export const hundredsLabels = new LabelCache((v) => (v === 0 ? '' : String(v)));
