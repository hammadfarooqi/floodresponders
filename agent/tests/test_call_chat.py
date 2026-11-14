from rollcall_agent.call_chat import reply_to_report


def test_report_handles_dictated_spelling():
    result = reply_to_report("Two people in unit three be need help with stairs.", {})
    assert result["complete"]
    assert result["report"] == {"count": 2, "unit": "3B", "need": "stairs"}
    assert "2 people in unit 3B" in result["reply"]


def test_asks_only_for_missing_details():
    first = reply_to_report("Two people.", {})
    assert first["reply"] == "Which unit are they in?"
    second = reply_to_report("3B", first["report"])
    assert second["reply"] == "What kind of help does unit 3B need?"
    third = reply_to_report("Stairs", second["report"])
    assert third["complete"]
    assert third["report"] == {"count": 2, "unit": "3B", "need": "Stairs"}


def test_all_clear_produces_a_confirmed_empty_report():
    result = reply_to_report("All clear.", {})
    assert result["complete"]
    assert result["report"] == {"count": 0, "unit": None, "need": None}
