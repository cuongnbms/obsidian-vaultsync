// SPDX-License-Identifier: MIT

/**
 * How long to wait before asking the server for changes again.
 *
 * Every idle check is two requests and, on the server, an indexed query each. A
 * device left open on a desk or in a pocket asked every fifteen seconds all day
 * for nothing. The wait doubles after each pass that moved nothing, up to a cap,
 * and drops back to the base as soon as anything happens: an edit here, a change
 * that came down, or the app being brought back to the front after a while.
 */
export class IdleBackoff {
	private current: number;
	/** When the last pass finished, in ms. */
	private lastPass = 0;

	constructor(
		private readonly base: number,
		private readonly max: number,
	) {
		this.current = base;
	}

	/** The wait before the next check. */
	get delay(): number {
		return this.current;
	}

	/**
	 * A pass finished: keep checking often if it moved anything, back off if not.
	 * A pass someone asked for (the button, the command) means they are here, so it
	 * counts as activity even when it moved nothing.
	 */
	finished(moved: boolean, now: number, asked = false): void {
		this.lastPass = now;
		this.current = moved || asked ? this.base : Math.min(this.current * 2, this.max);
	}

	/** Something happened here, an edit: check again soon. */
	active(): void {
		this.current = this.base;
	}

	/**
	 * The app came back to the front. Worth a check at once only when the wait has
	 * grown and the last pass is at least a base interval old; otherwise switching
	 * windows, which on desktop happens all the time and already flushes on the way
	 * out, would start a pass every time. Returns whether to check now.
	 */
	wake(now: number): boolean {
		if (this.current <= this.base || now - this.lastPass < this.base) return false;
		this.current = this.base;
		return true;
	}
}
