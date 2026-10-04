export function unpackPcm(bytes, sampleRate = 8000) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error("voice_pcm_size_invalid");
  let pcm = bytes;
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE") throw new Error("voice_wav_invalid");
    let format = false, data = null;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length > bytes.length) throw new Error("voice_wav_truncated");
      if (tag === "fmt ") {
        if (length < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 || view.getUint16(start + 14, true) !== 16) throw new Error("voice_wav_requires_mono_pcm16");
        sampleRate = view.getUint32(start + 4, true); format = true;
      }
      if (tag === "data") data = bytes.subarray(start, start + length);
      offset = start + length + (length % 2);
    }
    if (!format || !data?.length) throw new Error("voice_wav_data_missing");
    pcm = data;
  }
  if (![8000, 16000, 24000, 32000, 44100, 48000].includes(sampleRate) || pcm.length % 2) throw new Error("voice_pcm_format_invalid");
  return { pcm, sampleRate };
}

export async function encodePcmRemotely(bytes, sampleRate, env, fetchImpl = fetch) {
  const endpoint = String(env.VOICE_ENCODE_URL || "");
  const secret = String(env.VOICE_ENCODE_SECRET || "");
  if (!/^https:\/\//.test(endpoint) || secret.length < 32) throw new Error("voice_encode_route_not_configured");
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error("voice_pcm_size_invalid");
  const timestamp = String(Date.now()), nonce = crypto.randomUUID();
  const hex = value => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, "0")).join("");
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const message = `${timestamp}\n${nonce}\n${sampleRate}\n${digest}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const response = await fetchImpl(endpoint, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-voice-timestamp": timestamp, "x-voice-nonce": nonce, "x-voice-sample-rate": String(sampleRate), "x-voice-signature": signature },
    body: bytes, signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`voice_encode_http_${response.status}`);
  const mp3 = new Uint8Array(await response.arrayBuffer());
  if (mp3.length < 4 || mp3[0] !== 0xff || (mp3[1] & 0xe0) !== 0xe0) throw new Error("voice_encode_invalid_mp3");
  return mp3;
}
