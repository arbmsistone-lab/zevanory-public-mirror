#!/usr/bin/env bash
# zevanory-av-gate — baixa os modelos para $AV_GATE_MODELS e confere SHA-256 fixado (fail-closed: hash diferente = erro).
# Motor A: faster-whisper "small" (Systran/faster-whisper-small, MIT). Motor B: Vosk pt-BR small (Apache-2.0).
# Locutor: Vosk x-vector spk-0.4 (Apache-2.0). MOS preditivo: DNSMOS P.835 sig_bak_ovr.onnx (microsoft/DNS-Challenge).
set -euo pipefail
MD="${AV_GATE_MODELS:?defina AV_GATE_MODELS}"
mkdir -p "$MD/dnsmos" "$MD/whisper"
pin() {  # pin <arquivo> <sha256 esperado>
  local got; got=$(sha256sum "$1" | cut -d' ' -f1)
  if [ "$got" != "$2" ]; then echo "::error title=AV_GATE_MODELS::sha256 divergente em $(basename "$1"): $got"; exit 1; fi
}
VOSK_PT_SHA=6e1ce909032e1afa7a88e68a3d628ecafff302bdf195befab308826c395e93b7
VOSK_SPK_SHA=a74d8f51144484813e16af689bb0f916b7a111e2347f467c4933c1166097b5a7
DNSMOS_SHA=269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd
get_zip() {  # get_zip <url> <dir-name> <sha>
  if [ ! -d "$MD/$2" ]; then
    curl -fsSL --retry 3 -o "$MD/$2.zip" "$1"
    pin "$MD/$2.zip" "$3"
    unzip -q "$MD/$2.zip" -d "$MD" && rm -f "$MD/$2.zip"
  fi
}
get_zip https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip vosk-model-small-pt-0.3 "$VOSK_PT_SHA"
get_zip https://alphacephei.com/vosk/models/vosk-model-spk-0.4.zip vosk-model-spk-0.4 "$VOSK_SPK_SHA"
D="$MD/dnsmos/sig_bak_ovr.onnx"
for u in https://github.com/microsoft/DNS-Challenge/raw/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx \
         https://media.githubusercontent.com/media/microsoft/DNS-Challenge/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx; do
  if [ -s "$D" ] && [ "$(stat -c %s "$D")" -gt 100000 ]; then break; fi
  curl -fsSL --retry 3 -o "$D" "$u" || true
done
[ "$(stat -c %s "$D" 2>/dev/null || echo 0)" -gt 100000 ] || { echo "::error title=AV_GATE_MODELS::DNSMOS indisponível"; exit 1; }
pin "$MD/dnsmos/sig_bak_ovr.onnx" "$DNSMOS_SHA"
python3 - <<PY
import hashlib, os
from faster_whisper import WhisperModel
WhisperModel("${AV_GATE_WHISPER_MODEL:-small}", device="cpu", compute_type="int8", download_root="$MD/whisper")
h = hashlib.sha256()
for root, _, files in sorted(os.walk("$MD/whisper")):
    for f in sorted(files):
        if f == "model.bin":
            h.update(open(os.path.join(root, f), "rb").read())
print("::notice title=AV_GATE_WHISPER::model.bin sha256=" + h.hexdigest())
PY
echo "::notice title=AV_GATE_MODELS::ok vosk-pt=$VOSK_PT_SHA spk=$VOSK_SPK_SHA dnsmos=$DNSMOS_SHA"
