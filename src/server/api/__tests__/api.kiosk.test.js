/* eslint-env jest */
import { execFile } from 'child_process';
import { exitKiosk } from '../api.kiosk';
import isLoopbackAddress from '../../lib/isLoopbackAddress';

jest.mock('child_process', () => ({
  execFile: jest.fn((file, args, callback) => callback(null, '', ''))
}));

jest.mock('../../lib/logger', () => () => ({
  warn: jest.fn(),
  debug: jest.fn()
}));

const makeRes = () => {
  const res = { statusCode: 200, payload: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.send = (payload) => {
    res.payload = payload;
    return res;
  };
  return res;
};

const makeReq = (remoteAddress, extra = {}) => ({
  body: extra.body || {},
  headers: extra.headers || {},
  socket: { remoteAddress },
  connection: { remoteAddress: extra.connectionAddress || remoteAddress }
});

describe('isLoopbackAddress', () => {
  test.each([
    '127.0.0.1',
    '127.0.1.1',
    '127.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:127.0.1.1'
  ])('accepts %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  test.each([
    '192.168.0.233',
    '10.0.0.8',
    '0.0.0.0',
    '::ffff:192.168.0.10',
    'fe80::1',
    '',
    null
  ])('rejects %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('exitKiosk', () => {
  beforeEach(() => {
    execFile.mockClear();
    execFile.mockImplementation((file, args, callback) => callback(null, '', ''));
  });

  test('SIGTERM chromium for a loopback peer and ignores the request body', () => {
    const res = makeRes();
    exitKiosk(makeReq('127.0.0.1', {
      body: { command: 'reboot', process: 'cncjs' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe('pkill');
    expect(args[0]).toBe('-TERM');
    expect(args[args.length - 1]).toBe('chromium');
    expect(args.join(' ')).not.toContain('reboot');
    expect(args.join(' ')).not.toContain('cncjs');
    if (typeof process.getuid === 'function') {
      expect(args).toEqual(['-TERM', '-u', String(process.getuid()), 'chromium']);
    }
  });

  test.each(['::1', '::ffff:127.0.0.1', '127.0.1.1'])('accepts %s', (address) => {
    const res = makeRes();
    exitKiosk(makeReq(address), res);
    expect(res.statusCode).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('returns 403 for a LAN address even if X-Forwarded-For says loopback', () => {
    const res = makeRes();
    exitKiosk(makeReq('192.168.0.50', {
      headers: { 'x-forwarded-for': '127.0.0.1' }
    }), res);

    expect(res.statusCode).toBe(403);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('uses the socket address, not a loopback connection fallback', () => {
    const res = makeRes();
    const req = makeReq('10.1.1.1');
    req.connection.remoteAddress = '127.0.0.1';
    exitKiosk(req, res);

    expect(res.statusCode).toBe(403);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('returns 500 when chromium is not running', () => {
    const error = new Error('No processes matched');
    error.code = 1;
    execFile.mockImplementation((file, args, callback) => callback(error));

    const res = makeRes();
    exitKiosk(makeReq('::1'), res);

    expect(res.statusCode).toBe(500);
    expect(res.payload.msg).toBe('Could not exit kiosk mode.');
  });
});
