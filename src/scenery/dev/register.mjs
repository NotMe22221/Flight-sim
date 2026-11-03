// Dev only: lets Node run the TypeScript fixture generator with extensionless imports.
//   node --experimental-transform-types --import ./src/scenery/dev/register.mjs src/scenery/dev/generateFixtures.ts [outDir]
import { register } from 'node:module';

register('./resolveHook.mjs', import.meta.url);
