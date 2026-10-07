/* eslint-env jest */
import GrblController from '../GrblController';
import { createController } from '../../__tests__/helpers/createController';
import { applyProbeCompensation } from '../../../lib/autolevel';
import {
  WORKFLOW_STATE_IDLE,
  WORKFLOW_STATE_RUNNING,
} from '../../../lib/Workflow';

const PROGRAM = [
  'G21',
  'G90',
  'G0 X1',
  'G0 X0',
  'M5',
  'M30',
].join('\n');

const MOTION_ONLY = [
  'G21',
  'G90',
  'G0 X10',
].join('\n');

const PLANNER_WAIT = '%wait ; Wait for the planner to empty';
const PLANNER_DWELL = 'G4 P0.5\n';

const TRANSMITTED = [
  'G21\n',
  'G90\n',
  'G0 X1\n',
  'G0 X0\n',
  'M5\n',
  'M30\n',
  PLANNER_DWELL,
];

const activeControllers = [];

const status = (activeState) => (
  `<${activeState}|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>`
);

const createReadyController = () => {
  const { controller, writes } = createController(GrblController);
  controller.ready = true;
  controller.initialized = true;
  activeControllers.push(controller);
  return { controller, writes };
};

const programWrites = (writes) => writes.map((write) => write.data).filter((data) => data.endsWith('\n') && data !== '$G\n');

const loadProgram = (controller, gcode = PROGRAM) => {
  controller.command('gcode:load', 'job.nc', gcode);
};

const replyTo = (controller, line) => {
  if (line.trim() === 'M30' || line.trim() === 'M2') {
    controller.runner.parse('[MSG:Pgm End]');
  }
  controller.runner.parse('ok');
};

const acknowledgeAll = (controller, writes) => {
  let guard = 0;
  while (controller.sender.state.finishTime === 0 && guard < 40) {
    const lines = programWrites(writes);
    const line = lines[controller.sender.state.received];
    if (!line) {
      break;
    }
    replyTo(controller, line);
    guard += 1;
  }
};

const finishWithFreshIdle = (controller) => {
  controller.runner.parse(status('Idle'));
  jest.advanceTimersByTime(250);
  expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
  jest.advanceTimersByTime(750);
  expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
};

