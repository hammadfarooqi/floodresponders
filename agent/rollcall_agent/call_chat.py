"""Simulated dispatch-to-manager calls with optional offline dictation."""

import argparse
import io
import json
import re
import wave
from http.server import ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path

from rollcall_agent.manager_dispatch_demo import DemoHandler

GREETING = (
    "Hi, this is Roll Call dispatch. During this exercise, how many residents need evacuation "
    "assistance? Please tell me their unit and what help they need."
)
COUNT_WORDS = dict(
    zip(
        (
            "zero",
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
        ),
        range(11),
        strict=True,
    )
)
COUNT = re.compile(
    r"\b("
    + "|".join(COUNT_WORDS)
    + r"|\d{1,3})\s+(?:people|residents?|tenants?|person)\b",
    re.IGNORECASE,
)
UNIT = re.compile(
    r"\b(?:unit|room|apartment)\s+([0-9]{1,5}(?:\s*[a-z]\b)?|[a-z][0-9]{1,5})\b",
    re.IGNORECASE,
)
SPOKEN_UNIT = re.compile(
    r"\b(unit|room|apartment)\s+(" + "|".join(COUNT_WORDS) + r")\b",
    re.IGNORECASE,
)
SPOKEN_SUFFIX = re.compile(
    r"\b((?:unit|room|apartment)\s+\d{1,5})\s+(ay|be|bee|see|sea|dee)\b",
    re.IGNORECASE,
)
SUFFIX_LETTERS = {"ay": "A", "be": "B", "bee": "B", "see": "C", "sea": "C", "dee": "D"}
NEED = re.compile(
    r"\b(?:needs?|require(?:s)?|cannot evacuate without)\s+(?:help with\s+|assistance with\s+)?(.+)",
    re.IGNORECASE,
)
CLEAR = re.compile(
    r"^(?:all clear|no one needs (?:help|assistance)|nobody needs (?:help|assistance))[.!]?$",
    re.IGNORECASE,
)


def reply_to_report(message: str, previous: dict) -> dict:
    """Collect a fictional report one field at a time without an external model."""
    message = message.strip()
    if not 1 <= len(message) <= 400:
        raise ValueError("Enter a reply of up to 400 characters.")
    count = previous.get("count")
    unit = previous.get("unit")
    need = previous.get("need")
    if count is not None and (type(count) is not int or not 1 <= count <= 100):
        raise ValueError("Count must be between 1 and 100.")
    if unit is not None and (
        not isinstance(unit, str) or not re.fullmatch(r"[A-Z0-9]{1,6}", unit)
    ):
        raise ValueError("Unit is invalid.")
    if need is not None and (not isinstance(need, str) or not 1 <= len(need) <= 180):
        raise ValueError("Assistance details are invalid.")

    if CLEAR.fullmatch(message):
        return {
            "reply": "Thanks. I marked this building all clear for the exercise.",
            "report": {"count": 0, "unit": None, "need": None},
            "complete": True,
        }

    count_match = COUNT.search(message)
    count_text = count_match[1].lower() if count_match else message.lower().rstrip(".!")
    # Only treat a bare number as the count when that's the field we asked for.
    if count_match or count is None:
        value = (
            int(count_text)
            if count_text.isascii() and count_text.isdecimal() and len(count_text) <= 3
            else COUNT_WORDS.get(count_text)
        )
        if value is not None and 1 <= value <= 100:
            count = value
    unit_message = SPOKEN_UNIT.sub(
        lambda item: f"{item[1]} {COUNT_WORDS[item[2].lower()]}", message
    )
    unit_message = SPOKEN_SUFFIX.sub(
        lambda item: item[1] + SUFFIX_LETTERS[item[2].lower()], unit_message
    )
    unit_match = UNIT.search(unit_message)
    if unit_match:
        unit = re.sub(r"\s+", "", unit_match[1]).upper()
    elif previous.get("count") is not None and unit is None and not count_match:
        bare_unit = re.sub(r"\s+", "", message.rstrip(".!")).upper()
        if re.fullmatch(r"(?:\d{1,5}[A-Z]?|[A-Z]\d{1,5})", bare_unit):
            unit = bare_unit
    need_match = NEED.search(message)
    if need_match:
        details = need_match[1].strip(" .!")
        if details.lower() not in {
            "help",
            "assistance",
            "evacuation assistance",
            "evacuation help",
        }:
            need = details[:180]
    elif (
        previous.get("count")
        and previous.get("unit")
        and not count_match
        and not unit_match
    ):
        need = message[:180]

    if count is None:
        reply = "How many residents need help? You can say, for example, two people."
    elif unit is None:
        reply = "Which unit are they in?"
    elif need is None:
        reply = f"What kind of help does unit {unit} need?"
    else:
        who = "1 person" if count == 1 else f"{count} people"
        reply = f"Thanks. I logged {who} in unit {unit} who need help with {need}. I'll pass that to dispatch."
    return {
        "reply": reply,
        "report": {"count": count, "unit": unit, "need": need},
        "complete": count is not None and unit is not None and need is not None,
    }


