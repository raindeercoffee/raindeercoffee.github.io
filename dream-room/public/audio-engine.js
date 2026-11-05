// 白噪音及舊合成聲景。前端負責音量、淡出與停止；三種環境聲改用實際音檔。
const SAMPLE_RATE = 22_050;
const DURATION = 32;
const SEEDS = { noise: 0x6d2b79f5, fire: 0x41c6ce57, ocean: 0x29a47d13, rain: 0x56e38b91, stream: 0x73d185ab };
const TAU = Math.PI * 2;

function randomSource(seed) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function finishLoop(raw, output, overlap) {
  const length = output.length;
  output.set(raw.subarray(0, length));
  // 尾端延伸與開頭等能量交疊，避免循環處突然換成另一段噪音。
  for (let i = 0; i < overlap; i++) {
    const angle = i / (overlap - 1) * Math.PI / 2;
    output[i] = raw[length + i] * Math.cos(angle) + raw[i] * Math.sin(angle);
  }
  // 以極短、平滑的修正接齊端點；不把整段聲音淡至無聲。
  const correction = output[length - 1] - output[0];
  for (let i = 0; i < 128; i++) output[i] += correction * (1 - i / 128) ** 2;

  let mean = 0;
  for (const sample of output) mean += sample;
  mean /= length;
  let energy = 0;
  for (const sample of output) energy += (sample - mean) ** 2;
  const level = .36 / Math.sqrt(energy / length);
  let finalMean = 0;
  // 柔性限制偶發峰值，保留火花與水滴的細節。
  for (let i = 0; i < length; i++) {
    output[i] = Math.tanh((output[i] - mean) * level);
    finalMean += output[i];
  }
  finalMean /= length;
  let finalEnergy = 0;
  let peak = 0;
  for (const sample of output) {
    const centered = sample - finalMean;
    finalEnergy += centered * centered;
    peak = Math.max(peak, Math.abs(centered));
  }
  const scale = Math.min(.32 / Math.sqrt(finalEnergy / length), 1.6 / peak);
  for (let i = 0; i < length; i++) output[i] = (output[i] - finalMean) * scale;
  output[0] = output[length - 1];
}

export function createAmbientBuffer(context, kind) {
  if (!Object.hasOwn(SEEDS, kind)) throw new RangeError('未知的環境音種類');
  const length = SAMPLE_RATE * DURATION;
  const overlap = Math.round(SAMPLE_RATE * .15);
  const raw = new Float32Array(length + overlap);
  const random = randomSource(SEEDS[kind]);
  const coefficient = hz => 1 - Math.exp(-TAU * hz / SAMPLE_RATE);
  const bassRate = coefficient(90);
  const bodyRate = coefficient(650);
  const softRate = coefficient(2600);
  const airRate = coefficient(6200);
  let bass = 0, body = 0, soft = 0, air = 0;
  let nextDetail = Math.round(SAMPLE_RATE * .12);
  let detailEnvelope = 0, detailTarget = 0, detailPhase = 0, detailPitch = 1600;
  let detailDecay = .99;
  let voiceIndex = 0;
  const voices = Array.from({ length: 4 }, () => ({ phase: 0, frequency: 0, bend: 0, envelope: 0, decay: .99 }));

  for (let i = 0; i < raw.length; i++) {
    const noise = random() * 2 - 1;
    bass += bassRate * (noise - bass);
    body += bodyRate * (noise - body);
    soft += softRate * (noise - soft);
    air += airRate * (noise - air);
    const cycle = TAU * i / length;

    if (kind === 'noise') {
      raw[i] = noise;
    } else if (kind === 'fire') {
      if (i >= nextDetail) {
        detailTarget = .2 + random() * .55;
        detailDecay = Math.exp(-1 / (SAMPLE_RATE * (.008 + random() * .018)));
        nextDetail = i + Math.round(SAMPLE_RATE * (.18 + random() * .65));
      }
      detailTarget *= detailDecay;
      detailEnvelope += .11 * (detailTarget - detailEnvelope);
      const glow = .86 + .1 * Math.sin(cycle * 2) + .04 * Math.sin(cycle * 7 + 1.2);
      raw[i] = (bass * 2.4 + body * .35) * glow + (soft - body) * detailEnvelope * .8;
    } else if (kind === 'ocean') {
      // 數個不同長度的緩慢起伏互相交錯，不播放固定間隔的短音。
      const swell = .52 + .22 * Math.sin(cycle * 3 + .3 * Math.sin(cycle))
        + .14 * Math.sin(cycle * 5 + 1.7) + .09 * Math.sin(cycle * 2 + .4);
      const foam = swell * swell;
      raw[i] = (bass * 1.8 + body * .65) * (.35 + swell)
        + (air - body) * (.08 + foam * .65);
    } else if (kind === 'rain') {
      if (i >= nextDetail) {
        detailTarget = .12 + random() * .3;
        detailPitch = 1500 + random() * 1900;
        detailPhase = 0;
        detailDecay = Math.exp(-1 / (SAMPLE_RATE * (.002 + random() * .005)));
        nextDetail = i + Math.round(SAMPLE_RATE * (.003 + random() * .012));
      }
      detailTarget *= detailDecay;
      detailEnvelope += .26 * (detailTarget - detailEnvelope);
      detailPhase += TAU * detailPitch / SAMPLE_RATE;
      raw[i] = (air - bass) * .55 + (soft - body) * .22
        + ((air - soft) * .2 + Math.sin(detailPhase) * .09) * detailEnvelope;
    } else {
      if (i >= nextDetail) {
        const voice = voices[voiceIndex++ % voices.length];
        voice.phase = 0;
        voice.frequency = 450 + random() * 1400;
        voice.bend = .04 + random() * .1;
        voice.envelope = .05 + random() * .14;
        voice.decay = Math.exp(-1 / (SAMPLE_RATE * (.018 + random() * .045)));
        nextDetail = i + Math.round(SAMPLE_RATE * (.022 + random() * .052));
      }
      let bubbles = 0;
      for (const voice of voices) {
        if (voice.envelope < .0001) continue;
        voice.frequency += voice.bend;
        voice.phase += TAU * voice.frequency / SAMPLE_RATE;
        voice.envelope *= voice.decay;
        bubbles += Math.sin(voice.phase) * voice.envelope;
      }
      const current = .86 + .09 * Math.sin(cycle * 7 + .6) + .05 * Math.sin(cycle * 11 + 2);
      raw[i] = ((soft - body) * .4 + body * .4) * current + bubbles * .65;
    }
  }

  const buffer = context.createBuffer(1, length, SAMPLE_RATE);
  finishLoop(raw, buffer.getChannelData(0), overlap);
  // 原影片環境聲較輕，白噪音保持相近音量，避免換音突然變大。
  if (kind === 'noise') {
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] *= .046875;
  }
  return buffer;
}
