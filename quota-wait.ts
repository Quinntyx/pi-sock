/** Monotonic pause clock published by get_state for external execution timers. */
export class QuotaWaitClock {
  private completedMs = 0;
  private startedAt: number | null = null;
  private now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  setActive(active: boolean): void {
    if (active && this.startedAt === null) this.startedAt = this.now();
    else if (!active && this.startedAt !== null) {
      this.completedMs += Math.max(0, this.now() - this.startedAt);
      this.startedAt = null;
    }
  }

  snapshot(): { active: boolean; elapsedMs: number } {
    return {
      active: this.startedAt !== null,
      elapsedMs: this.completedMs + (this.startedAt === null ? 0 : Math.max(0, this.now() - this.startedAt)),
    };
  }
}
