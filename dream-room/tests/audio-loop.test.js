import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeamlessLoop } from '../public/audio-loop.js';

const context = {
  createBuffer(numberOfChannels, length, sampleRate) {
    const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return { numberOfChannels, length, sampleRate, duration: length / sampleRate,
      getChannelData(channel) { return channels[channel]; } };
  }
};
function input(channels, sampleRate = 1000) {
  const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((samples, index) => buffer.getChannelData(index).set(samples));
  return buffer;
}
const near = (a, b) => assert(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('stereo loop uses natural neighboring source samples at both joins', () => {
  const source = input([
    Array.from({ length: 1000 }, (_, i) => .1 + i / 10000),
    Array.from({ length: 1000 }, (_, i) => -.1 - i / 20000)
  ]);
  const before = source.getChannelData(0).slice();
  const output = createSeamlessLoop(context, source);
  assert.equal(output.numberOfChannels, 2);
  assert.equal(output.sampleRate, 1000);
  assert.equal(output.length, 600);
  for (let channel = 0; channel < 2; channel++) {
    const original = source.getChannelData(channel);
    const samples = output.getChannelData(channel);
    assert.equal(samples[0], original[600]);
    assert.equal(samples.at(-1), original[599]);
    near(samples[0] - samples.at(-1), original[600] - original[599]);
    assert.equal(samples[399], original[399]);
    assert.equal(samples[400], original[400]);
    near(samples[400] - samples[399], original[400] - original[399]);
  }
  assert.deepEqual(source.getChannelData(0), before, '原聲不可被修改');
});

test('equal-power overlap has no manufactured silence and preserves the middle', () => {
  const source = input([new Float32Array(1000).fill(.2)]);
  const output = createSeamlessLoop(context, source);
  const samples = output.getChannelData(0);
  assert(samples.every(value => value >= .199999 && value <= .283));
  assert(samples[200] > .28, '交疊中央應同時包含頭尾，不可每輪降到零');
  assert.deepEqual(samples.slice(400), source.getChannelData(0).slice(400, 600));
});

test('overlap peaks are limited by one shared gain without changing stereo balance', () => {
  const source = input([new Float32Array(1000).fill(1), new Float32Array(1000).fill(2)]);
  const output = createSeamlessLoop(context, source);
  let peak = 0;
  for (let i = 0; i < output.length; i++) {
    const left = output.getChannelData(0)[i];
    const right = output.getChannelData(1)[i];
    assert(left > 0 && right > 0);
    near(right, left * 2);
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  assert(peak <= .9 && peak > .8999);
});

test('empty and very short source data remain finite, bounded and nonempty when possible', () => {
  for (let length = 0; length < 8; length++) {
    const source = input([new Float32Array(length).fill(.25)]);
    const output = createSeamlessLoop(context, source);
    if (!length) assert.equal(output, source);
    else {
      assert(output.length > 0 && output.length <= length);
      assert(output.getChannelData(0).every(value => Number.isFinite(value) && value > 0 && value <= .9));
    }
  }
});

test('invalid crossfade settings fail explicitly rather than creating corrupt audio', () => {
  const source = input([new Float32Array(8)]);
  assert.throws(() => createSeamlessLoop(context, source, 0), RangeError);
  assert.throws(() => createSeamlessLoop(context, source, Infinity), RangeError);
  assert.throws(() => createSeamlessLoop(context, source, .4, 0), RangeError);
});