def load_dictation(model_dir: Path):
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
    model = Model(str(model_dir))

    def transcribe(audio: bytes) -> str:
        with wave.open(io.BytesIO(audio)) as source:
            if (
                source.getnchannels() != 1
                or source.getsampwidth() != 2
                or source.getframerate() != 16000
                or not 0 < source.getnframes() <= 16000 * 20
            ):
                raise ValueError("Record up to 20 seconds of audio.")
            recognizer = KaldiRecognizer(model, 16000)
            segments = []
            while chunk := source.readframes(4000):
                if recognizer.AcceptWaveform(chunk):
                    segments.append(json.loads(recognizer.Result()).get("text", ""))
            segments.append(json.loads(recognizer.FinalResult()).get("text", ""))
            return " ".join(part for part in segments if part).strip()

    return transcribe


def make_handler(transcribe):
    class Handler(DemoHandler):
        timeout = 15

        def do_GET(self):
            if self.path == "/session":
                self.send_json(
                    {"greeting": GREETING, "dictation": transcribe is not None}
                )
            elif self.path == "/":
                page = files("rollcall_agent").joinpath("call_chat.html").read_bytes()
                self.send_content(page, "text/html; charset=utf-8")
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path not in ("/reply", "/dictate"):
                self.send_error(404)
                return
            port = self.server.server_port
            origin = self.headers.get("Origin")
            if origin and origin not in (
                f"http://127.0.0.1:{port}",
                f"http://localhost:{port}",
            ):
                self.send_json({"error": "Open the demo on localhost."}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path == "/dictate":
                    if transcribe is None:
                        self.send_json({"error": "Local dictation is not set up."}, 503)
                        return
                    if (
                        self.headers.get_content_type() != "audio/wav"
                        or not 0 < length <= 641024
                    ):
                        raise ValueError(
                            "Expected a WAV recording of up to 20 seconds."
                        )
                    result = {"text": transcribe(self.rfile.read(length))}
                else:
                    if (
                        self.headers.get_content_type() != "application/json"
                        or not 0 < length <= 4096
                    ):
                        raise ValueError("Invalid reply.")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict) or not isinstance(
                        payload.get("message"), str
                    ):
                        raise ValueError("Enter a reply.")
                    previous = payload.get("report", {})
                    if not isinstance(previous, dict):
                        raise ValueError("Invalid report.")
                    result = reply_to_report(payload["message"], previous)
            except (ValueError, EOFError, wave.Error) as error:
                self.send_json({"error": str(error)}, 400)
                return
            self.send_json(result)

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3025)
    parser.add_argument(
        "--model-dir", type=Path, help="Path to an unpacked local Vosk model"
    )
    args = parser.parse_args()
    recognizer = load_dictation(args.model_dir) if args.model_dir else None
    with ThreadingHTTPServer(
        ("127.0.0.1", args.port), make_handler(recognizer)
    ) as server:
        print(
            f"Dispatcher chat demo: http://127.0.0.1:{server.server_port}", flush=True
        )
        server.serve_forever()
