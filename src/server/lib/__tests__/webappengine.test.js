/* eslint-env jest */
import http from 'http';
import express from 'express';
import webappengine from '../webappengine';

const listen = (options) => new Promise((resolve, reject) => {
  const ee = webappengine(options);
  ee.on('ready', (server) => resolve({ ee, server }));
  ee.on('error', reject);
});

const request = (port, path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      resolve({ statusCode: res.statusCode, body });
    });
  }).on('error', reject);
});

describe('webappengine', () => {
  let server;

  afterEach((done) => {
    if (!server) {
      done();
      return;
    }
    server.close(() => {
      server = null;
      done();
    });
  });

  it('should mount a server app and emit ready', async () => {
    ({ server } = await listen({
      port: 0,
      host: '127.0.0.1',
      routes: [{
        type: 'server',
        route: '/',
        server: () => {
          const app = express();
          app.get('/ping', (req, res) => {
            res.send('pong');
          });
          return app;
        }
      }]
    }));

    const port = server.address().port;
    const res = await request(port, '/ping');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('pong');
  });

  it('should serve static directories', async () => {
    ({ server } = await listen({
      port: 0,
      host: '127.0.0.1',
      routes: [{
        type: 'static',
        route: '/static',
        directory: __dirname
      }]
    }));

    const port = server.address().port;
    const res = await request(port, '/static/webappengine.test.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('webappengine');
  });
});
