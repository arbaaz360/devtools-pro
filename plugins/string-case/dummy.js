const { run } = require("child_process");

const fs = require('fs');

const invalid = JSON.parse(fs.readFileSync('plugins/string-case/fixtures/invalid.json'));
console.log(invalid.length);
