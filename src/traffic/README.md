# AI traffic (`src/traffic`)

Pattern traffic at the player's airport, MSFS-style: a few light aircraft fly touch-and-go
circuits on the runway in use, ATC calls them as traffic, and the VFR map shows them.

| File | Content |
|---|---|
| `pattern.ts` | `PatternAircraft`: kinematic path follower in runway coordinates (also the ground legs: parked, taxi, holding, line-up) (x along from the landing threshold, y right, h above the threshold). Legs: take-off roll, upwind, crosswind, downwind at 1,000 ft, base, 3° final, landing roll, touch-and-go; go-around. Turn-rate-limited steering (6 °/s, bank from the turn), speed and vertical-speed limits per type (`C172_PATTERN`, `CUB_PATTERN`). Pure and deterministic (seeded `rng`). |
| `TrafficManager.ts` | Picks the airport (spawn airport, or the nearest within 8 km) and the runway most into the surface wind (`chooseRunway`; calm wind keeps the player's runway), places 1-2 aircraft around the circuit, sequences them (extend downwind while another aircraft is on base/final or the player is on final; go around from short final when the runway is occupied by the player or another AI), and draws them with the exterior of `AircraftModel` (no cockpit, no shadows, landing/taxi spot lights removed so the scene's light count never changes). |
| `advisor.ts` | `TrafficAdvisor`: controller-style traffic calls ("N172FS, traffic, ten o'clock, one mile, Cessna on left crosswind, nine hundred") for airborne traffic within 2 nm and 1,000 ft that is converging or closer than 0.75 nm, at most one per aircraft per 90 s. |

Geodetic simulation: positions come from the runway threshold and true heading, so floating-origin
rebases need nothing; each frame re-projects them through the current local frame. The traffic
advances on simulated time (frozen while paused, slewing or replaying; faster under time
compression). Graphics quality 'low' keeps one aircraft.

Wiring (src/app/Simulator.ts): `sim.traffic` (the manager), `SimSnapshot.traffic` (the targets, for
the VFR map's TCAS-style diamonds with relative altitude and trend), advisories on `atc:message`
and the ATC voice.

Ground traffic (when the OSM scenery provides stands and taxiways): `TrafficManager.setGround`
parks aircraft at stands (2 at small fields, 4 elsewhere, never within 80 m of the player). One or
two of them start up, taxi along the taxi graph (src/world/taxiGraph.ts) to the hold-short point of
the runway in use at 15 kt (7 kt into turns), stop for the player or another aircraft within ~50 m
ahead, hold short until the runway and final are clear, line up, take off and depart straight out;
8 km out they come back as arrivals on a 6.5 km straight-in, land to a full stop, roll to an exit
about 600 m past touchdown, taxi in to their stand (`TaxiGraph.routeBetween`), park, and later
depart again. The second departing aircraft starts inbound, so there is an arrival early on. The circuit is put on the best-ranked
runway the stands can actually taxi to (OSM taxiway networks are not always connected).

`TrafficManager.aheadOf` gives ATC the aircraft ahead of the player in the landing sequence
(tower: "number two, follow the Cessna on left base"); the simulator also hands ATC the OSM taxi
route for taxi clearances (src/atc README).

Not yet: traffic on the G1000 map.
