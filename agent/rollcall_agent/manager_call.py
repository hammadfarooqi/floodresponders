"""Simulated building-manager conversations and their structured results."""

import json
from typing import Literal, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from rollcall_agent import answer_prompt


class TranscriptTurn(TypedDict):
    speaker: Literal["agent", "manager"]
    text: str


class ResidentNeed(TypedDict):
    unit: str
    need: str


class ManagerCallResult(TypedDict):
    transcript: list[TranscriptTurn]
    residents_needing_help: list[ResidentNeed]


class _ScriptedAgent(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def run_manager_call(
    building: dict,
    responder: dict,
    scenario: dict,
    *,
    simulated_residents: tuple[ResidentNeed, ...] | None = None,
    model: BaseChatModel | str | None = None,
) -> ManagerCallResult:
    """Run a fictional text call. The default uses no model credentials or network."""
    residents = [
        {"unit": resident["unit"], "need": resident["need"]}
        for resident in (
            simulated_residents
            if simulated_residents is not None
            else ({"unit": "3B", "need": "Needs wheelchair assistance to evacuate"},)
        )
    ]
    building_name = building["name"]
    responder_name = responder.get("name") or responder["id"]
    disaster = scenario["disaster_type"]
    prompts = [
        (
            "Introduce yourself on behalf of the responder and ask whether anyone needs evacuation help.",
            (
                f"Hello, this is Roll Call calling {building_name} on behalf of {responder_name} "
                f"about the simulated {disaster}. Does anyone need help evacuating?"
            ),
            "Yes, at least one resident needs help."
            if residents else "No, everyone can evacuate without assistance.",
        ),
    ]
    if residents:
        prompts.append((
            "Ask for the unit numbers and the assistance needed.",
            "Which units need help, and what assistance does each resident need?",
            " ".join(f"Unit {person['unit']}: {person['need']}." for person in residents),
        ))
    prompts.append((
        "Thank the manager and close the simulated call politely.",
        "Thank you for the update. That concludes the simulated call.",
        None,
    ))
    if model is None:
        model = _ScriptedAgent(responses=[AIMessage(content=reply) for _, reply, _ in prompts])

    transcript: list[TranscriptTurn] = []
    for instruction, _, manager_reply in prompts:
        context = {
            "building": building_name,
            "responder": responder_name,
            "disaster": disaster,
            "transcript": transcript,
        }
        reply = answer_prompt(
            f"You are the agent in a fictional Roll Call exercise. Output only your next spoken line. "
            f"{instruction} Conversation context: {json.dumps(context)}",
            model=model,
        )
        transcript.append({"speaker": "agent", "text": reply})
        if manager_reply is not None:
            transcript.append({"speaker": "manager", "text": manager_reply})

    return {"transcript": transcript, "residents_needing_help": residents}