describe('Grbl sender tail', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    while (activeControllers.length > 0) {
      activeControllers.pop().destroy();
    }
    jest.useRealTimers();
  });

  test('loads M30 and then the planner wait', () => {
    const { controller } = createReadyController();
    loadProgram(controller);

    expect(controller.sender.state.lines.slice(-3)).toEqual(['M5', 'M30', PLANNER_WAIT]);
    expect(controller.sender.state.total).toBe(7);
  });

  test('the planner-wait acknowledgement ends the sender and Idle settles the workflow', () => {
    const { controller, writes } = createReadyController();
    const ends = [];
    controller.sender.on('end', () => {
      ends.push({
        received: controller.sender.state.received,
        workflow: controller.workflow.state,
      });
    });
    loadProgram(controller);
    controller.command('gcode:start');

    expect(programWrites(writes)).toEqual(TRANSMITTED);
    expect(controller.sender.state.hold).toBe(true);
    expect(controller.sender.state.finishTime).toBe(0);

    TRANSMITTED.slice(0, 5).forEach((line) => {
      replyTo(controller, line);
    });
    expect(ends).toEqual([]);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    replyTo(controller, 'M30');
    expect(ends).toEqual([]);
    expect(controller.sender.state.received).toBe(6);
    expect(controller.sender.state.finishTime).toBe(0);

    replyTo(controller, 'G4 P0.5');

    expect(ends).toEqual([{ received: 7, workflow: WORKFLOW_STATE_RUNNING }]);
    expect(controller.sender.state.received).toBe(7);
    expect(controller.sender.state.hold).toBe(false);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    controller.runner.parse(status('Run'));
    jest.advanceTimersByTime(1000);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(writes.map((write) => write.data)).not.toContain('$G\n');
    expect(writes.map((write) => write.data)).toContain('?');

    finishWithFreshIdle(controller);

    jest.advanceTimersByTime(2000);
    expect(writes.map((write) => write.data)).toContain('$G\n');

    controller.command('gcode:start');
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(controller.sender.state.sent).toBeGreaterThan(0);
    acknowledgeAll(controller, writes);
    expect(controller.sender.state.finishTime).toBeGreaterThan(0);
    finishWithFreshIdle(controller);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
  });

  test('a program with no M30 stays running while Grbl reports Run', () => {
    const { controller, writes } = createReadyController();
    const ends = [];
    controller.sender.on('end', () => {
      ends.push(controller.workflow.state);
    });
    loadProgram(controller, MOTION_ONLY);
    controller.command('gcode:start');

    expect(programWrites(writes)).toEqual(['G21\n', 'G90\n', 'G0 X10\n', PLANNER_DWELL]);
    expect(controller.sender.state.lines).toEqual(['G21', 'G90', 'G0 X10', PLANNER_WAIT]);
    expect(controller.sender.state.hold).toBe(true);

    ['G21', 'G90', 'G0 X10'].forEach((line) => {
      replyTo(controller, line);
    });
    expect(ends).toEqual([]);
    expect(controller.sender.state.finishTime).toBe(0);

    replyTo(controller, 'G4 P0.5');

    expect(ends).toEqual([WORKFLOW_STATE_RUNNING]);
    expect(controller.sender.state.received).toBe(4);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    controller.runner.parse(status('Run'));
    jest.advanceTimersByTime(1000);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);
    expect(controller.runner.state.status.activeState).toBe('Run');

    finishWithFreshIdle(controller);
  });

  test('M2 is acknowledged and the planner wait ends the sender', () => {
    const { controller, writes } = createReadyController();
    loadProgram(controller, 'G0 X1\nM2');
    controller.command('gcode:start');

    expect(controller.sender.state.lines).toEqual(['G0 X1', 'M2', PLANNER_WAIT]);
    expect(programWrites(writes)).toEqual(['G0 X1\n', 'M2\n', PLANNER_DWELL]);
    expect(controller.sender.state.hold).toBe(true);

    replyTo(controller, 'G0 X1');
    replyTo(controller, 'M2');
    expect(controller.sender.state.finishTime).toBe(0);

    replyTo(controller, 'G4 P0.5');
    expect(controller.sender.state.finishTime).toBeGreaterThan(0);
    expect(controller.workflow.state).toBe(WORKFLOW_STATE_RUNNING);

    finishWithFreshIdle(controller);
  });

  test('$G is withheld while the workflow is running or Grbl is not Idle', () => {
    const running = createReadyController();
    loadProgram(running.controller);
    running.controller.command('gcode:start');
    jest.advanceTimersByTime(2000);
    running.controller.runner.parse(status('Run'));
    const polls = running.writes.filter((write) => write.data === '?').length;
    jest.advanceTimersByTime(250);

    expect(running.writes.map((write) => write.data)).not.toContain('$G\n');
    expect(running.writes.filter((write) => write.data === '?').length).toBeGreaterThan(polls);

    const moving = createReadyController();
    moving.controller.runner.parse(status('Run'));
    jest.advanceTimersByTime(1000);
    expect(moving.writes.map((write) => write.data)).not.toContain('$G\n');

    const holding = createReadyController();
    holding.controller.runner.parse(status('Hold:0'));
    jest.advanceTimersByTime(1000);
    expect(holding.controller.runner.isIdle()).toBe(false);
    expect(holding.writes.map((write) => write.data)).not.toContain('$G\n');

    const idle = createReadyController();
    idle.controller.runner.parse(status('Idle'));
    jest.advanceTimersByTime(250);
    expect(idle.controller.workflow.state).toBe(WORKFLOW_STATE_IDLE);
    expect(idle.writes.map((write) => write.data)).toContain('$G\n');
    expect(idle.writes.map((write) => write.data)).toContain('?');
  });

  test('a $G reply is not requested during a job, so the next ok counts for the sender', () => {
    const { controller, writes } = createReadyController();
    loadProgram(controller);
    controller.command('gcode:start');
    jest.advanceTimersByTime(500);

    expect(writes.map((write) => write.data)).not.toContain('$G\n');
    controller.runner.parse('ok');
    expect(controller.sender.state.received).toBe(1);
  });

  test('compensation keeps M5 and M30 and the load appends the planner wait', () => {
    const gcode = [
      'G21',
      'G90',
      'G0 X0 Y0 Z5',
      'G1 X10 Y0 Z0 F100',
      'G0 Z10',
      'G17',
      'M5',
      'M30',
    ].join('\n');
    const compensated = applyProbeCompensation(gcode, [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
    ]);
    const compensatedLines = compensated.split('\n');

    expect(compensatedLines.slice(-3)).toEqual(['G17', 'M5', 'M30']);

    const { controller } = createReadyController();
    loadProgram(controller, compensated);

    expect(controller.sender.state.lines.slice(-4)).toEqual(['G17', 'M5', 'M30', PLANNER_WAIT]);
  });
});
