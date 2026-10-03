/* eslint-env jest */
import { applyProbeCompensation } from '../autolevel';
import { parseProbeFile } from '../../../app/widgets/Autolevel/probeFile';

const surface = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 1 },
  { x: 0, y: 10, z: 0 },
  { x: 10, y: 10, z: 1 },
];

describe('autolevel safety regressions', () => {
  test('preserves startup Z retract without inventing XY coordinates', () => {
    const result = applyProbeCompensation('G90\nG0 Z5\nG0 X10 Y0\nG1 Z-1 F100', surface);
    expect(result.split('\n').slice(0, 3)).toEqual(['G90', 'G0 Z5', 'G0 X10.000 Y0.000 Z6.000']);
    expect(result.split('\n').pop()).toContain('Z0.000');
  });

  test.each(['G2 X10 Y0 I5 J0', 'G03 X10 Y0 R5', 'G91', 'G92 X0', 'G28 Z0', 'G55'])('rejects unsupported command %s', (command) => {
    expect(() => applyProbeCompensation(`G0 X0 Y0 Z5\n${command}`, surface)).toThrow('Unsupported');
  });

  test('rejects mixed units rather than reinterpreting previous coordinates', () => {
    expect(() => applyProbeCompensation('G21\nG0 X0 Y0 Z5\nG20\nG1 X1', surface)).toThrow('Changing units');
  });

  test('does not report compensation for an invalid surface', () => {
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', [...surface, surface[0]])).toThrow('duplicate');
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', surface.map(p => ({ ...p, z: Infinity })))).toThrow('finite');
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])).toThrow('surface');
  });

  test('keeps machine-coordinate retracts unchanged', () => {
    const result = applyProbeCompensation('G0 X0 Y0 Z5\nG53 G0 Z-1', surface);
    expect(result.split('\n').pop()).toBe('G53 G0 Z-1');
  });

  test('preserves non-motion words on a zero-length move', () => {
    const result = applyProbeCompensation('G0 X0 Y0 Z0\nG1 X0 Y0 Z0 F100 M3', surface);
    expect(result.split('\n').pop()).toBe('G1 F100 M3');
  });

  test('does not repeat spindle commands when subdividing', () => {
    const result = applyProbeCompensation('G0 X0 Y0 Z0\nG1 X10 Y0 F100 M3', surface);
    expect(result.match(/M3/g)).toHaveLength(1);
  });

  test('accepts negative-coordinate maps and retains the sign', () => {
    const map = surface.map(p => ({ ...p, y: p.y - 10 }));
    expect(applyProbeCompensation('G0 X10 Y-5 Z0', map)).toBe('G0 X10.000 Y-5.000 Z1.000');
  });
});

describe('probe file import', () => {
  test('reads CNCjs nine-column data including negative coordinates and CRLF', () => {
    expect(parseProbeFile('0 -10 0 0 0 0 0 0 0\r\n10 -10 1 0 0 0 0 0 0\r\n0 0 0 0 0 0 0 0 0\r\n')).toEqual([
      { x: 0, y: -10, z: 0 }, { x: 10, y: -10, z: 1 }, { x: 0, y: 0, z: 0 },
    ]);
  });
  test.each(['', '1 2', '1 2 NaN', '1 2 Infinity', 'G0 X0 Y0'])('rejects unusable file %s', (text) => {
    expect(() => parseProbeFile(text)).toThrow();
  });
});
