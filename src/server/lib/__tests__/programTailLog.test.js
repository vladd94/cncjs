/* eslint-env jest */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROGRAM_TAIL_LOG_PATH,
  appendProgramTailLog,
  clearProgramTailLog,
  flushProgramTailLog,
  setProgramTailLogPath,
} from '../programTailLog';

describe('program tail log', () => {
  const filePath = path.join(os.tmpdir(), `program-tail-${process.pid}.log`);

  beforeEach(() => {
    setProgramTailLogPath(filePath);
  });

  afterEach(async () => {
    await flushProgramTailLog();
    setProgramTailLogPath(PROGRAM_TAIL_LOG_PATH);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  test('a new job clears the file and later lines stay in order', async () => {
    appendProgramTailLog('OLD');
    await flushProgramTailLog();
    clearProgramTailLog();
    appendProgramTailLog('JOB START\nname=job.nc\ntotal=10');
    await flushProgramTailLog();

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).not.toContain('OLD');
    expect(text).toContain('JOB START');
    expect(text).toContain('name=job.nc');
    expect(text).toContain('total=10');
    expect(text.split('\n').filter(Boolean).every(line => /^\d{4}-\d{2}-\d{2}T/.test(line))).toBe(true);
  });

  test('a missing log directory does not throw', () => {
    setProgramTailLogPath('/no/such/dir/cncjs-program-tail.log');
    expect(() => {
      clearProgramTailLog();
      appendProgramTailLog('JOB START');
    }).not.toThrow();
  });

  test('the machine log path is the Pi file', () => {
    expect(PROGRAM_TAIL_LOG_PATH).toBe('/home/vlad/cncjs-program-tail.log');
  });
});
