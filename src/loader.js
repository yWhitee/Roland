const fs = require('node:fs');
const path = require('node:path');

module.exports = (dir) =>
  fs.readdirSync(dir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => require(path.join(dir, file)));
