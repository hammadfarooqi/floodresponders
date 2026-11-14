# Two-minute Roll Call demo

Use the integrated web and API build for the steps below once scenario controls, dispatch, and manager calls are wired together. Start the components using the [README](../README.md) and load the fictional sample city.

| Time | Action | What to show |
| --- | --- | --- |
| 0:00–0:20 | Open the map and pick **Fire**, **North**, and severity **3**. Run the scenario. | Exposure, evacuation difficulty, and estimated arrival time determine the building score. |
| 0:20–0:50 | Open the highest-ranked building and look at its responder assignment. | The queue ranks buildings by risk and assigns the nearest eligible responder while units are available. |
| 0:50–1:30 | Start the manager call for an assigned building. Read the transcript and flagged units. | The agent identifies the assigned responder and asks who needs help. The scripted manager reports the unit and the assistance needed. |
| 1:30–2:00 | Return to the queue and show the building's updated priority. | The call result informs the queue. Reset the scenario to clear the previous call data. |

For the current component review, open the [standalone map](https://github.com/hammadfarooqi/floodresponders/pull/33) and select a highlighted building to show its mock score. Then run the [scripted call example](../README.md#run-locally) in the [manager call checkout](https://github.com/hammadfarooqi/floodresponders/pull/41) to show the transcript and structured unit-level result.
