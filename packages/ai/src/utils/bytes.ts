/** Supply WebCrypto an ArrayBuffer-backed view, copying only shared-memory bytes. */
export function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
