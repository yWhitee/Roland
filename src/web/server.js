const http = require('node:http');

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
};

const escape = (text) => String(text).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const render = ({ title, lines, success }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} | Roland</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1e1f22; color: #dbdee1; font-family: system-ui, sans-serif; }
main { max-width: 480px; margin: 16px; padding: 32px; border-radius: 12px; background: #2b2d31; border-top: 4px solid ${success ? '#57f287' : '#ed4245'}; }
h1 { margin-top: 0; font-size: 1.4rem; color: #fff; }
p { line-height: 1.5; margin: 0.4rem 0; min-height: 0.5rem; }
small { display: block; margin-top: 1.5rem; color: #949ba4; }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
${lines.map((line) => `<p>${escape(line)}</p>`).join('\n')}
<small>You can close this tab and return to Discord.</small>
</main>
</body>
</html>`;

const createServer = (routes) =>
  http.createServer(async (request, response) => {
    const send = (page, headers = {}) => {
      response.writeHead(page.status, { ...HEADERS, ...headers });
      response.end(request.method === 'HEAD' ? undefined : render(page));
    };

    try {
      const url = new URL(request.url, 'http://localhost');
      const route = routes[url.pathname];
      if (!route) return send({ status: 404, title: 'Not found', lines: ['This page does not exist.'] });
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return send({ status: 405, title: 'Method not allowed', lines: ['Only GET requests are supported.'] }, { allow: 'GET, HEAD' });
      }
      return send(await route(url.searchParams));
    } catch (error) {
      console.error(`OAuth callback error: ${error.message}`);
      return send({ status: 500, title: 'Something went wrong', lines: ['An unexpected error occurred. Please try again later.'] });
    }
  });

const start = (routes, { port, host }) =>
  new Promise((resolve) => {
    const server = createServer(routes);
    server.once('error', (error) => {
      console.error(`Failed to start the OAuth callback server on ${host}:${port}: ${error.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      console.log(`OAuth callback server listening on http://${host}:${server.address().port}`);
      resolve(server);
    });
  });

module.exports = { createServer, start };
