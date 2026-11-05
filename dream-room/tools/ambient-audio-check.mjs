import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createAmbientBuffer } from '../public/audio-engine.js';

const context = {
  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return { numberOfChannels, length, sampleRate, duration: length / sampleRate,
      getChannelData(channel) { return channels[channel]; } };
  }
};

function inspect(buffer) {
  const samples = buffer.getChannelData(0);
  const lowRate = 1 - Math.exp(-Math.PI * 2 * 180 / buffer.sampleRate);
  const midRate = 1 - Math.exp(-Math.PI * 2 * 1200 / buffer.sampleRate);
  let sum = 0, energy = 0, peak = 0, stepEnergy = 0, lowEnergy = 0, middleEnergy = 0;
  let low = 0, middle = 0, blockEnergy = 0;
  const blockLevels = [];
  const blockLength = Math.round(buffer.sampleRate / 4);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    assert(Number.isFinite(sample), `樣本${i}不是有限數值`);
    sum += sample;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (i) stepEnergy += (sample - samples[i - 1]) ** 2;
    low += lowRate * (sample - low);
    middle += midRate * (sample - middle);
    lowEnergy += low * low;
    middleEnergy += (middle - low) ** 2;
    blockEnergy += sample * sample;
    if ((i + 1) % blockLength === 0) {
      blockLevels.push(Math.sqrt(blockEnergy / blockLength));
      blockEnergy = 0;
    }
  }
  const blockMean = blockLevels.reduce((total, level) => total + level, 0) / blockLevels.length;
  const blockVariance = blockLevels.reduce((total, level) => total + (level - blockMean) ** 2, 0) / blockLevels.length;
  return {
    seconds: buffer.duration, sampleRate: buffer.sampleRate, peak,
    rms: Math.sqrt(energy / samples.length), dc: sum / samples.length,
    seamJump: Math.abs(samples[0] - samples.at(-1)), stepRms: Math.sqrt(stepEnergy / (samples.length - 1)),
    lowFraction: lowEnergy / energy, middleFraction: middleEnergy / energy,
    envelopeVariation: Math.sqrt(blockVariance) / blockMean
  };
}

const buffers = new Map();
const measurements = {};
for (const kind of ['fire', 'ocean', 'rain', 'stream']) {
  const started = performance.now();
  const buffer = createAmbientBuffer(context, kind);
  const generatedMs = performance.now() - started;
  assert(buffer.numberOfChannels === 1 || buffer.numberOfChannels === 2, '聲音須為單聲道或雙聲道');
  assert(buffer.duration >= 20 && buffer.duration <= 40, '循環應介於20至40秒');
  assert.equal(buffer.length, Math.round(buffer.duration * buffer.sampleRate));
  const result = inspect(buffer);
  assert(result.peak <= 2 && result.peak > .4, `${kind}峰值異常`);
  assert(result.rms >= .28 && result.rms <= .36, `${kind}音量異常`);
  assert(Math.abs(result.dc) < .00001, `${kind}直流偏移過大`);
  assert(result.seamJump < .00001, `${kind}循環接縫不連續`);
  assert(result.stepRms > .01 && result.stepRms < .6, `${kind}缺乏聲音細節或變化過於尖銳`);
  measurements[kind] = { ...result, generatedMs };
  buffers.set(kind, buffer);
}

const levels = Object.values(measurements).map(result => result.rms);
assert(Math.max(...levels) - Math.min(...levels) < .025, '切換聲音時音量落差過大');
assert(measurements.fire.lowFraction > measurements.rain.lowFraction * 2, '柴火應比細雨有更厚的低頻底聲');
assert(measurements.ocean.envelopeVariation > measurements.rain.envelopeVariation * 2, '海浪應有明顯而緩慢的起伏');
assert(measurements.stream.middleFraction > measurements.rain.middleFraction, '溪流應保留較多潺潺中頻細節');

for (const [kind, buffer] of buffers) {
  for (const [other, otherBuffer] of buffers) {
    if (kind >= other) continue;
    const first = buffer.getChannelData(0);
    const second = otherBuffer.getChannelData(0);
    let cross = 0, firstEnergy = 0, secondEnergy = 0;
    for (let i = 0; i < first.length; i += 11) {
      cross += first[i] * second[i];
      firstEnergy += first[i] ** 2;
      secondEnergy += second[i] ** 2;
    }
    assert(Math.abs(cross / Math.sqrt(firstEnergy * secondEnergy)) < .5, `${kind}與${other}波形過於相似`);
  }
}
assert.throws(() => createAmbientBuffer(context, 'unknown'), RangeError);
console.table(Object.fromEntries(Object.entries(measurements).map(([kind, result]) => [kind,
  Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Number(value.toFixed(6))]))])));
console.log('四種合成聲景的樣本、音量、接縫與差異檢查通過；聽感尚待瀏覽器試聽。');
