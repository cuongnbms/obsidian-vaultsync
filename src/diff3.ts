// SPDX-License-Identifier: MIT

/**
 * Line-based three-way merge.
 *
 * This is the one place in the project where text can be destroyed, so it is kept
 * separate from everything else and tested on its own.
 *
 * The rule it implements: a region only merges silently when exactly one side
 * touched it, or when both sides made the identical change. Anything else is a
 * conflict, and a conflict never overwrites, it produces markers and a copy.
 */

export interface MergeResult {
	/** True when no region needed a decision that could lose text. */
	clean: boolean;
	/**
	 * False when the versions differ too much to be merged line by line. The merge
	 * was not attempted: `clean` is false and `text` holds both versions whole, one
	 * after the other, between markers.
	 */
	mergeable: boolean;
	text: string;
	/** How many regions ended up with conflict markers. */
	conflicts: number;
}

interface Match {
	base: number;
	other: number;
}

/**
 * The most lines two versions may differ by (lines removed plus lines added) before
 * a merge is not attempted.
 *
 * Myers keeps one row of state per step of difference, so the work grows with the
 * square of the difference. A note rewritten end to end (line endings converted, a
 * formatter run over it) differs in every line; merging it line by line would take
 * gigabytes and produce one conflict the size of the file anyway. Past this bound
 * both versions are kept whole instead. At the bound the stored trace is about
 * 4 * MAX_EDIT^2 bytes, 16 MB.
 */
const MAX_EDIT = 2000;

/**
 * Longest common subsequence of two line arrays, returned as index pairs, or null
 * when the two differ by more than MAX_EDIT lines.
 *
 * Myers' O(ND) algorithm: the work grows with the size of the difference rather
 * than the size of the file, which is the right shape here because two versions of
 * a note are usually almost identical. The common head and tail are matched first,
 * so only the part in between goes through it.
 */
function commonLines(a: string[], b: string[]): Match[] | null {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}

	const matches: Match[] = [];
	for (let i = 0; i < head; i++) matches.push({ base: i, other: i });
	const middle = middleLines(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
	if (middle === null) return null;
	for (const m of middle) matches.push({ base: m.base + head, other: m.other + head });
	for (let i = tail; i > 0; i--) matches.push({ base: a.length - i, other: b.length - i });
	return matches;
}

