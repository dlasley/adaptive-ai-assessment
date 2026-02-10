/**
 * Sound Effects Player
 * Plays pre-generated WAV files from /public/sounds/.
 * Uses AudioContext for reliable, overlapping playback.
 */

import { isSoundEnabled } from './celebration-settings';

type SoundName = 'chime' | 'fanfare' | 'pop' | 'streak';

class SoundGenerator {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<SoundName, AudioBuffer>> = {};
  private loading: Partial<Record<SoundName, Promise<AudioBuffer | null>>> = {};

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  private async loadSound(name: SoundName): Promise<AudioBuffer | null> {
    if (this.buffers[name]) return this.buffers[name]!;
    if (this.loading[name]) return this.loading[name]!;

    this.loading[name] = (async () => {
      try {
        const ctx = this.getContext();
        const resp = await fetch(`/sounds/${name}.wav`);
        const arrayBuf = await resp.arrayBuffer();
        const buffer = await ctx.decodeAudioData(arrayBuf);
        this.buffers[name] = buffer;
        return buffer;
      } catch {
        return null;
      }
    })();

    return this.loading[name]!;
  }

  private async playSound(name: SoundName): Promise<void> {
    if (!isSoundEnabled()) return;
    try {
      const buffer = await this.loadSound(name);
      if (!buffer) return;
      const ctx = this.getContext();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch {
      // Silently fail
    }
  }

  /** Perfect score: fireworks pop + crackling embers */
  playChime(): void {
    this.playSound('chime');
  }

  /** New high score: firework launch → whistle → explosion */
  playFanfare(): void {
    this.playSound('fanfare');
  }

  /** Correct answer: satisfying pop */
  playPop(): void {
    this.playSound('pop');
  }

  /** Streak milestone: ascending bell chime */
  playStreakChime(): void {
    this.playSound('streak');
  }
}

export const soundGenerator = new SoundGenerator();
