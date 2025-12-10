import { Executor } from './src/server/executor.js';

async function main() {
  const executor = new Executor();

  console.log('Testing analytics libraries in sandbox...\n');

  // Test simple-statistics
  const ssTest = await executor.execute(`
const ss = require('simple-statistics');
const data = [1, 2, 3, 4, 5, 100];
console.log('mean:', ss.mean(data));
console.log('median:', ss.median(data));
console.log('stdDev:', ss.standardDeviation(data).toFixed(2));
`);
  console.log('simple-statistics:', ssTest.success ? 'PASS' : 'FAIL');
  console.log(ssTest.output);
  if (ssTest.error) console.log('Error:', ssTest.error);
  console.log('---');

  // Test mathjs
  const mathjsTest = await executor.execute(`
const math = require('mathjs');
const m = math.matrix([[1, 2], [3, 4]]);
console.log('matrix:', m.toString());
console.log('mean:', math.mean([1,2,3,4,5]));
`);
  console.log('mathjs:', mathjsTest.success ? 'PASS' : 'FAIL');
  console.log(mathjsTest.output);
  if (mathjsTest.error) console.log('Error:', mathjsTest.error);
  console.log('---');

  // Test ml-regression
  const mlTest = await executor.execute(`
const { SimpleLinearRegression } = require('ml-regression');
const x = [0, 1, 2, 3, 4];
const y = [0, 2, 4, 6, 8];
const reg = new SimpleLinearRegression(x, y);
console.log('slope:', reg.slope);
console.log('predict(5):', reg.predict(5));
`);
  console.log('ml-regression:', mlTest.success ? 'PASS' : 'FAIL');
  console.log(mlTest.output);
  if (mlTest.error) console.log('Error:', mlTest.error);
  console.log('---');

  // Test fft-js
  const fftTest = await executor.execute(`
const fft = require('fft-js');
console.log('fft-js keys:', Object.keys(fft).join(', '));
console.log('typeof util:', typeof fft.util);
console.log('typeof fft.fft:', typeof fft.fft);

const signal = [1, 0, 1, 0, 1, 0, 1, 0];
const phasors = fft.fft(signal);
console.log('fft computed, phasor length:', phasors.length);

// Check util functions
if (fft.util && typeof fft.util.fftMag === 'function') {
  const magnitudes = fft.util.fftMag(phasors);
  console.log('first 4 magnitudes:', magnitudes.slice(0, 4).map(m => m.toFixed(2)).join(', '));
} else {
  console.log('util.fftMag not available');
  console.log('util value:', JSON.stringify(fft.util));
}
`);
  console.log('fft-js:', fftTest.success ? 'PASS' : 'FAIL');
  console.log(fftTest.output);
  if (fftTest.error) console.log('Error:', fftTest.error);
}

main().catch(console.error);
