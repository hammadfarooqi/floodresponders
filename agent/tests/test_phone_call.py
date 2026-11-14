from xml.etree.ElementTree import fromstring

from rollcall_agent.phone_call import PhoneTest


def test_answer_and_complete_report():
    call = PhoneTest("https://voice.example")
    answer = fromstring(call.respond("answer", {}))
    assert answer.find("Gather").get("action") == call.url + "/report/1"

    payload = {"SpeechResult": "Two people. Unit 3 B needs help with stairs."}
    reply = call.respond("report/1", payload)
    assert "I logged 2 people" in fromstring(reply).findtext("Say")
    assert call.result == {
        "status": "report_received",
        "count": 2,
        "unit": "3B",
        "need": "stairs",
    }
    assert call.respond("report/1", payload) == reply


def test_follow_up_only_for_missing_details():
    call = PhoneTest("https://voice.example")
    reply = fromstring(
        call.respond("report/1", {"SpeechResult": "Unit 3B needs help with stairs."})
    )
    assert "repeat the number" in reply.findtext("Gather/Say")
    call.respond("report/2", {"SpeechResult": "Two people."})
    assert call.result["count"] == 2
    assert call.result["unit"] == "3B"


def test_empty_speech_gets_one_retry_and_all_clear_is_structured():
    empty = PhoneTest("https://voice.example")
    assert fromstring(empty.respond("report/1", {})).find("Gather") is not None
    assert fromstring(empty.respond("report/2", {})).find("Gather") is None
    assert empty.result == {"status": "incomplete_report"}

    clear = PhoneTest("https://voice.example")
    clear.respond("report/1", {"SpeechResult": "All clear."})
    assert clear.result == {
        "status": "report_received",
        "count": 0,
        "unit": None,
        "need": None,
    }
