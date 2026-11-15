# Roll Call: what to say to the judges

About 3 minutes of talk, then answers to likely questions. Short sentences. Numbers are from
`node explore/scripts/run_sim.ts` with the default assumptions (fire stops at Hollywood Blvd).

---

## 1. The problem (30 s)

- In January 2025, the people who died in the LA fires were mostly people who **could not leave alone**:
  older people and people with disabilities. In Altadena, two homebound men called 911 three times and died waiting.
- Dispatch centers were overloaded. Calls doubled. The software they use (CAD) recommends a truck for **one call
  at a time**. Nothing re-plans all the trucks while the fire moves.
- So the real question in an evacuation is: **who cannot get out, and which truck should go to them first?**

## 2. What we built (30 s)

- **Roll Call** knows the buildings before anyone calls. For every building we estimate how many people live there
  and how many will need help. Sources: Vexcel outlines (all 42,557 buildings), LA County Assessor (units),
  CoStar (stories, senior housing, the building manager's phone).
- An **AI dispatcher** pairs fire trucks with buildings and keeps re-planning as the fire moves.
- An **AI phone agent** calls building managers and drivers, and listens to them ("a tenant is stuck",
  "we can't go, we're on a medical call").
- A human **dispatcher stays in charge**. They see every call and every change, and can undo or change any of them.

## 3. How the simulation works (60 s)

Say: "To test the idea, we built a simulation of one fire. Every step uses real data or a labeled assumption."

1. **The fire.** The real Sunset Fire start point (Runyon Canyon, 8 Jan 2025), with a stronger wind toward
   Hollywood. The fire spreads over a 30 m grid: fast in brush, slower between buildings, faster downwind.
   Crews stop it at Hollywood Blvd after 3 hours. From this we know **the minute the fire reaches each building**.
2. **The people.** 1,527 buildings with people are in the fire's path: about **21,600 people**, and about
   **1,900 who need help** (people per building = units × 2.4 × 95% occupied; need help = 10%).
   Everyone gets the evacuation order at minute 0.
   - People who can leave alone leave quickly (15% of those still inside, every minute).
   - People who need help almost never get out alone (1% per minute). With a fire crew there, 1.5 people per minute.
   - Everyone walks out on real streets, away from the fire. For each building we compute the last minute a person
     can start walking and still stay ahead of the fire. After that minute, people stay inside, and anyone still
     inside when the fire arrives counts as trapped. So nobody on the map walks through the fire.
3. **The trucks.** 8 fire engines start at the real LAFD stations south of the hills. They drive on the real
   street network (OpenStreetMap) at 30 km/h, and streets close when the fire reaches them.
4. **Two runs, same everything.** Same fire, same people, same trucks, same 911 calls. Only the dispatch changes.
   - **Today (911 calls):** in 70% of buildings with people who need help, someone calls 911, 10–60 minutes before
     the fire arrives. 4 call-takers answer in the order calls arrive (2.5 min each). The oldest answered call gets
     the closest free truck (this is what dispatch software does with truck GPS). Trucks do not re-plan. A building
     that never gets through gets no truck. On the map, a red 📞 shakes above a building that called and still waits.
   - **Roll Call:** described in section 4. It gets the same 911 calls, but it does not wait for them.

**What the map shows.** A dashed line = a truck driving to that building. Yellow buildings have people inside. Blue buildings are empty. Red buildings burned with
people inside. Green dots are people walking out along the streets, purple dots are people who needed help.

## 4. How the AI chooses where each truck goes (45 s)

Say: "For every truck and every building, the AI asks one question: how many people does this help, per minute
of truck time?"

- **People who need help** in the building (our estimate, or the number a phone call gave us).
- **× urgency:** how soon the fire arrives. A building 30 minutes from the fire counts half as much as one the
  fire reaches now.
- **÷ truck time:** drive time on real streets + time to bring everyone out.
- **Only if the truck can arrive at least 3 minutes before the fire.** We never send a crew into a building
  it cannot reach in time.
- It takes the best truck-building pair, then the next best, until every free truck has a job.
- It **re-plans every 5 minutes and after every phone call**, because the fire and the trucks keep moving.

Two calls in the demo show this:
- At 0:35 a driver says "we can't go, we're on a cardiac call". The AI marks the truck out of service and moves
  the building to another truck.
- At 1:40 a building manager says "a tenant in a wheelchair is stuck on the 4th floor". The AI adds 3 people who
  need help, re-plans, sends the nearest truck, and calls the manager back with the arrival time.

## 5. The result (15 s)

| Same fire, people, calls and trucks | Today (911 calls) | Roll Call |
|---|---|---|
| People trapped | 310 | 52 |
| ... of them people who needed help | 299 | 41 |

"In this simulation, Roll Call leaves about **83% fewer people trapped**." While the run plays, point at the red
phones: those are people waiting in the 911 queue. In the Roll Call run, trucks are often already on the way
before anyone calls.

## 6. Why you can trust the comparison (30 s)

- **Fair test.** Both runs use the same fire, the same people and the same trucks. Only the rule differs.
- **Every assumption is on screen** (click "show assumptions"). Nothing is hidden in the code.
- **We tried changing each assumption.** Fewer or more people calling 911 (40% to 100%), 2 to 10 call-takers,
  slower or faster crews, trucks at 20 or 45 km/h, people leaving more slowly, other random seeds. Today's dispatch
  traps 280 to 470 people; Roll Call traps 44 to 136. **Roll Call is better in every case.** The exact numbers
  change a lot; the direction does not.
- **We say what it is not.** This is a simulation with assumptions. It is not a count of real lives saved, and
  the phone calls in the demo are scripted. The fire model ignores slope, wind gusts and embers.

## 7. The dispatcher's screen (30 s, if time)

- Open `/console`. Familiar parts of a real dispatch screen: unit status board, map, pending queue, log.
- New parts: every AI pairing appears as a card with its reason ("22 need help, fire in 60 min, ETA 2 min").
- The dispatcher can **undo** it, **send a different truck**, or type an order: "E27 out of service 20 minutes",
  "hold E35", "2 people stuck at Franklin Plaza".
- We tried making the dispatcher approve every move first. It **trapped more people than the old way**, because
  trucks waited for clicks. So the AI acts at once, and the human corrects it. This matters in a real emergency.

---

## Likely questions

- **"Where does 'needs help' come from?"** Today: 10% of residents (a placeholder until we add census data on
  age and disability per area). CoStar marks senior housing and walk-ups. A phone call replaces the estimate
  with the real number.
- **"Why is today's dispatch so bad here?"** Three reasons: people must get through on 911 first (some never do,
  and calls wait in a queue); the oldest call is served first, not the one the fire reaches first; and a truck
  never changes its job when something more urgent appears.
- **"Is this a fair copy of real dispatch?"** It follows what dispatch centers publish: calls are answered in the
  order received, and dispatch software recommends the closest available unit by GPS. Real dispatchers can
  re-prioritize by hand; in January 2025 the call volume was too high for that. Sources: explore/research/DISPATCH_TODAY.md.
- **"Even if everyone calls?"** Then today's dispatch still traps about 336 people: the queue gets longer.
- **"Why trust the AI to move trucks by itself?"** It shows its reason for every move, the dispatcher can undo
  any move, and the dispatcher can lock a truck ("hold").
- **"How long does the matching take?"** About 50 ms for all 8 trucks over 74,000 street corners, in the browser.

## Before the demo

- Start: `cd explore && npm run demo`, then open http://localhost:3002/sim. Open **one page at a time**.
- Run 1 (old way), then Run 2 (Roll Call). "Pause on calls" stops the run at each call, so you can read it.
- "3D hills" makes the map prettier but slower. Turn it on only for a still camera shot.
