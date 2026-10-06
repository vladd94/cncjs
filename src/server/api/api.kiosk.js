import { execFile } from 'child_process';
import isLoopbackAddress from '../lib/isLoopbackAddress';
import logger from '../lib/logger';
import {
  ERR_FORBIDDEN,
  ERR_INTERNAL_SERVER_ERROR
} from '../constants';

const log = logger('api:kiosk');

// Fixed target. The client cannot choose a process, path, or argument.
const exitKioskArgs = () => {
  const args = ['-TERM'];
  if (typeof process.getuid === 'function') {
    args.push('-u', String(process.getuid()));
  }
  args.push('chromium');
  return args;
};

export const exitKiosk = (req, res) => {
  const remoteAddress = (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    '';

  if (!isLoopbackAddress(remoteAddress)) {
    log.warn(`Rejected exit-kiosk from ${remoteAddress || 'unknown'}`);
    res.status(ERR_FORBIDDEN).send({
      msg: 'Forbidden'
    });
    return;
  }

  execFile('pkill', exitKioskArgs(), (err) => {
    if (err) {
      log.warn(`exit-kiosk failed: ${err.message}`);
      res.status(ERR_INTERNAL_SERVER_ERROR).send({
        msg: 'Could not exit kiosk mode.'
      });
      return;
    }

    res.send({ ok: true });
  });
};
