from rollcall_agent.manager_call import run_manager_call


def test_manager_call_collects_unit_needs():
    needs = (
        {"unit": "3B", "need": "Wheelchair assistance"},
        {"unit": "7A", "need": "Help using the stairs"},
    )
    result = run_manager_call(
        {"name": "Juniper Apartments"}, {"id": "engine-12", "name": "Engine 12"},
        {"disaster_type": "fire"}, simulated_residents=needs,
    )

    transcript = result["transcript"]
    assert [turn["speaker"] for turn in transcript] == ["agent", "manager", "agent", "manager", "agent"]
    assert "Engine 12" in transcript[0]["text"]
    assert "unit" in transcript[2]["text"].lower()
    assert all(need["unit"] in transcript[3]["text"] for need in needs)
    assert transcript[-1]["text"].startswith("Thank you")
    assert result["residents_needing_help"] == list(needs)


def test_manager_call_can_report_no_assistance_needed():
    result = run_manager_call(
        {"name": "Juniper Apartments"}, {"id": "rescue-7"},
        {"disaster_type": "flood"}, simulated_residents=(),
    )

    assert result["residents_needing_help"] == []
    assert [turn["speaker"] for turn in result["transcript"]] == ["agent", "manager", "agent"]
    assert "rescue-7" in result["transcript"][0]["text"]
