'use strict';
// Ponto de entrada da Vercel (função serverless): reaproveita o mesmo app Express do `npm run dev`.
module.exports = require('../src/server').app;
