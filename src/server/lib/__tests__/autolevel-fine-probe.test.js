/* eslint-env jest */
import {
  fineProbeTargetZ,
  fineProbeTravel,
  surfaceFineProbeTravel,
} from '../autolevel';
import { mm2in } from '../../controllers/utils/units';

describe('Probe Surface fine search', () => {
  test('a 1 mm retract from a Z0 contact targets about Z-1', () => {
    const retract = 1;
    const coarse = 0;
    const travel = surfaceFineProbeTravel(retract);
    const target = fineProbeTargetZ(coarse + retract, travel, -10);

    expect(travel).toBe(2);
    expect(target).toBe(-1);
  });

  test('the fine target never goes past the original coarse end Z', () => {
    const retract = 1;
    const coarse = 0;
    const travel = surfaceFineProbeTravel(retract);
    const calculated = (coarse + retract) - travel;
    const target = fineProbeTargetZ(coarse + retract, travel, -0.5);

    expect(calculated).toBe(-1);
    expect(target).toBe(-0.5);
  });

  test('a 0.2 mm retract still gets 1 mm of margin below the contact', () => {
    const retract = 0.2;
    const travel = surfaceFineProbeTravel(retract);
    const target = fineProbeTargetZ(0 + retract, travel, -10);

    expect(travel).toBeCloseTo(1.2, 4);
    expect(target).toBeCloseTo(-1, 4);
    expect(target).toBeLessThan(0);
  });

  test('inch mode covers the same physical distance as millimetres', () => {
    const retractIn = mm2in(1);
    const travelIn = surfaceFineProbeTravel(retractIn, true);
    const targetIn = fineProbeTargetZ(0 + retractIn, travelIn, -1);

    expect(travelIn * 25.4).toBeCloseTo(2, 2);
    expect(targetIn * 25.4).toBeCloseTo(-1, 2);
  });

  test('touch-plate travel stays at 1.5 times the retract', () => {
    expect(fineProbeTravel(1)).toBe(1.5);
    expect(surfaceFineProbeTravel(1)).toBe(2);
  });
});
