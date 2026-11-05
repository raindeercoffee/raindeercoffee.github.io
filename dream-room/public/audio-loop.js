// Crossfade the tail into the head once, then let Web Audio repeat the result.
// Both joins fall on naturally adjacent source samples, without a silent gap.
export function createSeamlessLoop(context, input, overlapSeconds = .4, peakLimit = .9) {
  const { length, numberOfChannels, sampleRate } = input;
  if (!Number.isInteger(length) || length < 0 || !Number.isInteger(numberOfChannels)
      || numberOfChannels < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0
      || !Number.isFinite(overlapSeconds) || overlapSeconds <= 0
      || !Number.isFinite(peakLimit) || peakLimit <= 0 || peakLimit > 1) {
    throw new RangeError('無效的聲音或交疊設定');
  }
  // Empty data cannot be allocated by a real AudioContext. Fewer than four
  // samples cannot form a two-point crossfade; preserve those tiny waveforms.
  if (!length) return input;
  const overlap = length < 4 ? 0
    : Math.max(2, Math.min(Math.round(overlapSeconds * sampleRate), Math.floor(length / 2)));
  const output = context.createBuffer(numberOfChannels, length - overlap, sampleRate);
  let peak = 0;
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const source = input.getChannelData(channel);
    const samples = output.getChannelData(channel);
    for (let i = 0; i < overlap; i++) {
      const angle = i / (overlap - 1) * Math.PI / 2;
      samples[i] = i === 0 ? source[length - overlap]
        : i === overlap - 1 ? source[i]
        : source[length - overlap + i] * Math.cos(angle) + source[i] * Math.sin(angle);
    }
    samples.set(source.subarray(overlap, length - overlap), overlap);
    for (const value of samples) {
      if (!Number.isFinite(value)) throw new RangeError('聲音包含無效樣本');
      peak = Math.max(peak, Math.abs(value));
    }
  }
  if (peak > peakLimit) {
    const scale = peakLimit / peak;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const samples = output.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] *= scale;
    }
  }
  return output;
}
