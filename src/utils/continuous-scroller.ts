export type ContinuousScrollState = "stopped" | "running" | "waiting" | "suspended";

export type ContinuousScrollSnapshot = {
  position: number;
  end: number;
  /** Furthest scroll position with a continuously ready viewport. */
  readyEnd: number;
  complete: boolean;
  suspended: boolean;
};

type ScrollHost = {
  speed: () => number;
  snapshot: () => ContinuousScrollSnapshot;
  moveTo: (position: number) => void;
  onState: (state: ContinuousScrollState) => void;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
};

/** A single time-based loop, independent of refresh rate and loading latency. */
export class ContinuousScroller {
  private frame?: number;
  private timestamp?: number;
  private position?: number;
  private lastActual?: number;
  private state: ContinuousScrollState = "stopped";

  constructor(private host: ScrollHost) {}

  start() {
    if (this.state !== "stopped") return;
    this.resetClock();
    this.position = this.lastActual = undefined;
    this.setState("running");
    this.frame = this.host.requestFrame(time => this.tick(time));
  }

  resetClock() {
    this.timestamp = undefined;
  }

  stop() {
    if (this.frame !== undefined) this.host.cancelFrame(this.frame);
    this.frame = undefined;
    this.resetClock();
    this.setState("stopped");
  }

  private setState(state: ContinuousScrollState) {
    if (this.state === state) return;
    this.state = state;
    this.host.onState(state);
  }

  private isActive() { return this.state !== "stopped"; }

  private tick(time: number) {
    this.frame = undefined;
    if (this.state === "stopped") return;
    const snapshot = this.host.snapshot();
    const elapsed = this.timestamp === undefined ? 0 : Math.min(Math.max(time - this.timestamp, 0), 100);
    this.timestamp = time;
    // Rebase on real scroll changes (manual input, zoom or image-size correction),
    // but retain fractional pixels when the browser rounds our own writes.
    if (this.lastActual !== snapshot.position || this.position === undefined) this.position = snapshot.position;
    if (snapshot.suspended) {
      this.resetClock();
      this.setState("suspended");
    } else {
      const limit = Math.max(snapshot.position, Math.min(snapshot.end, snapshot.readyEnd));
      const next = Math.min(this.position + this.host.speed() * elapsed / 1000, limit);
      if (next > snapshot.position) this.host.moveTo(next);
      this.position = next;
      if (snapshot.complete && next >= snapshot.end - 0.01) return this.stop();
      this.setState(next >= limit - 0.01 ? "waiting" : "running");
    }
    this.lastActual = this.host.snapshot().position;
    if (this.isActive()) this.frame = this.host.requestFrame(t => this.tick(t));
  }
}
