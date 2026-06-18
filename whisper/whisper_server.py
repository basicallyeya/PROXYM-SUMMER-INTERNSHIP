"""
QA Smart Assistant — Local Whisper Server
Run this file before starting a QA recording session.
Keep it running in the background while using the extension.

Usage: python whisper_server.py
Server runs on: http://localhost:5000

Model: medium (~5 GB RAM, good accuracy/speed balance)
Override with the WHISPER_MODEL env var if needed.
"""

import whisper
import tempfile
import os
import re
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "medium")

print(f"Loading Whisper model ({MODEL_SIZE})...")
print("First run downloads ~1.5GB — please wait...")
model = whisper.load_model(MODEL_SIZE)

print(f"✓ Whisper model '{MODEL_SIZE}' loaded. Server is ready!")
print("✓ Running on http://localhost:5000")
print("✓ Keep this window open while recording.\n")

# ---------------------------------------------------------------------------
# Common Whisper hallucination phrases to strip from output
# These phantom phrases appear frequently in silent/low-audio segments.
# ---------------------------------------------------------------------------
HALLUCINATION_PATTERNS = [
    r"^thank you[\.\!]?$",
    r"^thanks for watching[\.\!]?$",
    r"^subtitles by .+$",
    r"^amara\.org.+$",
    r"^www\..+$",
    r"^\[.*\]$",              # e.g. [Music], [Silence], [Applause]
    r"^\(.*\)$",              # e.g. (silence), (music)
    r"^\.+$",                 # lone dots
    r"^[♪♫]+$",              # music notes only
]
_HALLUCINATION_RE = re.compile(
    "|".join(HALLUCINATION_PATTERNS),
    re.IGNORECASE,
)


def is_hallucination(text: str) -> bool:
    t = text.strip()
    if len(t) < 3:
        return True
    return bool(_HALLUCINATION_RE.match(t))


def deduplicate_segments(segments: list) -> list:
    """Remove consecutive identical or near-identical segments."""
    out = []
    prev = None
    for seg in segments:
        t = seg["text"].strip().lower()
        if prev is not None and t == prev:
            continue
        out.append(seg)
        prev = t
    return out


# ---------------------------------------------------------------------------
# Audio extraction
# ---------------------------------------------------------------------------

def extract_mic_audio(input_path: str, output_path: str) -> bool:
    """
    Extract the first audio track (microphone), normalize volume, convert to
    16 kHz mono WAV — the exact format Whisper expects.
    Returns True on success.
    """
    # loudnorm brings uneven mic levels to a consistent loudness target.
    # highpass=f=80 removes low-frequency rumble; afftdn reduces background noise.
    filters = "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-map", "0:a:0",    # first audio stream = microphone
        "-af", filters,
        "-ar", "16000",     # Whisper native sample rate
        "-ac", "1",         # mono
        "-sample_fmt", "s16",
        "-f", "wav",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode == 0 and _wav_is_valid(output_path):
        return True

    # Fallback: merge all audio tracks, still apply normalization
    cmd_fallback = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vn",
        "-af", filters,
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        "-f", "wav",
        output_path,
    ]
    result2 = subprocess.run(cmd_fallback, capture_output=True, timeout=120)
    return result2.returncode == 0 and _wav_is_valid(output_path)


def _wav_is_valid(path: str) -> bool:
    return os.path.exists(path) and os.path.getsize(path) > 4096


def get_audio_duration(wav_path: str) -> float:
    """Return duration in seconds via ffprobe, or 0 on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                wav_path,
            ],
            capture_output=True, text=True, timeout=10,
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file received"}), 400

    audio_file = request.files["audio"]
    if not audio_file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Language selection
    language = request.form.get("language", "en").strip().lower()
    if language not in ("en", "fr", "ar"):
        language = "en"

    lang_names = {"en": "English", "fr": "French", "ar": "Arabic"}
    print(f"\nLanguage: {lang_names[language]}")

    # Determine file suffix from actual filename, fall back to content_type
    original_name = audio_file.filename.lower()
    if original_name.endswith(".mp4"):
        suffix = ".mp4"
    elif original_name.endswith(".ogg"):
        suffix = ".ogg"
    elif original_name.endswith(".wav"):
        suffix = ".wav"
    else:
        suffix = ".webm"  # browser MediaRecorder default

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    wav_path = tmp_path.replace(suffix, "_mic.wav")

    try:
        raw_size = os.path.getsize(tmp_path)
        print(f"Received: {audio_file.filename} ({raw_size:,} bytes)")

        if raw_size < 1024:
            return jsonify({"error": "Audio file is too small — recording may be empty"}), 400

        # Extract & normalize microphone audio
        print("  Extracting + normalizing microphone audio...")
        extraction_ok = extract_mic_audio(tmp_path, wav_path)
        if not extraction_ok:
            print("  WAV extraction failed — using original file")
            wav_path = tmp_path

        duration = get_audio_duration(wav_path)
        print(f"  Audio: {os.path.getsize(wav_path):,} bytes, {duration:.1f}s")

        if duration < 0.5:
            return jsonify({"error": "Audio too short to transcribe"}), 400

        print(f"  Transcribing ({lang_names[language]}, model={MODEL_SIZE})...")

        # -------------------------------------------------------------------
        # Transcription — tuned for maximum accuracy and hallucination resistance
        #
        # condition_on_previous_text=False  → prevents cascading hallucinations
        #   on long recordings; each 30 s chunk is decoded independently.
        #
        # temperature tuple → Whisper retries with increasing temperature when
        #   the decoder produces low-confidence output (compression ratio or
        #   avg log-prob outside thresholds), giving it the best chance of
        #   recovering a correct transcript rather than hallucinating.
        #
        # compression_ratio_threshold / logprob_threshold / no_speech_threshold
        #   → standard Whisper quality gates; explicit values match defaults but
        #   are written here so they are easy to tune per language or use-case.
        # -------------------------------------------------------------------
        result = model.transcribe(
            wav_path,
            language=language,
            task="transcribe",
            verbose=False,
            fp16=False,                         # CPU-safe; set True if GPU available
            beam_size=5,
            best_of=5,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
            compression_ratio_threshold=2.4,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6,
            condition_on_previous_text=False,   # key anti-hallucination flag
            word_timestamps=True,                # DTW word alignment -> accurate segment start/end
        )

        # Build segment list, filtering hallucinations
        raw_segments = result.get("segments", [])
        segments = []
        for seg in raw_segments:
            text = seg["text"].strip()
            if not text or is_hallucination(text):
                continue
            segments.append({
                "ts":   round(seg["start"], 2),
                "end":  round(seg["end"],   2),
                "text": text,
            })

        segments = deduplicate_segments(segments)

        full_text = " ".join(s["text"] for s in segments).strip()
        print(f"✓ Done — {len(segments)} segments")

        return jsonify({
            "status":    "ok",
            "language":  language,
            "model":     MODEL_SIZE,
            "duration":  round(duration, 1),
            "segments":  segments,
            "full_text": full_text,
        })

    except Exception as e:
        print(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    finally:
        for path in [tmp_path, wav_path]:
            try:
                if path and os.path.exists(path):
                    os.unlink(path)
            except Exception:
                pass


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
