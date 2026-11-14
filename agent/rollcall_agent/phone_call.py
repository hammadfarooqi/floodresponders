"""Run one outbound Roll Call test over Twilio Programmable Voice."""

import argparse
import json
import os
import re
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Event, Thread
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
from xml.etree.ElementTree import Element, SubElement, tostring

from rollcall_agent.manager_dispatch_demo import REPORT

NUMBER = re.compile(r"\+[1-9]\d{7,14}\Z")
WORDS = {
    word: number
    for number, word in enumerate(
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
        )
    )
}
COUNT = re.compile(
    r"\b(" + "|".join(WORDS) + r"|\d{1,3})\s+(?:people|person|residents?|tenants?)\b",
    re.IGNORECASE,
)
ALL_CLEAR = re.compile(
    r"\b(?:no one|nobody|zero people) needs? (?:evacuation )?(?:help|assistance)\b|\ball clear\b",
    re.IGNORECASE,
)
SPLIT_UNIT = re.compile(r"(\b(?:unit|room|apartment)\s+\d+)\s+([a-z])\b", re.IGNORECASE)
DETAILS_PROMPT = (
    "Please say how many people need help, their unit, and what help they need."
)


@dataclass
class Report:
    count: int | None = None
    unit: str | None = None
    need: str | None = None

    def capture(self, speech: str) -> None:
        speech = SPLIT_UNIT.sub(r"\1\2", speech.strip())
        if ALL_CLEAR.search(speech):
            self.count, self.unit, self.need = 0, None, None
            return
        count = COUNT.search(speech)
        if count:
            token = count[1].lower()
            value = WORDS[token] if token in WORDS else int(token)
            if value <= 100:
                self.count = value
        beginning = re.search(r"\b(?:unit|room|apartment)\s+", speech, re.IGNORECASE)
        details = REPORT.fullmatch(speech[beginning.start() :]) if beginning else None
        if details and details[2].strip(" ."):
            self.unit, self.need = details[1].upper(), details[2].strip(" .")

    @property
    def complete(self) -> bool:
        return self.count == 0 or (
            self.count is not None and bool(self.unit and self.need)
        )


class PhoneTest:
    def __init__(self, base_url: str):
        self.url = base_url + "/voice/" + uuid4().hex
        self.report = Report()
        self.attempts = 0
        self.result: dict | None = None
        self.finished = Event()
        self.replies: dict[str, bytes] = {}

    def gather(self, root: Element, prompt: str, turn: int) -> None:
        gather = SubElement(
            root,
            "Gather",
            {
                "input": "speech",
                "action": f"{self.url}/report/{turn}",
                "method": "POST",
                "language": "en-US",
                "speechTimeout": "auto",
                "timeout": "4",
                "actionOnEmptyResult": "true",
            },
        )
        SubElement(gather, "Say").text = prompt

    def respond(self, path: str, form: dict[str, str]) -> bytes:
        if path in self.replies:
            return self.replies[path]
        root = Element("Response")
        if path == "answer":
            self.gather(
                root,
                "This is the Roll Call test line. Use fictional details only. "
                + DETAILS_PROMPT
                + " For example, two people. Unit 3B needs help with stairs. Say all clear if nobody needs help.",
                1,
            )
        elif path == f"report/{self.attempts + 1}" and self.attempts < 2:
            self.attempts += 1
            self.report.capture(form.get("SpeechResult", "")[:500])
            if self.report.complete:
                reply = (
                    f"Thank you. I logged {self.report.count} people needing help in unit {self.report.unit}."
                    if self.report.count
                    else "Thank you. I logged an all clear."
                )
                SubElement(root, "Say").text = reply
                self.result = {"status": "report_received", **asdict(self.report)}
            elif self.attempts < 2:
                prompt = (
                    "Please repeat the number of people, for example, two people."
                    if self.report.unit
                    else "Please say the unit and kind of help. " + DETAILS_PROMPT
                )
                self.gather(root, prompt, 2)
            else:
                SubElement(
                    root, "Say"
                ).text = (
                    "I could not confirm all the details. This concludes the test call."
                )
                self.result = {"status": "incomplete_report"}
        return self.replies.setdefault(path, tostring(root, encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--to", required=True, help="Consenting test number in international + format"
    )
    parser.add_argument("--port", type=int, default=3023)
    args = parser.parse_args()
    required = (
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
        "ROLLCALL_VOICE_BASE_URL",
    )
    config = {name: os.environ.get(name, "").strip() for name in required}
    missing = [name for name, value in config.items() if not value]
    if missing:
        parser.error("Missing configuration: " + ", ".join(missing))
    source = config["TWILIO_FROM_NUMBER"]
    if not NUMBER.fullmatch(args.to) or not NUMBER.fullmatch(source):
        parser.error("Use international phone numbers, such as +12135550123")
    base_url = config["ROLLCALL_VOICE_BASE_URL"].rstrip("/")
    url = urlsplit(base_url)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.path
        or url.query
        or url.fragment
    ):
        parser.error("ROLLCALL_VOICE_BASE_URL must be a public HTTPS origin")

    try:
        from twilio.request_validator import RequestValidator
        from twilio.rest import Client
    except ImportError:
        parser.error(
            "Install the voice extra with python -m pip install -e ./agent[voice]"
        )

    test = PhoneTest(base_url)
    token = config["TWILIO_AUTH_TOKEN"]
    validator = RequestValidator(token)
    prefix = urlsplit(test.url).path + "/"

    class Handler(BaseHTTPRequestHandler):
        timeout = 10

        def log_message(self, _format, *_args):
            pass

        def do_POST(self):
            route = self.path.removeprefix(prefix)
            if not self.path.startswith(prefix) or route not in {
                "answer",
                "report/1",
                "report/2",
                "status",
            }:
                self.send_error(404)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8192:
                    raise ValueError
                form = {
                    key: values[-1]
                    for key, values in parse_qs(
                        self.rfile.read(size).decode(), keep_blank_values=True
                    ).items()
                }
            except ValueError:
                self.send_error(400)
                return
            if not validator.validate(
                base_url + self.path, form, self.headers.get("X-Twilio-Signature", "")
            ):
                self.send_error(403)
                return
            if route == "status":
                self.send_response(204)
                self.end_headers()
                if not test.result:
                    test.result = {"status": form.get("CallStatus", "ended")}
                test.finished.set()
                return
            body = test.respond(route, form)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            call = Client(config["TWILIO_ACCOUNT_SID"], token).calls.create(
                to=args.to,
                from_=source,
                url=test.url + "/answer",
                method="POST",
                status_callback=test.url + "/status",
                status_callback_method="POST",
                status_callback_event=["completed"],
                timeout=25,
                time_limit=120,
            )
            print(f"Test call submitted: {call.sid}", flush=True)
            if not test.finished.wait(165) and test.result is None:
                test.result = {"status": "timed_out"}
            print(json.dumps(test.result), flush=True)
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
