/* eslint-env jest */
import {
  applyProbeCompensation,
  AUTOLEVEL_APPLIED_MARKER,
  AUTOLEVEL_REFERENCE_PREFIX,
} from '../autolevel';
import {
  parseProbeFile,
  readProbeSurfaceFile,
  serializeProbeSurfaceFile,
} from '../../../app/widgets/Autolevel/probeFile';

const surface = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 1 },
  { x: 0, y: 10, z: 0 },
  { x: 10, y: 10, z: 1 },
];

const body = (gcode) => {
  const result = applyProbeCompensation(gcode, surface);
  const lines = result.split('\n');
  expect(lines[0]).toBe(`; ${AUTOLEVEL_APPLIED_MARKER}`);
  expect(lines[1].startsWith(`; ${AUTOLEVEL_REFERENCE_PREFIX}`)).toBe(true);
  return lines.slice(2).join('\n');
};

describe('autolevel safety regressions', () => {
  test('preserves startup Z retract without inventing XY coordinates', () => {
    const result = body('G90\nG0 Z5\nG0 X10 Y0\nG1 Z-1 F100');
    expect(result.split('\n').slice(0, 3)).toEqual(['G90', 'G0 Z5', 'G0 X10.000 Y0.000 Z6.000']);
    expect(result.split('\n').pop()).toContain('Z0.000');
  });

  test.each(['G91', 'G92 X0', 'G28 Z0', 'G55'])('rejects unsupported command %s', (command) => {
    expect(() => applyProbeCompensation(`G0 X0 Y0 Z5\n${command}`, surface)).toThrow('Unsupported');
  });

  test('rejects R-word arcs', () => {
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5\nG03 X10 Y0 R5', surface)).toThrow('R-word');
  });

  test('linearizes G17 arcs into compensated G1 moves', () => {
    const result = body('G17\nG0 X0 Y0 Z0\nG3 X10 Y0 I5 J0 F100');
    const lines = result.split('\n');
    expect(lines.some(line => /^G[23]\b/.test(line))).toBe(false);
    expect(lines.some(line => line.includes('G1') && line.includes('F100'))).toBe(true);
    expect(lines.pop()).toContain('X10.000');
  });

  test('rejects mixed units rather than reinterpreting previous coordinates', () => {
    expect(() => applyProbeCompensation('G21\nG0 X0 Y0 Z5\nG20\nG1 X1', surface)).toThrow('Changing units');
  });

  test('does not report compensation for an invalid surface', () => {
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', [...surface, surface[0]])).toThrow('duplicate');
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', surface.map(p => ({ ...p, z: Infinity })))).toThrow('finite');
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }])).toThrow('surface');
  });

  test('rejects near-duplicate XY that would collide after micron rounding', () => {
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5', [
      ...surface,
      { x: 10.0004, y: 10.0004, z: 5 },
    ])).toThrow('duplicate');
  });

  test('keeps machine-coordinate retracts unchanged', () => {
    expect(body('G0 X0 Y0 Z5\nG53 G0 Z-1').split('\n').pop()).toBe('G53 G0 Z-1');
  });

  test('preserves non-motion words on a zero-length move', () => {
    expect(body('G0 X0 Y0 Z0\nG1 X0 Y0 Z0 F100 M3').split('\n').pop()).toBe('G1 F100 M3');
  });

  test('does not repeat spindle commands when subdividing', () => {
    expect(body('G0 X0 Y0 Z0\nG1 X10 Y0 F100 M3').match(/M3/g)).toHaveLength(1);
  });

  test('accepts negative-coordinate maps and retains the sign', () => {
    const map = surface.map(p => ({ ...p, y: p.y - 10 }));
    const result = applyProbeCompensation('G0 X10 Y-5 Z0', map);
    expect(result).toBe(`; ${AUTOLEVEL_APPLIED_MARKER}\n; ${AUTOLEVEL_REFERENCE_PREFIX}0.000000\nG0 X10.000 Y-5.000 Z1.000`);
  });

  test('rejects G4 mixed with XYZ instead of desyncing pose tracking', () => {
    expect(() => applyProbeCompensation('G0 X0 Y0 Z5\nG0 X10 Y0 Z5 G4 P0\nG1 X10 Y10 Z0 F100', surface))
      .toThrow('G4 with XYZ');
  });

  test('allows pure G4 dwell lines', () => {
    expect(body('G0 X0 Y0 Z5\nG4 P1\nG1 X10 Y0 Z0 F100').split('\n')).toContain('G4 P1');
  });

  test('does not inject G0 into subdivided bare-XYZ continuations', () => {
    const lines = body('G1 X0 Y0 Z0 F100\nX10 Y0 Z0').split('\n');
    expect(lines.some(line => /^G0\b/.test(line))).toBe(false);
    expect(lines.filter(line => line.startsWith('X') || line.startsWith('G1'))).toEqual(expect.arrayContaining([
      'G1 F100 X0.000 Y0.000 Z0.000',
    ]));
    // Continuations after the first segment must stay bare or G1 — never invent G0.
    expect(lines.join('\n')).toMatch(/X10\.000 Y0\.000 Z1\.000/);
  });

  test('clamps out-of-map XY to the nearest edge height', () => {
    const map = [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 1 },
      { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 20, y: 10, z: 1 },
    ];
    const result = applyProbeCompensation('G0 X50 Y0 Z0', map);
    expect(result).toBe(`; ${AUTOLEVEL_APPLIED_MARKER}\n; ${AUTOLEVEL_REFERENCE_PREFIX}0.000000\nG0 X50.000 Y0.000 Z1.000`);
  });

  test('refuses to apply compensation twice', () => {
    const once = applyProbeCompensation('G0 X10 Y0 Z0', surface);
    expect(once.startsWith(`; ${AUTOLEVEL_APPLIED_MARKER}`)).toBe(true);
    expect(() => applyProbeCompensation(once, surface)).toThrow('already autolevel-compensated');
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

  test('round-trips a normalized map without subtracting probe height again', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 70, y: 0, z: -0.099 },
      { x: 140, y: 0, z: -0.152 },
    ];
    const text = serializeProbeSurfaceFile(points, { normalized: true, probeHeightMm: 1.653 });
    const loaded = readProbeSurfaceFile(text);
    const again = readProbeSurfaceFile(serializeProbeSurfaceFile(loaded.points, {
      normalized: loaded.normalized,
      probeHeightMm: loaded.probeHeightMm,
    }));

    expect(text.startsWith('; cncjs-probe-surface-normalized\n; probe-height=1.653000\n; z-values=surface-relative-to-work-zero\n')).toBe(true);
    expect(loaded.normalized).toBe(true);
    expect(loaded.probeHeightMm).toBeCloseTo(1.653, 6);
    expect(loaded.points).toEqual(points);
    expect(again.points).toEqual(points);
  });

  test('a file with no normalization marker stays a legacy raw map', () => {
    const text = '0 0 1.653 0 0 0 0 0 0\n70 0 1.554 0 0 0 0 0 0\n140 0 1.501 0 0 0 0 0 0\n';
    const loaded = readProbeSurfaceFile(text);

    expect(loaded.normalized).toBe(false);
    expect(loaded.probeHeightMm).toBe(null);
    expect(loaded.points.map(point => point.z)).toEqual([1.653, 1.554, 1.501]);
  });
});
