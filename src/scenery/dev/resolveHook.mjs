// Dev only: resolve extensionless relative imports to .ts files (Vite / tsc "Bundler" style).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/') || specifier.startsWith('file:');
    if (relative && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      for (const ext of ['.ts', '/index.ts']) {
        try { return await next(specifier + ext, context); } catch { /* try the next one */ }
      }
    }
    throw err;
  }
}
