// SPDX-License-Identifier: MIT

/**
 * How long to wait before asking the server for changes again.
 *
 * Every idle check is two requests and, on the server, an indexed query each. A
 * device left open on a desk or in a pocket asked every fifteen seconds all day
 * for nothing. The wait doubles after each pass that moved nothing, up to a cap,
 * and drops back to the base as soon as anything happens: an edit here, a change
 * that came down, or the app being brought back to the front.
 */
export class IdleBackoff {
	private current: number;

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

	/** Whether the wait has grown past the base, i.e. the device has been idle. */
	get backedOff(): boolean {
		return this.current > this.base;
	}

	/** A pass found nothing to do: wait longer next time. */
	idle(): void {
		this.current = Math.min(this.current * 2, this.max);
	}

	/** Something happened: check again soon. */
	active(): void {
		this.current = this.base;
	}
}
