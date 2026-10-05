import events from 'events';
import http from 'http';
import path from 'path';
import express from 'express';
import multihost from 'multihost';
import serveStatic from 'serve-static';
import logger from './logger';

const log = logger('webappengine');

/**
 * Lightweight replacement for the archived webappengine package.
 * Preserves the createServer({ port, host, backlog, routes }) → EventEmitter API
 * used by CNCjs (ready/error events) without pulling deprecated transitive deps.
 */
const createServer = (options = {}) => {
  const {
    port = 8000,
    host = '0.0.0.0',
    backlog = 511,
    routes = [],
  } = options;

  const eventEmitter = new events.EventEmitter();
  const app = express();

  app.enable('trust proxy');
  app.enable('case sensitive routing');
  app.disable('strict routing');
  app.disable('x-powered-by');

  routes.forEach((routeOptions) => {
    if (routeOptions.type === 'static') {
      app.use(routeOptions.route, serveStatic(path.resolve(routeOptions.directory)));
      log.debug('Served a static directory: %j', routeOptions);
      return;
    }

    try {
      const server = routeOptions.server;

      if (typeof server !== 'function') {
        log.error('The multi-host server does not exist: %j', routeOptions);
        return;
      }

      app.use(multihost({
        hosts: routeOptions.hosts,
        route: routeOptions.route,
        server: server({
          route: routeOptions.route
        })
      }));

      log.debug('Attached a multi-host server: %j', routeOptions);
    } catch (err) {
      log.error(err);
      log.error('The multi-host server does not exist: %j', routeOptions);
    }
  });

  const server = http.createServer(app);

  server.on('error', (err) => {
    eventEmitter.emit('error', err);
  });

  server.setMaxListeners(0);

  server.listen(port, host, backlog, () => {
    eventEmitter.emit('ready', server);
  });

  return eventEmitter;
};

export default createServer;
