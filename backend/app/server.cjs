// Local-only development server. Bind only to loopback; no third-party packages.
const { createHttpServer } = require('./api/http-server.cjs');

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const server = createHttpServer({ port });
  server.listen(port, '127.0.0.1', () => console.log('Stock intent workbench listening on http://127.0.0.1:' + port));
  server.on('error', error => { console.error('Server start failed: ' + error.code); process.exitCode = 1; });
}

module.exports = { createHttpServer };
