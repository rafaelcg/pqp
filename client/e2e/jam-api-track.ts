/**
 * A track made the way the app makes one (a ticket, a PUT to the bucket, the
 * claim), for the specs that need a song the whole room can see: a song with no
 * track is its author's alone (`packages/shared/src/jam.ts`), so a spec that
 * wants a second person to see a song gives it a take first.
 */

/** Two seconds of a plucked note as a WAV: every browser decodes it whatever the label says. */
function wavBytes(seconds = 2, note = 196): Uint8Array {
  const rate = 22050;
  const frames = Math.floor(seconds * rate);
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * note * t) * Math.exp(-(t % 0.5) * 6) * 0.5 * 32767), true);
  }
  return out;
}

export async function addApiTrack(
  api: string,
  suffix: string,
  songId: string,
  instrument: "guitar" | "bass" | "drums" | "vocals" | "keys" | "other" = "guitar",
): Promise<string> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer dev-local-token:${suffix}` };
  const bytes = wavBytes();
  const ticketResponse = await fetch(`${api}/api/jam-songs/${songId}/uploads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "audio", contentType: "audio/flac", byteSize: bytes.length }),
  });
  if (!ticketResponse.ok) {
    throw new Error(`ticket -> ${ticketResponse.status} ${await ticketResponse.text()}`);
  }
  const ticket = (await ticketResponse.json()) as { uploadId: string; uploadUrl: string };
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/flac" },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`PUT -> ${put.status}`);
  }
  const claim = await fetch(`${api}/api/jam-songs/${songId}/tracks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      instrument,
      audioUploadId: ticket.uploadId,
      durationMs: 2000,
      peaks: [0.2, 0.8, 0.5, 0.9, 0.3],
    }),
  });
  if (!claim.ok) {
    throw new Error(`claim -> ${claim.status} ${await claim.text()}`);
  }
  return ((await claim.json()) as { track: { id: string } }).track.id;
}
