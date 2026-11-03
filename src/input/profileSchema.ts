/**
 * JSON Schema (draft 2020-12) of a binding profile document, for import/export tooling and
 * documentation. Runtime validation is done by `parseProfile` (bindings.ts), which mirrors it.
 */
import { LOCAL_ACTIONS, SIM_ACTIONS, SIM_AXES } from './actions';

const int = { type: 'integer', minimum: 0, maximum: 63 } as const;

export const BINDING_PROFILE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'flightsim.bindings.profile.v1',
  title: 'Flight sim binding profile',
  type: 'object',
  required: ['version', 'id', 'bindings'],
  properties: {
    version: { const: 1 },
    id: { type: 'string' },
    name: { type: 'string' },
    device: { enum: ['keyboard', 'gamepad'] },
    bindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['device'],
        oneOf: [{ required: ['action'] }, { required: ['axis'] }],
        properties: {
          device: { enum: ['keyboard', 'mouse', 'gamepad'] },
          action: { enum: [...SIM_ACTIONS, ...LOCAL_ACTIONS] },
          axis: { enum: [...SIM_AXES] },
          code: { type: 'string', description: 'KeyboardEvent.code, e.g. "KeyE", "Numpad7"' },
          ctrl: { type: 'boolean' },
          shift: { type: 'boolean' },
          alt: { type: 'boolean' },
          button: { ...int, description: 'MouseEvent.button or gamepad button index' },
          modifierButton: { ...int, description: 'gamepad button that must be held' },
          axisIndex: { ...int, description: 'gamepad axis index' },
          hat: { enum: ['up', 'down', 'left', 'right'] },
          axisDir: { enum: [1, -1], description: 'half of a gamepad axis used as a button' },
          wheel: { type: 'boolean' },
          dir: { enum: [1, -1], description: 'direction a key/button pushes an axis' },
          unipolar: { type: 'boolean', description: 'lever 0..1 (throttle slider)' },
          invert: { type: 'boolean' },
          deadzone: { type: 'number', minimum: 0, maximum: 0.5 },
          saturation: { type: 'number', minimum: 0.5, maximum: 1 },
          curve: { type: 'number', minimum: 0, maximum: 1 },
          sensitivity: { type: 'number', minimum: 0.1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
