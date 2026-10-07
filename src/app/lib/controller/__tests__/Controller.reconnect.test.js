/* eslint-env jest */
import Controller from '../Controller';

const PORT = '/dev/ttyUSB0';
const OPEN_OPTIONS = {
  controllerType: 'Grbl',
  baudrate: 115200,
  rtscts: false,
  pin: { dtr: null, rts: null },
};

const createMockSocket = () => {
  const handlers = {};
  const socket = {
    connected: true,
    handlers,
    on: jest.fn((eventName, handler) => {
      handlers[eventName] = handlers[eventName] || [];
      handlers[eventName].push(handler);
    }),
    emit: jest.fn(),
    destroy: jest.fn(),
  };
  return socket;
};

const createController = () => {
  const socket = createMockSocket();
  const io = {
    connect: jest.fn(() => socket),
  };
  const controller = new Controller(io);
  controller.connect('', {});
  return { controller, socket, io };
};

const emitSocket = (socket, eventName, ...args) => {
  (socket.handlers[eventName] || []).forEach((handler) => {
    handler(...args);
  });
};

describe('Controller Socket.IO reconnect reattach', () => {
  test('remembers open options and re-emits open on reconnect', () => {
    const { controller, socket } = createController();

    controller.openPort(PORT, OPEN_OPTIONS, jest.fn());
    expect(socket.emit).toHaveBeenCalledWith('open', PORT, OPEN_OPTIONS, expect.any(Function));

    emitSocket(socket, 'serialport:open', {
      port: PORT,
      baudrate: 115200,
      controllerType: 'Grbl',
      inuse: true,
    });

    expect(controller.port).toBe(PORT);
    expect(controller.connectionOptions).toEqual(expect.objectContaining({
      controllerType: 'Grbl',
      baudrate: 115200,
      rtscts: false,
      pin: { dtr: null, rts: null },
    }));

    socket.emit.mockClear();

    // Transient disconnect must keep the remembered serial port.
    emitSocket(socket, 'disconnect');
    expect(controller.port).toBe(PORT);
    expect(controller.connectionOptions).not.toBeNull();

    emitSocket(socket, 'reconnect', 1);

    const openCalls = socket.emit.mock.calls.filter(([eventName]) => eventName === 'open');
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][1]).toBe(PORT);
    expect(openCalls[0][2]).toEqual(expect.objectContaining({
      controllerType: 'Grbl',
      baudrate: 115200,
      rtscts: false,
      pin: { dtr: null, rts: null },
    }));

    const commandEvents = socket.emit.mock.calls
      .filter(([eventName]) => eventName === 'command')
      .map((call) => call[2]);
    expect(commandEvents).not.toEqual(expect.arrayContaining([
      'gcode:start',
      'gcode:resume',
      'cyclestart',
    ]));
  });

  test('initial connect does not emit open when no port was open', () => {
    const { socket } = createController();
    socket.emit.mockClear();

    emitSocket(socket, 'connect');
    emitSocket(socket, 'startup', {
      loadedControllers: ['Grbl'],
      baudrates: [],
      ports: [],
    });

    expect(socket.emit.mock.calls.filter(([eventName]) => eventName === 'open')).toHaveLength(0);
  });

  test('intentional serialport:close clears options and skips reattach', () => {
    const { controller, socket } = createController();

    controller.openPort(PORT, OPEN_OPTIONS, jest.fn());
    emitSocket(socket, 'serialport:open', {
      port: PORT,
      baudrate: 115200,
      controllerType: 'Grbl',
      inuse: true,
    });

    emitSocket(socket, 'serialport:close', { port: PORT });
    expect(controller.port).toBe('');
    expect(controller.connectionOptions).toBeNull();

    socket.emit.mockClear();
    emitSocket(socket, 'reconnect', 1);

    expect(socket.emit.mock.calls.filter(([eventName]) => eventName === 'open')).toHaveLength(0);
  });

  test('Controller.disconnect clears remembered serial state', () => {
    const { controller, socket } = createController();

    controller.openPort(PORT, OPEN_OPTIONS, jest.fn());
    emitSocket(socket, 'serialport:open', {
      port: PORT,
      baudrate: 115200,
      controllerType: 'Grbl',
      inuse: true,
    });

    controller.disconnect();
    expect(controller.port).toBe('');
    expect(controller.connectionOptions).toBeNull();
    expect(controller.socket).toBeNull();
  });

  test('resync from server after reattach can restore idle workflow/state', () => {
    const { controller, socket } = createController();
    const workflowStates = [];
    const controllerStates = [];

    controller.addListener('workflow:state', (state) => {
      workflowStates.push(state);
    });
    controller.addListener('controller:state', (type, state) => {
      controllerStates.push({ type, activeState: state.status && state.status.activeState });
    });

    controller.openPort(PORT, OPEN_OPTIONS, jest.fn());
    emitSocket(socket, 'serialport:open', {
      port: PORT,
      baudrate: 115200,
      controllerType: 'Grbl',
      inuse: true,
    });
    emitSocket(socket, 'workflow:state', 'running');
    emitSocket(socket, 'controller:state', 'Grbl', {
      status: { activeState: 'Run', wpos: { x: 1, y: 2, z: 3 } },
    });

    emitSocket(socket, 'disconnect');
    emitSocket(socket, 'reconnect', 1);

    // Server addConnection pushes authoritative state after reattach.
    emitSocket(socket, 'workflow:state', 'idle');
    emitSocket(socket, 'controller:state', 'Grbl', {
      status: { activeState: 'Idle', wpos: { x: 1, y: 2, z: 3 } },
    });

    expect(controller.workflow.state).toBe('idle');
    expect(controller.state.status.activeState).toBe('Idle');
    expect(workflowStates).toEqual(['running', 'idle']);
    expect(controllerStates.map((entry) => entry.activeState)).toEqual(['Run', 'Idle']);
  });
});
