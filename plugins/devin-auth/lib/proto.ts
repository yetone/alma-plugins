/**
 * Minimal protobuf wire codec (writer + reader).
 *
 * Ported from OMP's `@oh-my-pi/pi-catalog` protobuf codec, stripped down to the
 * handful of wire types Codeium's Cascade API actually uses. Kept dependency-free
 * so the plugin runs with nothing but Node builtins.
 *
 * Wire types: 0 = varint, 1 = fixed64, 2 = length-delimited, 5 = fixed32.
 */

/** Streaming protobuf writer. Chainable; call `.done()` for the buffer. */
export class Writer {
	#bufs: Buffer[] = [];

	varint(n: number | bigint): this {
		let x = BigInt(n);
		if (x < 0n) x &= 0xffffffffffffffffn;
		const out: number[] = [];
		do {
			let b = Number(x & 0x7fn);
			x >>= 7n;
			if (x > 0n) b |= 0x80;
			out.push(b);
		} while (x > 0n);
		this.#bufs.push(Buffer.from(out));
		return this;
	}

	tag(field: number, wire: number): this {
		return this.varint((field << 3) | wire);
	}

	str(field: number, s: string | undefined): this {
		if (!s) return this;
		const p = Buffer.from(s, "utf8");
		this.tag(field, 2);
		this.varint(p.length);
		this.#bufs.push(p);
		return this;
	}

	raw(field: number, buf: Buffer | Uint8Array): this {
		this.tag(field, 2);
		this.varint(buf.length);
		this.#bufs.push(Buffer.from(buf));
		return this;
	}

	/** Nested message: pass a Writer whose `done()` yields the sub-message bytes. */
	msg(field: number, m: Writer): this {
		return this.raw(field, m.done());
	}

	/** Emit an already-encoded sub-message (avoids re-encoding). */
	sub(field: number, buf: Buffer): this {
		return this.raw(field, buf);
	}

	int(field: number, n: number | bigint): this {
		this.tag(field, 0);
		return this.varint(n);
	}

	bool(field: number, v: boolean | undefined): this {
		if (!v) return this;
		this.tag(field, 0);
		return this.varint(1);
	}

	dbl(field: number, v: number): this {
		const b = Buffer.alloc(8);
		b.writeDoubleLE(v, 0);
		this.tag(field, 1);
		this.#bufs.push(b);
		return this;
	}

	done(): Buffer {
		return Buffer.concat(this.#bufs);
	}
}

export type Fields = Record<number, Array<number | Buffer>>;

/** Lenient protobuf reader. Unknown fields are preserved by field number. */
export function read(buf: Buffer | Uint8Array): Fields {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const out: Fields = {};
	let i = 0;
	while (i < b.length) {
		const [key, i2] = readVarint(b, i);
		i = i2;
		const field = key >> 3;
		const wire = key & 7;
		if (wire === 0) {
			const [v, i3] = readVarint(b, i);
			i = i3;
			(out[field] ??= []).push(v);
		} else if (wire === 2) {
			const [len, i3] = readVarint(b, i);
			i = i3;
			if (i3 + len > b.length) break; // truncated — stop rather than throw
			(out[field] ??= []).push(b.subarray(i3, i3 + len));
			i = i3 + len;
		} else if (wire === 5) {
			if (i + 4 > b.length) break;
			(out[field] ??= []).push(b.readUInt32LE(i));
			i += 4;
		} else if (wire === 1) {
			if (i + 8 > b.length) break;
			(out[field] ??= []).push(b.readDoubleLE(i));
			i += 8;
		} else {
			break; // groups / unknown — bail out
		}
	}
	return out;
}

function readVarint(b: Buffer, start: number): [number, number] {
	let r = 0n;
	let shift = 0n;
	let i = start;
	for (;;) {
		if (i >= b.length) return [Number(r), i];
		const byte = b[i++]!;
		r |= BigInt(byte & 0x7f) << shift;
		if (!(byte & 0x80)) break;
		shift += 7n;
		if (shift > 63n) break;
	}
	return [Number(r), i];
}

/** First value of a string field, or "". */
export function s(f: Fields, field: number): string {
	const v = f[field]?.[0];
	return Buffer.isBuffer(v) ? v.toString("utf8") : "";
}

/** First value of a numeric field, or 0. */
export function n(f: Fields, field: number): number {
	return Number(f[field]?.[0] ?? 0);
}

/** All values of a repeated length-delimited field, as buffers. */
export function list(f: Fields, field: number): Buffer[] {
	return (f[field] ?? []).filter((x): x is Buffer => Buffer.isBuffer(x));
}

/** Decode a nested message field. Returns {} when absent. */
export function sub(f: Fields, field: number): Fields {
	const v = f[field]?.[0];
	return Buffer.isBuffer(v) ? read(v) : {};
}

/** Decode a repeated nested message field. */
export function subList(f: Fields, field: number): Fields[] {
	return list(f, field).map(read);
}

/** Best-effort varint parse of a partial (still-streaming) buffer. */
export function tryRead(buf: Buffer): Fields | null {
	try {
		return read(buf);
	} catch {
		return null;
	}
}
