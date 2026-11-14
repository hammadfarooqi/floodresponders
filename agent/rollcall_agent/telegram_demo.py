"""Telegram manager messaging for the localhost dispatcher exercise."""

import json
import re
import secrets
import time
from threading import Lock
from urllib.request import Request, urlopen

BUILDING = "Magnolia Court"


class TelegramError(RuntimeError):
    """A Telegram request failed without exposing the bot token."""


class TelegramBot:
    def __init__(self, token):
        if not re.fullmatch(r"\d+:[A-Za-z0-9_-]+", token):
            raise ValueError("TELEGRAM_BOT_TOKEN is not a BotFather token.")
        self._url = f"https://api.telegram.org/bot{token}/"

    def request(self, method, **args):
        request = Request(
            self._url + method,
            data=json.dumps(args).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.load(response)
        except (OSError, ValueError):
            raise TelegramError("Telegram request failed. Check the bot token and connection.") from None
        if not payload.get("ok"):
            raise TelegramError("Telegram could not complete the request.")
        return payload["result"]

    def send(self, chat_id, text, *, prompt):
        options = {"reply_markup": {"force_reply": True}} if prompt else {}
        return self.request("sendMessage", chat_id=chat_id, text=text, **options)["message_id"]


class TelegramExercise:
    def __init__(self, greeting, collect_reply, bot=None):
        self.bot = bot
        self.greeting = f"Roll Call exercise · {BUILDING}\n\n{greeting}"
        self.collect_reply = collect_reply
        self.lock = Lock()
        self.code = secrets.token_urlsafe(16)
        self.username = ""
        self.chat_id = None
        self.prompt_id = None
        self.transcript = []
        self.report = {}
        self.complete = False
        self.health = "Connecting to Telegram…" if bot else ""
        self.revision = 0

    def snapshot(self):
        with self.lock:
            link = None
            if self.username and self.chat_id is None:
                link = f"https://t.me/{self.username}?start={self.code}"
            return {
                "mock": self.bot is None,
                "paired": self.chat_id is not None,
                "link": link,
                "health": self.health,
                "revision": self.revision,
                "transcript": list(self.transcript),
                "report": dict(self.report),
                "complete": self.complete,
            }

    def start(self):
        with self.lock:
            if self.bot and self.chat_id is None:
                raise ValueError("Pair the building manager’s Telegram chat first.")
            if self.prompt_id is not None:
                raise ValueError("The manager already has an open request.")
            self.prompt_id = self._send(self.greeting, prompt=True)
            self.transcript = [{"role": "dispatch", "text": self.greeting}]
            self.report = {}
            self.complete = False
            self.revision += 1
        return self.snapshot()

    def mock_reply(self, text):
        with self.lock:
            if self.bot or self.prompt_id is None:
                raise ValueError("Start a simulated Telegram request first.")
            self._reply(text)
        return self.snapshot()

    def _send(self, text, *, prompt, chat_id=None):
        if self.bot is None:
            return self.revision + 1
        return self.bot.send(chat_id or self.chat_id, text, prompt=prompt)

    def _reply(self, text):
        reply = self.collect_reply(text, self.report)
        # Keep the inbound update unconfirmed if sending the answer fails.
        next_prompt = self._send(reply["reply"], prompt=not reply["complete"])
        self.transcript = (
            self.transcript[-48:]
            + [{"role": "manager", "text": text}, {"role": "dispatch", "text": reply["reply"]}]
        )
        self.report = reply["report"]
        self.complete = reply["complete"]
        self.prompt_id = None if self.complete else next_prompt
        self.revision += 1

    def receive(self, update):
        message = update.get("message", {})
        chat = message.get("chat", {})
        text = message.get("text", "").strip()
        if chat.get("type") != "private" or not text:
            return
        with self.lock:
            if self.chat_id is None and text == f"/start {self.code}":
                self._send(
                    f"Paired as the fictional manager of {BUILDING}. "
                    "Wait for the dispatcher’s exercise message and use Reply to answer it.",
                    prompt=False,
                    chat_id=chat["id"],
                )
                self.chat_id = chat["id"]
            elif (
                chat.get("id") == self.chat_id
                and self.prompt_id is not None
                and message.get("reply_to_message", {}).get("message_id") == self.prompt_id
            ):
                if len(text) > 400:
                    self.prompt_id = self._send(
                        "Please use Reply and keep the fictional report under 400 characters.",
                        prompt=True,
                    )
                    return
                self._reply(text)

    def poll(self):
        offset = 0
        while True:
            try:
                if not self.username:
                    username = self.bot.request("getMe")["username"]
                    with self.lock:
                        self.username = username
                updates = self.bot.request(
                    "getUpdates", offset=offset, timeout=12, allowed_updates=["message"]
                )
                for update in updates:
                    self.receive(update)
                    offset = update["update_id"] + 1
                with self.lock:
                    self.health = ""
            except TelegramError as error:
                with self.lock:
                    self.health = str(error)
                time.sleep(3)