function middleLines(a: string[], b: string[]): Match[] | null {
	const n = a.length;
	const m = b.length;
	// Nothing in common is possible, so there is nothing to search for. This is the
	// empty base of a first sync, where both sides are compared against nothing.
	if (n === 0 || m === 0) return [];
	const max = n + m;
	// trace[d] holds the furthest x reached on each diagonal k in [-d, d] before step
	// d, at offset k + d. Storing only that window keeps the trace at O(D^2).
	const trace: Int32Array[] = [];
	const v = new Int32Array(2 * max + 1);

	let d = 0;
	outer: for (; d <= max; d++) {
		if (d > MAX_EDIT) return null;
		trace.push(v.slice(max - d, max + d + 1));
		for (let k = -d; k <= d; k += 2) {
			const idx = k + max;
			let x: number;
			if (k === -d || (k !== d && (v[idx - 1] ?? 0) < (v[idx + 1] ?? 0))) {
				x = v[idx + 1] ?? 0;
			} else {
				x = (v[idx - 1] ?? 0) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[idx] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	// Walk the trace backwards and collect the diagonal moves, which are the matches.
	const matches: Match[] = [];
	let x = n;
	let y = m;
	for (let step = Math.min(d, trace.length - 1); step > 0; step--) {
		const prev = trace[step] as Int32Array;
		const at = (k: number): number => prev[k + step] ?? 0;
		const k = x - y;
		let prevK: number;
		if (k === -step || (k !== step && at(k - 1) < at(k + 1))) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			matches.push({ base: x, other: y });
		}
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		matches.push({ base: x, other: y });
	}
	matches.reverse();
	return matches;
}

/** Which base lines a side left untouched, as a lookup from base index to side index. */
function matchMap(base: string[], side: string[]): Map<number, number> | null {
	const common = commonLines(base, side);
	if (common === null) return null;
	const map = new Map<number, number>();
	for (const m of common) map.set(m.base, m.other);
	return map;
}

export function splitLines(text: string): string[] {
	if (text === "") return [];
	// Keeping the trailing newline out of the line list avoids a phantom empty line
	// at the end of every file, which would otherwise show up as a difference.
	const stripped = text.endsWith("\n") ? text.slice(0, -1) : text;
	return stripped.split("\n");
}

function joinLines(lines: string[], sample: string): string {
	const text = lines.join("\n");
	return sample.endsWith("\n") || text === "" ? text + "\n" : text;
}

/**
 * Merge `mine` and `theirs`, both derived from `base`.
 *
 * `mineLabel` and `theirsLabel` name the sides inside conflict markers, so whoever
 * opens the file can tell which half came from which device.
 */
export function merge3(
	base: string,
	mine: string,
	theirs: string,
	mineLabel = "local",
	theirsLabel = "server",
): MergeResult {
	const b = splitLines(base);
	const a = splitLines(mine);
	const c = splitLines(theirs);

	if (mine === theirs) return { clean: true, mergeable: true, text: mine, conflicts: 0 };
	if (base === mine) return { clean: true, mergeable: true, text: theirs, conflicts: 0 };
	if (base === theirs) return { clean: true, mergeable: true, text: mine, conflicts: 0 };

	const inMine = matchMap(b, a);
	const inTheirs = inMine && matchMap(b, c);
	if (inMine === null || inTheirs === null) {
		// Too different to line up. One region spanning the whole file loses nothing.
		const out: string[] = [];
		emit(out, b, a, c, mineLabel, theirsLabel, () => {});
		return { clean: false, mergeable: false, text: joinLines(out, theirs || mine), conflicts: 1 };
	}

	const out: string[] = [];
	let conflicts = 0;
	let ai = 0;
	let ci = 0;
	// Where the current changed region starts in the base. Everything from here up to
	// the next stable line is what the two sides rewrote between them.
	let regionStart = 0;

	for (let bi = 0; bi < b.length; bi++) {
		const ma = inMine.get(bi);
		const mc = inTheirs.get(bi);
		// A stable line is one both sides still carry, in order. It closes the region
		// before it and is emitted untouched.
		if (ma === undefined || mc === undefined || ma < ai || mc < ci) continue;

		emit(
			out,
			b.slice(regionStart, bi),
			a.slice(ai, ma),
			c.slice(ci, mc),
			mineLabel,
			theirsLabel,
			() => conflicts++,
		);
		out.push(b[bi] as string);
		ai = ma + 1;
		ci = mc + 1;
		regionStart = bi + 1;
	}

	emit(
		out,
		b.slice(regionStart),
		a.slice(ai),
		c.slice(ci),
		mineLabel,
		theirsLabel,
		() => conflicts++,
	);

	return { clean: conflicts === 0, mergeable: true, text: joinLines(out, theirs || mine), conflicts };
}

/**
 * The leading blockquote or callout prefix shared by a region, such as "> " or "> > ".
 *
 * Only quote markers are carried over. List bullets are deliberately left alone: a
 * marker that looked like another list item would change the numbering of the list
 * it is sitting in.
 */
function blockPrefix(...chunks: string[][]): string {
	for (const chunk of chunks) {
		for (const line of chunk) {
			const m = /^((?:\s*>\s?)+)/.exec(line);
			if (m) return m[1] as string;
		}
	}
	return "";
}

function sameLines(x: string[], y: string[]): boolean {
	return x.length === y.length && x.every((line, i) => line === y[i]);
}

function emit(
	out: string[],
	baseChunk: string[],
	mineChunk: string[],
	theirsChunk: string[],
	mineLabel: string,
	theirsLabel: string,
	onConflict: () => void,
): void {
	if (sameLines(mineChunk, theirsChunk)) {
		// Both sides made the same change, or neither changed anything.
		out.push(...mineChunk);
		return;
	}
	if (sameLines(mineChunk, baseChunk)) {
		out.push(...theirsChunk); // only the other side touched this region
		return;
	}
	if (sameLines(theirsChunk, baseChunk)) {
		out.push(...mineChunk); // only this side touched it
		return;
	}
	// Both sides changed the same region differently. Nothing is thrown away.
	//
	// The markers are Obsidian comments, not the git ones. A line of "=" turns the
	// line above it into a heading and a line starting with ">" becomes a blockquote,
	// so git markers wreck the rendering of the very note they describe. Comments are
	// inert: invisible in reading view, plain in source, and they cannot be mistaken
	// for structure.
	//
	// The block prefix of the surrounding lines is carried onto the markers as well.
	// A conflict inside a callout or a quote would otherwise be cut in half by a
	// marker line that does not continue the block.
	onConflict();
	const prefix = blockPrefix(mineChunk, theirsChunk, baseChunk);
	out.push(`${prefix}%% lockstep: ${mineLabel} %%`);
	out.push(...mineChunk);
	out.push(`${prefix}%% lockstep: ${theirsLabel} %%`);
	out.push(...theirsChunk);
	out.push(`${prefix}%% lockstep: end %%`);
}
