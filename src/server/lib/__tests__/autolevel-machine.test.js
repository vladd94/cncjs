/* eslint-env jest */
import {
  applyProbeCompensation,
  compensationDriftError,
  homeRelativeToMachineMm,
  planMachineProbePoints,
  readProbeSurfaceFile,
  serializeProbeSurfaceFile,
} from '../autolevel';

const HOME = { homeX: -397.5, homeY: -397.5, homingMask: 3, travelX: 400, travelY: 400, pulloff: 2.5 };

const machineMap = () => {
  const points = planMachineProbePoints({
    startX: 5,
    endX: 15,
    stepX: 10,
    startY: 10,
    endY: 20,
    stepY: 10,
    reference: HOME,
  }).map((point, index) => ({ ...point, z: index === 0 ? 0 : -0.2 }));
  return points;
};

describe('machine-referenced probe area', () => {
  test('Start X5 Y10 is inward from a negative homed position', () => {
    const points = planMachineProbePoints({
      startX: 5,
      endX: 5,
      stepX: 1,
      startY: 10,
      endY: 10,
      stepY: 1,
      reference: HOME,
    });
    expect(points).toEqual([{ x: -392.5, y: -387.5 }]);
    expect(homeRelativeToMachineMm({ homeX: 0, homeY: 0, homingMask: 0 }, 5, 10)).toEqual({ x: -5, y: -10 });
  });

  test('a mismatched travel setting is refused instead of inventing the home position', () => {
    expect(() => planMachineProbePoints({
      startX: 5,
      endX: 5,
      stepX: 1,
      startY: 10,
      endY: 10,
      stepY: 1,
      reference: { ...HOME, travelX: 300 },
    })).toThrow(/does not match the travel settings/);
  });

  test('the same physical cut gets the same correction under two work origins', () => {
    const probeData = machineMap();
    const atFirst = applyProbeCompensation('G90\nG1 X0 Y0 Z-1', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -392.5,
      wcoY: -387.5,
      activeWcs: 'G54',
      machineReference: HOME,
    });
    const shifted = applyProbeCompensation('G90\nG1 X7.5 Y2.5 Z-1', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -400,
      wcoY: -390,
      activeWcs: 'G54',
      machineReference: HOME,
    });
    expect(atFirst).toContain('X0.000 Y0.000 Z-1.000');
    expect(shifted).toContain('X7.500 Y2.500 Z-1.000');
    expect(atFirst).toContain('cncjs-autolevel-wco-xy=-392.500000,-387.500000');
  });

  test('a cut outside the measured machine area is rejected with both bounds', () => {
    const probeData = machineMap();
    expect(() => applyProbeCompensation('G90\nG1 X100 Y0 Z-1', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -392.5,
      wcoY: -387.5,
      machineReference: HOME,
    })).toThrow(/Measured machine bounds X-392.500\.\.-382.500 Y-387.500\.\.-377.500/);
  });

  test('a saved machine map keeps its reference and a legacy map is not treated as one', () => {
    const probeData = machineMap();
    const text = serializeProbeSurfaceFile(probeData, {
      normalized: true,
      probeHeightMm: 9,
      xyReference: 'machine',
      machineReference: HOME,
    });
    const loaded = readProbeSurfaceFile(text);
    expect(text).toContain('cncjs-probe-xy=machine');
    expect(loaded.xyReference).toBe('machine');
    expect(loaded.machineReference.homeX).toBeCloseTo(-397.5, 6);
    expect(loaded.points[0]).toEqual(probeData[0]);

    const legacy = readProbeSurfaceFile('0 0 0 0 0 0 0 0 0\n10 0 0 0 0 0 0 0 0\n0 10 0 0 0 0 0 0 0\n');
    expect(legacy.xyReference).toBe('work');
    expect(legacy.machineReference).toBe(null);
  });

  test('inch programs convert into the millimetre machine map', () => {
    const probeData = machineMap();
    const result = applyProbeCompensation('G20\nG1 X0 Y0 Z-0.03937', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -392.5,
      wcoY: -387.5,
      machineReference: HOME,
    });
    expect(result).toContain('X0.000 Y0.000 Z-0.039');
  });

  test('an arc inside the machine map keeps its programmed XY', () => {
    const probeData = machineMap();
    const result = applyProbeCompensation('G90\nG0 X0 Y0 Z1\nG2 X10 Y0 I5 J0 Z-0.2', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -392.5,
      wcoY: -387.5,
      machineReference: HOME,
    });
    expect(result).toContain('X0.000 Y0.000');
    expect(result).toContain('X10.000 Y0.000');
    expect(result).not.toContain('G53');
  });

  test('a changed work offset after compensation is rejected', () => {
    const probeData = machineMap();
    const gcode = applyProbeCompensation('G90\nG1 X0 Y0 Z-1', probeData, {
      normalized: true,
      xyReference: 'machine',
      wcoX: -392.5,
      wcoY: -387.5,
      activeWcs: 'G54',
      machineReference: HOME,
    });
    expect(compensationDriftError(gcode, {
      wco: { x: -392.5, y: -387.5 },
      wcs: 'G54',
      machineReference: HOME,
    })).toBe(null);
    expect(compensationDriftError(gcode, {
      wco: { x: -390, y: -387.5 },
      wcs: 'G54',
      machineReference: HOME,
    })).toMatch(/Work offset changed/);
    expect(compensationDriftError(gcode, {
      wco: { x: -392.5, y: -387.5 },
      wcs: 'G54',
      machineReference: { ...HOME, travelX: 410 },
    })).toMatch(/travel settings changed/);
  });
});
