# Roll Call agent

From the repository root, install the editable package with `python -m pip install -e agent`.
Pass a LangChain chat model that supports tool calling, or a model ID in `provider:model` format.

For example, install `langchain-openai` and set `OPENAI_API_KEY` in your shell to try an OpenAI model.
Use a model ID available to your account.

```python
from rollcall_agent import answer_prompt

print(answer_prompt("Summarize this mock call in one sentence.", model="openai:gpt-5.4-mini"))
```

From `agent/`, install the package and check tools with `python -m pip install -r requirements.txt ruff pytest`.
Run `python -m ruff check .` and `python -m pytest`. The tests use fake chat models and require no API key.

## Simulated manager call

```python
from rollcall_agent.manager_call import run_manager_call

result = run_manager_call(
    {"name": "Juniper Apartments"},
    {"id": "engine-12", "name": "Engine 12"},
    {"disaster_type": "fire"},
)
print(result["transcript"])
print(result["residents_needing_help"])
```

The default is a fictional text exercise with one resident in unit 3B. Pass `simulated_residents=()` to exercise an all-clear or supply a tuple of `{"unit": "...", "need": "..."}` records. A caller-supplied `model` can generate the agent's spoken lines. Structured needs come from the scripted manager fixture.

## Local manager dispatch demo

After installing the agent, run `python -m rollcall_agent.manager_dispatch_demo` and open `http://127.0.0.1:3022`.
Choose **Call highest-priority building** to start a simulated call. To show a reassignment, click **Load sample report** and then **Send report**. Magnolia Court moves to the top of the queue and Engine 7 is reassigned.

Each call uses a fictional 555 number and a temporary ID. The demo parses the unit and type of assistance, runs the scripted Deep Agents conversation, and feeds the confirmed count into dispatch. Notifications are displayed in the UI.
Dictation requires on-device recognition and a local English speech pack. Replies play through an English system voice when available. Use **Replay agent** to hear a reply again, or type the report and read the transcript.

This demo runs on localhost with a scripted model and tracing disabled. It needs no phone provider or API key, and uses fictional phone numbers. If the default port is taken, pass `--port 3024` to the module.

The standalone demo uses its own matcher. To integrate with the app, pass the shared matching function to `rollcall_agent.dispatch.handle_event(state, event, match=...)`. The caller supplies buildings, trucks, and current assignments.

## Dispatcher call console

Run `python -m rollcall_agent.call_chat` and open `http://127.0.0.1:3025`. Click **Call building manager**.
Play the manager with fictional details. Try `Two people in unit 3B need help with stairs.` or answer a field at a time.
The scripted dispatcher asks for missing fields and sends a confirmation to the call transcript and the dispatch report.
The demo is a local exercise. It does not dial the displayed number or send a real dispatch.

For dictation, install the optional engine with `python -m pip install -e "./agent[local-speech]"` from the repository root.
Unpack the [small English Vosk model](https://alphacephei.com/vosk/models) and pass
`--model-dir PATH_TO_UNPACKED_MODEL`. Click **Dictate**, allow the browser to use the microphone, and click
**Stop recording** when finished. The browser sends the clip to localhost for transcription and prompts you
to review it before sending. Audio is processed in memory. Downloading the model is a one-time setup.

### Telegram manager exercise

Choose **Telegram** in the dispatcher console. With no token, **Message building manager** opens a
simulation in the browser. Try `Two people`, `3B`, and `Stairs` to see the follow-up messages and report.

For a live Telegram exercise, create a dedicated demo bot using [@BotFather](https://t.me/BotFather).
After installing the agent, start the console from PowerShell 7:

```powershell
$env:TELEGRAM_BOT_TOKEN = Read-Host -MaskInput "Paste your demo bot token"
python -m rollcall_agent.call_chat --port 3026
```

Open `http://127.0.0.1:3026/?channel=telegram`. On the manager's phone or Telegram Desktop, open the
pairing link and tap **Start**. Keep that link private. In the dispatcher console, click
**Message building manager**. Use Telegram's **Reply** on each bot prompt. The dispatcher console
shows the conversation and report as replies arrive. Restart the local server to pair another chat.
Clear the token from the shell after stopping the demo with `Remove-Item Env:TELEGRAM_BOT_TOKEN`.

The server uses the free Telegram Bot API for one private chat, long polling, and text messages.
Use a dedicated bot with no webhook or other active poller. The exercise uses a scripted responder
without model charges. Use only fictional details since messages go through Telegram and remain in
the Telegram chat. The localhost report lives in memory. This exercise does not place voice calls
or update a live dispatch queue.
