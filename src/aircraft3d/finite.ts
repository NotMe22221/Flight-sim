/** `x` if it is a finite number, else `fallback`. Guards render-side accumulators against NaN/∞ samples. */
export const finiteOr = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

/** Frame dt sanitised for animation: non-finite or negative → 0 (every accumulator wraps, so no cap). */
export const safeDt = (dt: number): number => (Number.isFinite(dt) && dt > 0 ? dt : 0);
