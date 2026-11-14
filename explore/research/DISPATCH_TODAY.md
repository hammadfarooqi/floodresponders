Last updated: 2026-11-14

# How fire dispatch works today, and where it breaks in a wildfire evacuation

Short research note for the Roll Call dispatcher console. Sources are at the bottom. Most sources are news reports
about official reviews and vendor descriptions of CAD software. We did not read the full official reports.

## Summary

1. **The dispatcher's screen today has four parts:** a list of incidents that wait for a unit (the pending queue),
   a unit status board (available, dispatched, en route, on scene, out of service), a map with the live position of
   each unit (AVL = automatic vehicle location), and the radio. Some centers spread these over 4 to 6 monitors.
2. **CAD recommends, the dispatcher decides.** Computer-aided dispatch (CAD) looks at the call type, the location and
   the unit positions, and proposes units (closest by drive time, or a fixed station order). A dispatcher accepts or
   changes the proposal, then CAD sends the alert to the station and the unit. Some centers have a second person
   check the proposal.
3. **CAD works one call at a time.** The recommendation answers "which unit for this call?". It does not answer
   "which of 300 waiting calls first, with 8 units, before the fire arrives?". In a normal day that is fine. In a
   wildfire, the queue grows faster than people can sort it.
4. **In January 2025 in Los Angeles, the system was overwhelmed.**
   - LAFD 911 calls doubled to about 3,000 in a day. Responders on the ground were confused by the number of calls.
   - A department-wide call-back of staff through the news flooded the LAFD operations center with calls (at times
     up to 100 waiting).
   - Metro Fire Communications contacted assigned units directly and bypassed the incident communications plan.
   - With cell towers down, many 911 callers were relatives who could not reach people in the fire area.
   - Police dispatch routed 911 calls through one captain's personal cell phone for a time.
5. **The people who died were mostly people who could not leave alone.** In the Eaton Fire, most of the 17 to 19
   people who died were over 65, disabled, or both. All or almost all were in west Altadena, where evacuation
   orders came hours later than in the east. Two homebound disabled men died after three 911 calls. Residents were
   left behind at senior care sites. (Reports disagree on whether the evacuation orders were a failure.)

## What this means for Roll Call's console

| Today | Gap in a wildfire | Roll Call console |
|---|---|---|
| Pending queue sorted by time received | No sort by "people who cannot leave alone × time until the fire" | Queue sorted by that priority, with the reason in plain words |
| CAD proposes a unit for one call | Nobody re-plans all units when the fire moves | AI proposes pairings for all trucks, re-matches every few minutes and after calls |
| Dispatcher talks on the radio to every unit | Radio and phone overload | AI makes the routine calls (drivers, building managers); the dispatcher reads a live transcript |
| Status board shows unit state | No view of "why this unit, what changed" | Every pairing change is a card: approve, reject, or edit; the dispatcher can add input ("E27 out of service") |
| 911 callers report one person at a time | Buildings with many people who need help are invisible until someone calls | Building model estimates who needs help; the AI calls building managers first |

Design rules that follow:
- Keep the dispatcher in charge. CAD today already works as "recommend, then a person accepts". Roll Call keeps that
  shape: the AI proposes, the dispatcher approves, rejects or edits. Default: changes apply after a short timer
  unless the dispatcher holds them, so a busy dispatcher does not become the bottleneck.
- Keep the familiar parts: unit status board, pending queue, map, a running log. Add the AI parts next to them.
- Show the reason for every AI decision in one line ("10 need help, fire in 38 min, ETA 4 min").

## Sources (accessed 2026-11-14)

- LAFD, Palisades Fire After-Action Review Report (final, 2025-10-08): https://lafd.org/sites/default/files/pdf_files/Palisades_AARR_10_08_2025_final.pdf
- LAFD AARR fact sheet: https://lafd.org/sites/default/files/pdf_files/AARR_Fact_Sheet.pdf
- CBS LA, LAFD releases Palisades Fire after-action report: https://www.cbsnews.com/losangeles/news/lafd-releases-palisades-fire-after-action-report
- SMDP, LAFD report calls for major changes: https://smdp.com/news/environment/lafd-report-calls-for-major-changes-after-devastating-palisades-fire/
- FireRescue1, LAPD report cites communication failures: https://www.firerescue1.com/emergency-management/lapd-report-cites-communication-failures-confusion-with-lafd-during-palisades-fire
- NBC LA, LAPD Palisades Fire report: https://www.nbclosangeles.com/investigations/lapd-palisades-fire-report/3801575/?amp=1
- NBC, poor communication in the LA fires response: https://www.nbcsandiego.com/news/national-international/poor-communication-emergency-response-la-fires/4081860/
- LAist, 10 takeaways from LAFD's Palisades report: https://laist.com/news/climate-environment/chaos-conflict-and-drones-10-takeaways-from-lafds-report-on-the-palisades-fire
- LAist, county report on Eaton and Palisades failings: https://laist.com/news/climate-environment/l-a-county-report-about-eaton-and-palisades-fires-finds-failings-in-emergency-response
- LAist, two homebound disabled men died after 911 calls: https://laist.com/news/climate-environment/despite-three-911-calls-two-homebound-disabled-men-died-in-the-eaton-fire-waiting-for-rescue
- NBC News, victims had no escape: https://www.nbcnews.com/news/us-news/los-angeles-california-wildfires-victims-no-escape-rcna191087
- Fire Engineering, residents left behind at senior facilities: https://www.fireengineering.com/firefighting/wildland-firefighting/residents-were-left-behind-at-senior-facilities-as-ca-fire-raged-state-finds-serious-lapses/
- Fire Engineering, Citygate review finds no misconduct: https://www.fireengineering.com/firefighting/wildland-firefighting/eaton-fire-no-misconduct-delay-in-evacuation-notices-to-west-altadena-ca-report-says/
- Wikipedia, Computer-aided dispatch: https://en.wikipedia.org/wiki/Computer-aided_dispatch
- Phoenix Regional Dispatch Center (second operator reviews recommended units): https://www.phoenix.gov/administration/departments/fire/about-us/units-divisions/regional-dispatch-center.html
- Radio Mobile, how AVL improves fire/EMS response times: https://radiomobile.com/how-avl-improves-fire-ems-department-response-times/
- Zetron, configuring call-taking and dispatch screens: https://www.zetron.com/blog/configuring-your-call-taking-and-dispatch-screens-for-instant-awareness/
- Motorola Solutions, CAD product overview: https://www.motorolasolutions.com/en_us/products/command-center-software/voice-and-computer-aided-dispatch.html
