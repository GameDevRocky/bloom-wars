const SOURCES = Object.freeze({
  shot: 'assets/audio/rifle-shot.mp3',
  empty: 'assets/audio/empty-clip.mp3',
  reload: 'assets/audio/reload.mp3',
  item: 'assets/audio/pickup-item.mp3',
  money: 'assets/audio/pickup-money.mp3',
});

const VOLUME = Object.freeze({ shot: 0.34, empty: 0.55, reload: 0.5, item: 0.65, money: 0.58 });

export class GameAudio {
  constructor() {
    this.music = new Audio('assets/audio/dark-guardian.mp3');
    this.music.loop = true;
    this.music.volume = 0.2;
    this.music.preload = 'auto';
    this.unlocked = false;
    this.pools = new Map(Object.entries(SOURCES).map(([name, source]) => [
      name,
      Array.from({ length: name === 'shot' ? 8 : 3 }, () => {
        const audio = new Audio(source);
        audio.preload = 'auto';
        return audio;
      }),
    ]));
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.music.play().catch(() => { this.unlocked = false; });
  }

  play(name, source = null, listener = null) {
    if (!this.unlocked) return;
    const pool = this.pools.get(name);
    if (!pool) return;
    let gain = 1;
    if (source && listener) gain = Math.max(0, 1 - Math.hypot(source.x - listener.x, source.y - listener.y) / 1_150);
    if (gain <= 0) return;
    const audio = pool.find((candidate) => candidate.paused || candidate.ended) ?? pool[0].cloneNode();
    audio.volume = Math.min(1, VOLUME[name] * gain);
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
}

export { SOURCES };
