/* eslint-env jest */
import GrblController from '../GrblController';
import { createController } from '../../__tests__/helpers/createController';

const activeControllers = [];

const setup = () => {
  const { controller, writes } = createController(GrblController);
  clearInterval(controller.queryTimer);
  controller.runner.settings.settings.$23 = '3';
  controller.runner.settings.settings.$27 = '2.5';
  controller.runner.settings.settings.$130 = '400';
  controller.runner.settings.settings.$131 = '400';
  controller.machineReference = {
    homeX: -397.5,
    homeY: -397.5,
    homingMask: 3,
    pulloff: 2.5,
    travelX: 400,
    travelY: 400,
  };
  activeControllers.push(controller);
  return { controller, writes };
};

describe('machine-referenced surface probe', () => {
  afterEach(() => {
    while (activeControllers.length > 0) {
      activeControllers.pop().destroy();
    }
  });

  test('positions the grid with G53 at the homed machine coordinate', () => {
    const { controller, writes } = setup();
    controller.command('autolevel:start', {
      startX: 5,
      endX: 5,
      stepX: 1,
      startY: 10,
      endY: 10,
      stepY: 1,
      clearanceZ: 5,
      startZ: 1,
      endZ: -2,
      feedrate: 100,
      probeRetract: 1,
    });
    let guard = 0;
    while (controller.feeder.size() > 0 && guard < 30) {
      controller.feeder.unhold();
      controller.runner.parse('ok');
      guard += 1;
    }
    expect(writes.map(write => write.data)).toContain('G53 G0 X-392.5 Y-387.5\n');
    expect(writes.map(write => write.data)).toContain('G0 Z5\n');
    expect(controller.probeState.probePoints).toEqual([{ x: -392.5, y: -387.5 }]);
  });

  test('changing G54 does not move stored probe points', () => {
    const { controller } = setup();
    controller.probeState.probePoints = [{ x: -392.5, y: -387.5 }];
    controller.probeState.probePhase = 'fine';
    controller.probeState.xyReference = 'machine';
    controller.runner.state.status = {
      mpos: { x: '-392.500', y: '-387.500', z: '0.000' },
      wpos: { x: '0.000', y: '0.000', z: '-5.719' },
    };
    controller.runner.emit('parameters', {
      raw: '[PRB:-392.500,-387.500,-5.719:1]',
      name: 'PRB',
      value: { result: 1, x: '-392.500', y: '-387.500', z: '-5.719' },
    });
    const stored = controller.probeState.probedPositions.map(point => ({ ...point }));
    controller.runner.state.status.wpos = { x: '20.000', y: '30.000', z: '0.000' };
    expect(controller.probeState.probedPositions).toEqual(stored);
    expect(stored[0].x).toBeCloseTo(-392.5, 6);
    expect(stored[0].z).toBe(0);
  });

  test('refuses to run compensated G-code after the work offset changes', () => {
    const { controller, writes } = setup();
    controller.runner.state.status.mpos = { x: '-392.500', y: '-387.500', z: '0.000' };
    controller.runner.state.status.wpos = { x: '10.000', y: '0.000', z: '0.000' };
    const gcode = [
      '; cncjs-autolevel-applied',
      '; cncjs-autolevel-reference-z=0.000000',
      '; cncjs-autolevel-xy=machine',
      '; cncjs-autolevel-wco-xy=-392.500000,-387.500000',
      '; cncjs-autolevel-wcs=G54',
      '; cncjs-autolevel-machine-home=-397.500000,-397.500000',
      '; cncjs-autolevel-homing=3',
      '; cncjs-autolevel-travel-xy=400.000000,400.000000',
      '; cncjs-autolevel-pulloff=2.500000',
      'G1 X0 Y0 Z-1',
    ].join('\n');
    controller.command('gcode:load', 'job.nc', gcode);
    controller.command('gcode:start');
    expect(writes.map(write => write.data).some(line => line.startsWith('G1'))).toBe(false);
    expect(controller.workflow.state).not.toBe('running');
  });
});
