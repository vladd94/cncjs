import fs from 'fs';
import path from 'path';
import logger from './logger';

// Walk up to the package that ships the `cncjs` command. Source, dev output,
// and a built install sit at different depths, and that package root is the
// directory the running copy was installed into.
const installRoot = (startDir) => {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && pkg.bin && pkg.bin.cncjs) {
        return dir;
      }
    } catch (err) {
      // Missing or unreadable package.json. Keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir);
    }
    dir = parent;
  }
};

// One physical run. Cleared when the next G-code job starts.
export const PROGRAM_TAIL_LOG_PATH = path.join(installRoot(__dirname), 'cncjs-program-tail.log');

const log = logger('program-tail');
let logPath = PROGRAM_TAIL_LOG_PATH;
let chain = Promise.resolve();
let warned = false;

const fail = (err) => {
  if (warned) {
    return;
  }
  warned = true;
  log.warn(`Program tail log failed: ${err && err.message ? err.message : err}`);
};

// Serializes writes so a clear cannot land after the lines for that job.
// Callers do not wait, and a disk error never rejects into the controller.
const enqueue = (task) => {
  chain = chain.then(task).catch(fail);
};

export const appendProgramTailLog = (message) => {
  try {
    const filePath = logPath;
    const stamp = new Date().toISOString();
    const text = String(message).split('\n').map(line => `${stamp} ${line}`).join('\n') + '\n';
    enqueue(() => fs.promises.appendFile(filePath, text));
  } catch (err) {
    fail(err);
  }
};

export const clearProgramTailLog = () => {
  try {
    const filePath = logPath;
    enqueue(() => fs.promises.writeFile(filePath, ''));
  } catch (err) {
    fail(err);
  }
};

export const flushProgramTailLog = () => chain;

export const setProgramTailLogPath = (filePath) => {
  logPath = filePath || PROGRAM_TAIL_LOG_PATH;
};
