# 02 — Flight Dynamics Model (FDM) specification: Cessna 172-class GA aircraft, with a jet-transport archetype

Status: research complete, implementation-ready. Target: TypeScript, fixed-step 120–240 Hz, runs in a browser worker, no backend.

Conventions used throughout:

* Internal units are **SI** (m, kg, s, rad, N, Pa). Source data are mostly imperial (JSBSim); conversions: 1 ft = 0.3048 m, 1 kt = 0.514444 m/s, 1 lbf = 4.44822 N, 1 lb (mass) = 0.453592 kg, 1 slug·ft² = 1.355818 kg·m², 1 lb/ft (spring) = 14.5939 N/m, 1 lb·s/ft (damper) = 14.5939 N·s/m, 1 hp = 745.7 W, 1 inHg = 3386.39 Pa, 1 US gal avgas = 6.0 lb = 2.72 kg.
* Body axes: **x forward, y right (starboard), z down** (FRD). Rates p,q,r about x,y,z. Earth frame: local **NED** tangent plane. Three.js is Y-up right-handed, so `three = (E, -D, -N)` i.e. `x3 = E, y3 = -D (= altitude), z3 = -N`. Do the conversion only at the render boundary.
* Aerodynamic angles: α = atan2(w_a, u_a), β = asin(v_a / V_a). Positive elevator δe = trailing edge **down** (nose-down moment, Cmδe < 0). Positive aileron δa = **left aileron trailing edge down** (right roll, Clδa > 0). Positive rudder δr = trailing edge **left** (nose-left, Cnδr < 0). These are the JSBSim conventions, so the tables below can be used without sign flips.
* Nondimensional rates: p̂ = p·b/(2V), q̂ = q·c̄/(2V), r̂ = r·b/(2V) (JSBSim `bi2vel`, `ci2vel`).

Primary sources (fetched and transcribed in this document):

* JSBSim `c172p.xml` (Roskam-derived derivatives, flap and ground-effect tables): https://raw.githubusercontent.com/JSBSim-Team/jsbsim/master/aircraft/c172p/c172p.xml — LGPL-2.1; the file header says "educational and entertainment purposes only ... not to be sold". Use the numbers as engineering data and re-tune to POH, do not ship the XML.
* JSBSim `c172x.xml` (variant with a DATCOM CLα(α,β,flap) table): https://raw.githubusercontent.com/JSBSim-Team/jsbsim/master/aircraft/c172x/c172x.xml — LGPL-2.1.
* FlightGear c172p-team FDM (the most refined open C172 FDM; adds post-stall/spin tables, slipstream yaw, 180 hp IO-360 + 76 in NACA-640 prop): https://raw.githubusercontent.com/c172p-team/c172p/master/c172p.xml, engine https://raw.githubusercontent.com/c172p-team/c172p/master/Engines/eng_io360.xml, prop https://raw.githubusercontent.com/c172p-team/c172p/master/Engines/prop_76in2f_NACA_20deg.xml — GPL-2.0.
* JSBSim engine/prop/gear/turbulence source used for formulas: `FGPiston.cpp`, `FGPropeller.cpp`, `FGLGear.cpp`, `FGPropagate.cpp`, `FGAuxiliary.cpp`, `atmosphere/FGWinds.cpp` under https://raw.githubusercontent.com/JSBSim-Team/jsbsim/master/src/models/ — LGPL-2.1 (formulas are not copyrightable; do not copy code).
* JSBSim `737.xml` + `engine/CFM56.xml` for the jet archetype — LGPL-2.1.
* NACA Report 640 (prop 5868-9 data behind the FlightGear prop table): public domain (US Gov).
* MIL-F-8785C (Dryden turbulence constants, via FGWinds.cpp comments with page refs): public domain (US Gov).
* AeroSandbox `inviscid.py` (Phillips & Hunsaker / Torenbeek ground-effect fit): https://raw.githubusercontent.com/peterdsharpe/AeroSandbox/master/aerosandbox/library/aerodynamics/inviscid.py — MIT.
* Cessna 172S POH figures (confirmed by multiple secondary pages found via search, e.g. [Purdue 172SP data sheet](https://www.purdueaviationllc.com/storage/app/media/Data%20Sheets/C172SP%20Data%20Sheet.pdf), [H-Aviation 172S page](https://www.h-aviation.com/cessna-172s---skyhawk.html), [flyawaysimulation V-speeds](https://flyawaysimulation.com/ask/answers/cessna-172-v-speeds-meanings/)). The POH itself is copyrighted (Textron); numbers are used as facts only. Hosts such as befa.org, wayman.edu, mathworks.com, ntrs.nasa.gov, groups.google.com were **not reachable** from this session, so a few POH table rows are marked *(approx., verify)*.

---

## 1. Equations of motion (6-DOF rigid body, body axes, quaternion attitude)

### 1.1 State vector (SI)

```ts
// 13 rigid-body states + actuator/engine/filter states
interface RigidState {
  pos: Float64Array;   // [N, E, D] metres in the local tangent plane (double precision!)
  vel: Float64Array;   // [u, v, w] body-axis inertial velocity (m/s)
  q:   Float64Array;   // [q0, q1, q2, q3] unit quaternion, NED -> body (scalar first)
  omega: Float64Array; // [p, q, r] body rates (rad/s)
}
```

Keep `pos` in doubles and re-base the local tangent-plane origin whenever |pos| > ~50 km (recompute origin lat/lon, subtract). Three.js Float32 positions lose cm precision beyond ~10 km, so the renderer should also use a floating origin (camera-relative rendering). Geodetic lat/lon/alt are derived from `pos` + origin with a flat-earth or WGS-84 local conversion (fine for a GA sim; curvature error over 50 km is ~200 m vertical, so either re-base often or add the curvature correction `Δh = d²/(2R)`).

### 1.2 Translational dynamics (body axes)

```
u̇ = r·v − q·w + gx + Fx/m
v̇ = p·w − r·u + gy + Fy/m
ẇ = q·u − p·v + gz + Fz/m
```

with gravity in body axes from the quaternion (NED gravity is (0,0,g)):

```
gx = −g·(2(q1·q3 − q0·q2))      = −g·sinθ
gy =  g·(2(q2·q3 + q0·q1))      =  g·sinφ·cosθ
gz =  g·(q0² − q1² − q2² + q3²) =  g·cosφ·cosθ
```

F = aero + propulsion + gear + external (tow/wind-gust loads). Use g = 9.80665 (altitude variation negligible).

### 1.3 Rotational dynamics with Ixz (Stevens & Lewis form)

Inertia tensor `I = [[Ixx,0,−Ixz],[0,Iyy,0],[−Ixz,0,Izz]]` (Ixy = Iyz = 0 by symmetry). With Γ = Ixx·Izz − Ixz²:

```
Γ·ṗ = Ixz·(Ixx − Iyy + Izz)·p·q − [Izz·(Izz − Iyy) + Ixz²]·q·r + Izz·L + Ixz·N
Iyy·q̇ = (Izz − Ixx)·p·r − Ixz·(p² − r²) + M
Γ·ṙ = [(Ixx − Iyy)·Ixx + Ixz²]·p·q − Ixz·(Ixx − Iyy + Izz)·q·r + Ixz·L + Ixx·N
```

Equivalent (and simpler to keep correct as mass changes): `ω̇ = I⁻¹·(M − ω × (I·ω) − H_prop_term)`, where the propeller gyroscopic term is `ω × H_p`, `H_p = (I_prop·ω_prop, 0, 0)` (JSBSim `FGPropeller::Calculate`: `vMn = PQRi × (mT·vH) + mT·vTorque`). Recompute `I⁻¹` only when fuel/payload changes.

### 1.4 Quaternion kinematics and normalization

`q̇ = ½ · q ⊗ (0, p, q, r)` (q maps NED → body). Component form:

```
q̇0 = −½(p·q1 + q·q2 + r·q3)
q̇1 =  ½(p·q0 + r·q2 − q·q3)
q̇2 =  ½(q·q0 − r·q1 + p·q3)
q̇3 =  ½(r·q0 + q·q1 − p·q2)
```

Renormalize after every step (`q /= |q|`). Euler angles for instruments: `φ = atan2(2(q0q1+q2q3), 1−2(q1²+q2²))`, `θ = asin(clamp(2(q0q2−q3q1),−1,1))`, `ψ = atan2(2(q0q3+q1q2), 1−2(q2²+q3²))`. Position: `ṗ_NED = C_nb · v_body`, `C_nb = C_bnᵀ` from q.

### 1.5 Integration scheme: recommendation

| Scheme | dt | Cost | Verdict |
|---|---|---|---|
| Explicit Euler | 1/120 | 1 eval | **Do not use** — marginal on gear/roll-mode stiffness, energy drift in phugoid. |
| Semi-implicit (symplectic) Euler: integrate ω̇, v̇ first, then q and pos with the *new* velocities | 1/240 | 1 eval | Acceptable, very cheap, good for ground contact (velocity-first makes gear damping implicit-ish). JSBSim's default is close to this: `eAdamsBashforth2` for translational rate, `eAdamsBashforth3` for position, rectangular Euler for rotational rate/attitude at 120 Hz ([FGPropagate.cpp](https://raw.githubusercontent.com/JSBSim-Team/jsbsim/master/src/models/FGPropagate.cpp)). |
| **RK4 over the full 13-state (+ RPM) with forces re-evaluated at each stage** | **1/120** | 4 evals | **Recommended.** 480 force evaluations/s is trivial in JS (~20 µs each). Stable for all airframe modes and the JSBSim gear constants below; better phugoid energy behaviour; sub-stepping to 1/240 only needed with very stiff gear (k > ~200 kN/m per wheel on a light aircraft) or for the jet. |

Stability check at dt = 1/120 s (8.33 ms), C172 values from §5/§6: main-gear eigenvalue c/m ≈ 23 350/(0.45·1157) ≈ 45 s⁻¹ → |λ·dt| ≈ 0.37 (RK4 real-axis limit 2.78; explicit Euler limit 2.0, so even Euler is stable but with little margin for the nose gear and 20 000 lb/ft structure points). Roll mode λ ≈ −11 s⁻¹ (τ ≈ 0.09 s at 100 KTAS) → |λ·dt| = 0.09. Short period ωn ≈ 5–7 rad/s → 0.05. Nothing in the aircraft forces sub-millisecond steps; what *does* cause jitter is discontinuous friction (see §5.6), not the integrator.

Fixed-step driver (render decoupled):

```ts
const DT = 1 / 120; let acc = 0;
function frame(realDtSec: number) {
  acc += Math.min(realDtSec, 0.25);          // clamp to avoid spiral of death
  while (acc >= DT) { prev = cur; cur = rk4Step(cur, inputs, DT); acc -= DT; }
  render(lerpState(prev, cur, acc / DT));    // slerp q, lerp pos
}
```

Run the FDM in a Web Worker and post `{t, pos, q, derived}` to the main thread each FDM step (or batch per frame); main thread interpolates.

### 1.6 Aerodynamic angles, airspeed and α̇

```
v_air_body = v_body − C_bn · (wind_NED + gust_NED + turbulence_NED)
V = |v_air_body|;  Vxz = sqrt(u_a² + w_a²)
α = atan2(w_a, u_a);  β = asin(v_a / max(V, 0.1))
α̇ = (u_a·ẇ_a − w_a·u̇_a) / max(Vxz², 0.01)   // JSBSim FGAuxiliary: adot = (u·wdot − w·udot)/(u²+w²)
q̄ = ½ρV²;  q̄_uw = ½ρ·Vxz²  // JSBSim uses q̄_uw for the α̇ terms to kill a ground oscillation in pure crosswind (issue #89)
```

Use the previous step's accelerations for α̇ (or a first-order filter τ = 0.05 s) to avoid an algebraic loop. Clamp `1/V` terms with `V ≥ 1 m/s`.

### 1.7 Force/moment assembly (wind axes → body)

```
L = q̄·S·CL;  D = q̄·S·CD;  Y = q̄·S·CY
Fx = −D·cosα·cosβ − Y·cosα·sinβ + L·sinα
Fy = −D·sinβ      + Y·cosβ
Fz = −D·sinα·cosβ − Y·sinα·sinβ − L·cosα
Mx(roll) = q̄·S·b·Cl ;  My(pitch) = q̄·S·c̄·Cm ;  Mz(yaw) = q̄·S·b·Cn
M_total = M_aero + r_ARP × F_aero + Σ (r_i × F_i) for gear/engine
```

`r_ARP` is the aerodynamic reference point relative to the **current CG** (body frame). All Cm values below are about the ARP at 25 % MAC; CG shift is handled by the cross product, so CG range (§6) works automatically.

---

## 2. Aerodynamic model — Cessna 172 coefficients (actual numbers)

### 2.1 Geometry and reference values

| Item | Value (imperial, JSBSim) | SI | Note |
|---|---|---|---|
| Wing area S | 174 ft² | 16.165 m² | all three sources |
| Span b | 35.8 ft (c172p/FG), 36.0 ft (c172x) | 10.91 m / 10.97 m | 172S actual 36 ft 1 in = 11.0 m |
| MAC c̄ | 4.9 ft | 1.494 m | FG: 25 % MAC at FS 40.6 in |
| Aspect ratio | 7.37 | | |
| H-tail area / arm | 21.9 ft² / 15.7 ft | 2.03 m² / 4.79 m | V_H = 0.394 |
| V-tail area | 16.5 ft² | 1.53 m² | arm ≈ 15 ft (not given in file) |
| ARP (c172p) | FS 43.2 in, WL 59.4 in | | FG: FS 41.2, WL 29.3 |
| Stall hysteresis limits | α ∈ [0.09, 0.36] rad | | see §3.3 |

### 2.2 Longitudinal derivatives (per rad, flaps 0, out of ground effect)

| Coef. | JSBSim c172p | JSBSim c172x | FlightGear c172p | Recommended | Comment |
|---|---|---|---|---|---|
| CL0 (α=0) | 0.25 (table) | 0.25 | 0.25 | 0.25 | zero-lift α ≈ −2.9° |
| CLα | ≈ 4.6–5.3 (table slope; 5.33 between −0.09 and 0.09 rad, 4.8 from 0 to 0.1) | 4.53–4.74 table (CLα(α,β,flap), DATCOM) | same table as c172p | **4.6** | Roskam-type value; use the table in §3.1 instead of a constant |
| CLq | 3.9 | 3.9 | 3.9 | 3.9 | × q̂ |
| CLα̇ | 1.7 | 1.7 | 1.7 | 1.7 | × α̇·c̄/(2V), use q̄_uw |
| CLδe | 0.43 | 0.347 | (same as c172p) | 0.43 | per rad of δe |
| CD0 (total at α=0, flaps 0) | 0.027 + 0.0052 = 0.0322 | 0.032 + 0.0052 = 0.0372 | ≈0.032 | **0.032** | NASA SP-468 cited by c172x for 0.032 |
| k (induced, CD = CD0 + k·CL²) | fit of c172p table: k = 0.0815 (e ≈ 0.53) | ~0.08 | same | 0.055–0.08 (tune to POH glide, see §10) | Table includes profile-drag rise; pure induced k = 1/(π·AR·e) with e = 0.75 → 0.0576 |
| CDδe | 0.06·|δe| | 0.06·|δe| | 0 | 0.06·|δe| | |
| CDβ | 0.17·|β| | 0.17·|β| | 0.15·|β| | 0.17·|β| | |
| Cm0 | 0.10 | 0.10 | 0.09 → 0.04 (table vs q̄: 13.6 psf → 21.2 psf) | 0.10 | FG's q̄ table is a trim hack |
| Cmα | −1.8 | −1.8 | −1.0 (× tail-stall factor table) | **−1.0 to −1.2** at 25 % MAC | FG comment: "−0.61 to −0.65 Megginson, −0.89 Roskam". −1.8 is over-stable; Cmα = −CLα·SM → SM ≈ 0.22 for −1.0 |
| Cmq | −12.4 | −12.4 | −12.4 | −12.4 | × q̂ |
| Cmα̇ | −7.27 | −5.2 | −7.27 | −7.27 | × α̇·c̄/(2V), use q̄_uw |
| Cmδe | −1.122 (× q̄ incl. prop induced velocity) | −1.28 | −1.0 (× q̄_induced × stall table) | **−1.122** with slipstream q̄ (§4.6) | |
| Cmδf | 0/−0.0654/−0.0981/−0.1140 (10/20/30°) | 0/−0.03/−0.05/−0.06 | 0/−0.008/−0.016/−0.024 | see §3.4 | |

Provenance note: the c172p values CLq 3.9, CLα̇ 1.7, Cmq −12.4, Cmα̇ −7.27, CLδe 0.43, Cmδe −1.122, CYp −0.075, CYr 0.214, Clp −0.484, Clr 0.0798, Clδa 0.229, Clδr 0.0147, Cnp −0.0278, Cnr −0.0937, CYδr 0.187 match, digit for digit, the Roskam *Airplane Flight Dynamics and Automatic Flight Controls* Part I Appendix B "Airplane A" cruise table (quoted second-hand on [sci.aeronautics](https://groups.google.com/d/topic/sci.aeronautics/69ECYNDKIJA) as "Cessna 172": 5000 ft, 219 ft/s, 2645 lb, CG 25 % MAC, Ixx 948 / Iyy 1346 / Izz 1967 slug·ft², CLα 4.6, Cmα −0.89, Clβ −0.089, Cnβ 0.065). *Caution:* 2645 lb exceeds any 172 MTOW; the Roskam airplane is almost certainly the Cessna 182 (same wing). The numbers are nevertheless the standard open C172 set used by JSBSim/FlightGear for 20+ years and fly correctly after tuning to the POH.

### 2.3 Lateral-directional derivatives (per rad)

| Coef. | c172p | c172x | FlightGear c172p | Recommended |
|---|---|---|---|---|
| CYβ | −0.393 (flaps 0), −0.304 (flaps 30) [table ±0.137/±0.106 at β=±0.349] | −0.31 | n/a (table) | −0.393 |
| CYp | −0.075 (α=0) → −0.145 (α=0.094); flaps 30: −0.161 → −0.231 | −0.037 | — | −0.075 |
| CYr | 0.214 (α=0) → 0.267 (α=0.094); flaps 30: 0.162 → 0.215 | 0.21 | — | 0.214 |
| CYδa | 0 | −0.05 | — | 0 |
| CYδr | 0.187 | 0.098 | — | 0.187 |
| Clβ | −0.0923 (table ±0.0322 at β=±0.349) | −0.0891 | −0.092 (× 1 → 3.5 between α 0.279–0.297 rad for spin) | **−0.0923** |
| Clp | −0.484 | −0.47 | −0.484 | −0.484 |
| Clr | 0.0798 (α=0) → 0.1869 (α=0.094); flaps 30: 0.1246 → 0.2317 | 0.08 → 0.19 | 0.0798 / 0.2039 (α 0.07) / 0.1869 (α 0.09) | 0.0798 + 1.14·CL-ish; or table |
| Clδa | 0.229 | 0.23 | 0.20 (× 1 → 0.3 → −0.1 at α 0.279/0.297/0.611) | 0.229 |
| Clδr | 0.0147 | 0.0147 | 0.0147 | 0.0147 |
| Cnβ | 0.0587 (table ±0.0205 at ±0.349) | 0.065 | 0.0587 | **0.0587** |
| Cnp | −0.0278 | −0.03 | −0.0278 / −0.0960 (α 0.07) / −0.0649 (α 0.094) | −0.0278 |
| Cnr | −0.0937 | −0.099 | −0.0937 | −0.0937 |
| Cnδa | −0.0053 | +0.0053 (sign convention differs) | −0.0216 (α=0) → −0.0786 (α 0.07, β 0) → −0.0504 (α 0.094); halved at |β|=0.35 | **−0.0216**, or −0.2·CL·Clδa (adverse yaw) |
| Cnδr | −0.0430 (× slipstream q̄) | −0.043 | −0.0645 (× slipstream q̄) | **−0.0645** (Roskam) with slipstream q̄; −0.043 if using free-stream q̄ |

Rudder authority sanity check (used in §4.7): at 60 KCAS, q̄ = 585 Pa; N_δr = q̄·S·b·Cnδr·δr = 585·16.165·10.91·0.0645·0.279 = 1 857 N·m at full (16°) rudder.

---

## 3. Lift/drag tables, post-stall, flaps, ground effect

### 3.1 CL(α) table with stall hysteresis (c172p = c172x = FlightGear; α in rad)

Column 0: normal branch (`stall-hyst-norm = 0`); column 1: post-stall branch (`= 1`). Multiply by `kCLge` (ground effect, §3.5). Flags: set to 1 when α > 0.36 rad (20.6°), reset to 0 when α < 0.09 rad (5.2°) — JSBSim `hysteresis_limits`.

```
α(rad)  CL_normal  CL_poststall
-0.09   -0.22      -0.22
 0.00    0.25       0.25
 0.09    0.73       0.73
 0.10    0.83       0.78
 0.12    0.92       0.79
 0.14    1.02       0.81
 0.16    1.08       0.82
 0.17    1.13       0.83
 0.19    1.19       0.85
 0.21    1.25       0.86
 0.24    1.35       0.88
 0.26    1.44       0.90
 0.28    1.47       0.92     <- CLmax 1.47 at 16.0°
 0.30    1.43       0.95
 0.32    1.38       0.99
 0.34    1.30       1.05
 0.36    1.15       1.15
# FlightGear extension (both columns):
 0.52    1.47       1.47
 0.70    1.65       1.65
 0.87    1.47       1.47
 1.05    1.17       1.17
 1.57    0.01       0.01
```

Vs check: CLmax 1.47 at 2550 lb (1157 kg) gives Vs1 = sqrt(2W/(ρ0·S·CL)) = 27.9 m/s = 54.3 KCAS vs POH 53 KCAS (48 KIAS). With trailing-edge-up elevator at the stall (δe ≈ −15° → ΔCL = 0.43·(−0.26) = −0.11) the model stalls ~2 kt fast; scale CLmax to ≈1.55–1.60 for a 172S, or accept (±3 kt tolerance).

### 3.2 CD(α, flap) table (c172p `CDwbh`, add CD0 = 0.027 and `kCDge` multiplier; α rad; columns flap 0/10/20/30°)

```
α       δf=0     10       20       30
-0.0873 0.0041   0.0000   0.0005   0.0014
-0.0698 0.0013   0.0004   0.0025   0.0041
-0.0524 0.0001   0.0023   0.0059   0.0084
-0.0349 0.0003   0.0057   0.0108   0.0141
-0.0175 0.0020   0.0105   0.0172   0.0212
 0.0000 0.0052   0.0168   0.0251   0.0299
 0.0175 0.0099   0.0248   0.0346   0.0402
 0.0349 0.0162   0.0342   0.0457   0.0521
 0.0524 0.0240   0.0452   0.0583   0.0655
 0.0698 0.0334   0.0577   0.0724   0.0804
 0.0873 0.0442   0.0718   0.0881   0.0968
 0.1047 0.0566   0.0874   0.1053   0.1148
 0.1222 0.0706   0.1045   0.1240   0.1343
 0.1396 0.0860   0.1232   0.1442   0.1554
 0.1571 0.0962   0.1353   0.1573   0.1690
 0.1745 0.1069   0.1479   0.1708   0.1830
 0.1920 0.1180   0.1610   0.1849   0.1975
 0.2094 0.1298   0.1746   0.1995   0.2126
 0.2269 0.1424   0.1892   0.2151   0.2286
 0.2443 0.1565   0.2054   0.2323   0.2464
 0.2618 0.1727   0.2240   0.2521   0.2667
 0.2793 0.1782   0.2302   0.2587   0.2735
# c172p continues 0.2967 0.1716 ... 0.3491 0.1097 (drag DROPS post-stall: a known defect, do not use)
# FlightGear replacement rows (use these):
 0.3491 0.2537   0.3298   0.3755   0.3983
 0.5236 0.4500   0.5850   0.6660   0.7065
 0.6981 0.7000   0.9100   1.0360   1.0990
 0.8727 1.0000   1.3000   1.4800   1.5700
 1.0472 1.3500   1.7550   1.9980   2.1195
 1.2217 1.5000   1.9500   2.2200   2.3550
 1.3963 1.5700   2.0410   2.3236   2.4649
 1.5710 1.6000   2.0800   2.3680   2.5120
```

Note the flap columns already include the flap drag increment *trend*; JSBSim additionally adds `CDDf` = 0/0.007/0.012/0.018 (×kCDge). Total CD at α = 0: 0.0322 (flaps 0), 0.0508 (10°), 0.0641 (20°), 0.0749 (30°).

### 3.3 Post-stall blending and the −180…+180° robustness table

Beyond the table (|α| > 0.36 rad) blend to a **flat-plate** model so the integrator never sees NaN or a discontinuity at any attitude (tail-slides, hammerheads, spins, flying backwards):

```
CN_fp(α) = CD90 · sin α            CD90 = 1.7 (wing+fuselage+tail normal-force coefficient at 90°)
CL_fp = CN_fp · cos α = CD90·sinα·cosα ;  CD_fp = CD0 + CN_fp·sinα = CD0 + CD90·sin²α
Cm_fp = −0.25·CN_fp·sign(cos α)    (CP moves to mid-chord, ARP at 25 % → nose-down restoring)
w = smoothstep(0.36, 0.55, |α|) ;  C = (1−w)·C_table(clamp(α)) + w·C_fp(α)
```

Resulting 15° grid (flaps 0, about 25 % MAC) — a lookup an implementer can paste as the default; the −5…+20° region should come from the fine tables above:

| α (°) | CL | CD | Cm | | α (°) | CL | CD | Cm |
|---|---|---|---|---|---|---|---|---|
| −180 | 0.00 | 0.032 | 0.00 | | 0 | 0.25 | 0.032 | 0.10 |
| −165 | 0.40 | 0.15 | 0.25 | | 5 | 0.72 | 0.071 | 0.05 |
| −150 | 0.70 | 0.45 | 0.25 | | 10 | 1.145 | 0.134 | −0.075 |
| −135 | 0.85 | 0.85 | 0.30 | | 15 | 1.445 | 0.20 | −0.16 |
| −120 | 0.74 | 1.30 | 0.40 | | 16 | 1.47 | 0.205 | −0.18 |
| −105 | 0.43 | 1.60 | 0.45 | | 20 | 1.22 | 0.254 | −0.25 |
| −90 | 0.00 | 1.70 | 0.45 | | 30 | 0.95 | 0.45 | −0.20 |
| −75 | −0.43 | 1.60 | 0.42 | | 45 | 0.85 | 0.85 | −0.30 |
| −60 | −0.74 | 1.30 | 0.38 | | 60 | 0.74 | 1.30 | −0.38 |
| −45 | −0.85 | 0.85 | 0.30 | | 75 | 0.43 | 1.60 | −0.42 |
| −30 | −0.74 | 0.45 | 0.25 | | 90 | 0.00 | 1.70 | −0.45 |
| −20 | −0.55 | 0.22 | 0.22 | | 105 | −0.43 | 1.60 | −0.42 |
| −15 | −0.65 | 0.12 | 0.18 | | 120 | −0.74 | 1.30 | −0.40 |
| −12 | −0.75 | 0.085 | 0.17 | | 135 | −0.85 | 0.85 | −0.30 |
| −10 | −0.60 | 0.060 | 0.16 | | 150 | −0.74 | 0.45 | −0.25 |
| −5 | −0.22 | 0.031 | 0.13 | | 165 | −0.40 | 0.15 | −0.15 |
|  | | | | | 180 | 0.00 | 0.032 | 0.00 |

(Negative-α stall at ≈ −12°, CLmin ≈ −0.75 is an estimate for a NACA 2412 wing with AR 7.4; flag as untuned.) Also fade the rate derivatives and control effectiveness at high α (FlightGear: Cmδe × 1/0.6/0.3/0.15/0.1 at α = 18/25/35/45/55°+; Clδa × 1 → 0.3 → −0.1 at α 16/17/35°; Cmα × 1/0.6/0.4/0.5/0.4/0.2/0.1 at 20/25/35/45/55/65/90°). Keep |Clp|, |Cnr| ≥ 30 % of nominal at all α so spins remain recoverable and the integrator stays damped.

Flap lift increment: scale ΔCL_flap by cos²(α) and fade to 0 above 45°; CL table columns: use flap-0 lift table + ΔCL_flap (JSBSim approach) rather than separate tables per flap.

### 3.4 Flap effects per detent (0 / 10 / 20 / 30°)

| Detent | ΔCL (c172p, FG) | ΔCL (c172x) | ΔCD (`CDDf`) | ΔCm c172p | ΔCm c172x | ΔCm FG (tuned for trim speeds 95/75/60 kt) | Transit time (c172p kinematic) |
|---|---|---|---|---|---|---|---|
| 0° | 0 | 0 | 0 | 0 | 0 | 0 | — |
| 10° | +0.20 | +0.25 | +0.007 | −0.0654 | −0.03 | −0.008 | 2 s |
| 20° | +0.30 | +0.30 | +0.012 | −0.0981 | −0.05 | −0.016 | +1 s |
| 30° | +0.35 | +0.35 | +0.018 | −0.1140 | −0.06 | −0.024 | +1 s |

Recommendation: ΔCL 0.20/0.30/0.35 (Vs0 → 48.8 KCAS at 2550 lb vs POH 48 — good), ΔCm = c172x values (−0.03/−0.05/−0.06), full-flap travel ~7–9 s total (real 172 electric flaps; JSBSim's 4 s is fast — *unverified, make configurable*). Also: CYβ, CYp, CYr, Clr change with flaps (table in §2.3); Vfe: 110 KIAS (10°), 85 KIAS (10–30°) for the 172S.

### 3.5 Ground effect

JSBSim tables indexed by h/b where h = height of the **MAC** above ground (`hoverbmac = (AGL − z_mac)/b`), not the CG:

```
h/b:    0.00  0.10  0.15  0.20  0.30  0.40  0.50  0.60  0.70  0.80  0.90  1.00  1.10
kCLge:  1.203 1.127 1.090 1.073 1.046 1.028 1.019 1.013 1.008 1.006 1.003 1.002 1.000
kCDge:  0.480 0.515 0.629 0.709 0.815 0.882 0.928 0.962 0.988 1.000 1.000 1.000 1.000
```

(c172p has a typo 1.055 at h/b 0.4 — use 1.028 from c172x/FG/737.) `kCDge` multiplies the α-dependent (induced) drag only, `kCLge` the wing lift terms. Closed forms if you prefer formulas: induced-drag ratio σ_D = 1 − exp(−4.01·(2h/b)^0.717) (Phillips & Hunsaker eq. 5 / Torenbeek, as implemented in [AeroSandbox](https://raw.githubusercontent.com/peterdsharpe/AeroSandbox/master/aerosandbox/library/aerodynamics/inviscid.py)); McCormick: σ_D = (16h/b)²/(1+(16h/b)²); Hoerner/Raymer: σ_D = 33(h/b)^1.5/(1+33(h/b)^1.5). Lift: use the table (≈ +20 % at the ground, matching McCormick's "AR 6 wing: +20 % lift, −60 % induced drag" note cited in [Phillips & Hunsaker](https://core.ac.uk/download/32571419.pdf)).

---

## 4. Propulsion — Lycoming IO-360-L2A (180 hp) + McCauley 76 in fixed-pitch prop

### 4.1 Engine data

| Parameter | Value | Source |
|---|---|---|
| Rated power | 180 hp (134.2 kW) at 2700 rpm, SL ISA | [EASA TCDS IM.E.032](https://www.easa.europa.eu/en/downloads/7741/en) |
| Displacement | 361 in³ = 5.92 L (JSBSim uses 360) | |
| Idle rpm | 600–700 (FG eng_io360: 600) | |
| Max full-throttle MAP at SL | 28.5 inHg (JSBSim `maxmp`) ≈ 29.92 − 1.4 induction loss | |
| Min MAP (idle, closed throttle) | 8.3–10 inHg | FG 8.3, JSBSim 10 |
| Volumetric efficiency | 0.85 (JSBSim default) → use 0.85–0.92 | |
| BSFC | ≈0.43–0.47 lb/hp/hr full rich, ≈0.40 best economy (JSBSim c172 engines: 0.32 (c172p io320, too low), 0.37 (FG, commented)) | Lycoming quotes 0.435 lb/hp/hr at 75 % for the O-360 → 9.8 gph ([Lycoming article](https://www.kookje.ac.kr/airman/index.php?pCode=MN000056&pg=4&mode=fdn&idx=12492&num=1)) |
| 75 % cruise | ~2450–2500 rpm fixed-pitch, ~9.8–10.1 gph | same + POH |
| Static full-throttle rpm | 2300–2400 (172S POH) | |
| 160 hp variant (O-320-D2J, 172N/P) | JSBSim `eng_io320.xml`: 160 hp, 2700 rpm, 320 in³, bsfc 0.32, idle 550 | |

### 4.2 Manifold pressure

```
p_amb_inHg = p(h)/3386.39
MAP_wot    = p_amb_inHg − 1.4·(RPM/2700)²                      // induction loss grows with airflow
MAP_idle   = max(8.5, 0.30·p_amb_inHg)                          // throttle plate leakage
MAP        = MAP_idle + (MAP_wot − MAP_idle)·thr_eff,  thr_eff = 1 − (1 − throttle)²   // JSBSim: throttle impedance ∝ (1−thr)²
MAP        += (MAP_target − MAP)·dt/τ_map,  τ_map ≈ 0.1 s       // manifold filling lag
```

### 4.3 Power — Model B (airflow-based, JSBSim `FGPiston` logic, recommended)

```
V_swept     = disp_m3 · (RPM/60) / 2                      // 4-stroke: one intake per 2 revs
ṁ_air       = V_swept · VE · MAP_Pa / (R_air · T_manifold) // T_manifold ≈ T_amb + 10 K
φ           = 1.3 · mixture_lever · (101325 / p_amb)       // JSBSim doFuelFlow: full rich = φ 1.3 at SL, leaner with altitude
ṁ_fuel      = ṁ_air · φ / 14.7                             // stoich F/A = 1/14.7 = 0.068
FA          = ṁ_fuel / ṁ_air
η_mix       = table(FA)   // JSBSim Mixture_Efficiency_Correlation:
              FA:    0.050 0.0514 0.0518 0.0543 0.0584 0.0631 0.0694 0.0779 0.0885 0.0927 0.1012 0.1146 0.1216 0.1244 0.125
              η_mix: 0.0   0.0086 0.2155 0.4828 0.7069 0.8362 0.9310 1.0    1.0    0.9828 0.9310 0.7241 0.4569 0.2328 0.0
P_ind_hp    = (ṁ_fuel_pph / ISFC) · η_mix · k_spark        // ISFC ≈ 0.43 lb/hp/hr (indicated); k_spark = 0.9 on one magneto
P_fric_hp   = 1.8e-6 · RPM² + 1.5                           // ≈13 hp at 2700, ≈2 hp at 650 (JSBSim: FMEP + static friction)
P_brake     = max(P_ind_hp − P_fric_hp, −P_fric_hp)         // negative when windmilling with no fuel
```

Calibration check (ISA SL, 2700 rpm, WOT MAP 28.5 inHg = 96 500 Pa, VE 0.85, full rich FA ≈ 0.088): ṁ_air = 0.1332·0.85·96500/(287·298) = 0.128 kg/s → ṁ_fuel = 0.0113 kg/s = 89 pph = 14.9 gph (matches real IO-360 take-off fuel flow 14–16 gph); P = 89/0.43·1.0 − 13 = 194 hp → trim ISFC to 0.46 to hit 180 hp. At 8000 ft, 2500 rpm, WOT (MAP ≈ 21.5 inHg), leaned to FA 0.072 (η 0.95): ṁ_fuel ≈ 54 pph = 9.0 gph, P ≈ 54/0.46·0.95 − 12.8 = 99 hp ≈ 55 %. Fixed-pitch 172S POH shows ≈ 65–75 % at 2500 rpm / 8000 ft (*exact row unverified*), so expect to raise VE to ~0.92 and/or lower the induction loss; keep ISFC and FA as the tuning knobs.

Model A (fallback, percent-power): `P_brake = 180 hp · (MAP/28.5) · (RPM/2700) · sqrt(288.15/T_amb) · η_mix − P_fric`. It misses mixture/altitude coupling but is monotonic and trivially stable.

Fuel: fuel-flow integrates tank mass (two wing tanks, 26.5 usable gal each, at y = ±112 in, FS 56 in per c172p; 53 gal usable = 318 lb = 144 kg total); CG/inertia updated from tank contents (point masses). Fuel density 0.72 kg/L.

### 4.4 Propeller (fixed pitch, blade-element tables)

Thrust and power coefficients vs advance ratio J = V/(n·D) (n in rev/s), T = Ct·ρ·n²·D⁴, P_req = Cp·ρ·n³·D⁵, Q_prop = P_req/(2πn), η = Ct·J/Cp.

FlightGear `prop_76in2f_NACA_20deg` (NACA Report 640 propeller 5868-9, blade angle 20° at 0.75R, D = 76 in = 1.9304 m, pitch 62.5 in, I_prop = 1.67 slug·ft² = 2.264 kg·m²) — **recommended for the 172S**:

```
J:   0.0    0.1    0.2    0.3    0.4    0.5    0.6    0.7    0.8    0.9    1.0    1.1     1.2     1.3     1.5     2.0     3.0
Ct:  0.104  0.104  0.103  0.101  0.093  0.082  0.070  0.055  0.039  0.024  0.006 -0.014  -0.033  -0.045  -0.060  -0.072  -0.080
Cp:  0.066  0.065  0.064  0.0625 0.060  0.058  0.054  0.0475 0.037  0.026  0.010  0.000  -0.010  -0.020  -0.035  -0.050  -0.055
```

JSBSim `prop_75in2f` (75 in, 22° pitch, used by c172p/c172x; 160 hp class):

```
J:   0.0    0.1    0.2    0.3    0.4    0.5    0.6    0.7    0.8    0.9    1.0    1.1    1.2     1.3     1.4     1.5     1.6     1.7     1.8     1.9     2.0     2.3     5.0
Ct:  0.073  0.073  0.072  0.071  0.069  0.066  0.062  0.055  0.045  0.034  0.024  0.013 -0.006  -0.013  -0.024  -0.034  -0.045  -0.055  -0.062  -0.066  -0.069  -0.073  -0.073
Cp:  0.066  0.070  0.070  0.066  0.060  0.053  0.0501 0.0469 0.0426 0.036  0.0282 0.0191 0.0155  0.0191  0.0282  0.036   0.0426  0.0469  0.0501  0.0516  0.0525  0.0511  0.0493
```

(JSBSim also applies Ct×1.0→0.8 and Cp×1.0→1.8 for helical tip Mach 0.85→1.05; tip speed at 2700 rpm is 273 m/s → M 0.80, so the correction is ≈ inactive; include it only for the jet archetype's props if any.)

Checks with the NACA-640 table: static thrust at 2350 rpm SL = 0.104·1.225·39.17²·1.9304⁴ = 2 714 N (610 lbf); power absorbed static = 0.066·1.225·39.17³·1.9304⁵ = 130 kW (175 hp) — so the engine (≈157 hp available at 2350 rpm WOT) settles at ≈2250–2300 static rpm, matching the POH 2300–2400 range. Cruise check at 120 KTAS, 2 500 rpm, 8 000 ft (ρ 0.963): J = 0.767, Ct ≈ 0.044, Cp ≈ 0.041, η ≈ 0.84, T ≈ 1 030 N (231 lbf), P ≈ 76 kW (101 hp). Airframe drag at that point ≈ 1 300 N (CL 0.38, CD 0.044), so with this table the 172S needs ≈ 2 600 rpm / 135 hp to hold 124 KTAS: calibrate engine VE (§4.3) and, if needed, scale Cp by ≈ 0.9 so WOT at 8 000 ft settles at ≈ 2 550–2 600 rpm and 75 % power. Engine and propeller must be tuned **jointly** against §10 rows 4, 6 and 12.

RPM dynamics (JSBSim `FGPropeller::Calculate`): `(I_prop + I_eng)·ω̇ = Q_engine − Q_prop`, `Q_engine = P_brake/ω`, I_eng ≈ 0.3 kg·m² (crank/accessories, estimate) → total ≈ 2.5 kg·m². RPM ≥ 0; starter adds Q = 0.4·P_max/ω-ish up to ~300 rpm (JSBSim `StarterTorque = MaxHP·0.4`); engine "runs" above ~300 rpm with fuel and magnetos. Windmilling: negative Ct/Cp beyond J ≈ 1.05 give drag and drive the engine (idle in a 68 KIAS glide ≈ 1 000–1 300 rpm).

Induced velocity (momentum theory, McCormick eq. 6.15 as in JSBSim): `v_i = ½(−V + sqrt(V² + 2T/(ρ·A)))`, A = πD²/4 = 2.927 m², sign-safe form: `s = V·|V| + 2T/(ρA); v_i = 0.5·(−V + sign(s)·sqrt(|s|))`.

### 4.5 Torque reaction and gyroscopic moments

`L_torque = −sense · Q_engine` (sense = +1 for clockwise-from-cockpit US engines → left-roll reaction). 180 hp at 2700 rpm: Q = 134 200/282.7 = 475 N·m (350 lb·ft). Compare Clδa authority at 60 KCAS: 585·16.165·10.91·0.229·0.35 rad = 8 270 N·m at full aileron, so torque needs ≈ 6 % aileron — realistic. Gyroscopic: `M_gyro = ω_body × (I_prop·ω_prop·x̂)` → pitching yields yaw (and vice versa); I_prop·ω = 2.26·283 = 640 N·m·s; a 0.5 rad/s pitch-up gives 320 N·m right-yaw — noticeable on take-off rotation.

### 4.6 Slipstream on the tail and spiralling-slipstream yaw

* JSBSim c172p/FG: tail dynamic pressure `q̄_tail = ½ρ(u_a + 2·v_i)²` (far-wake velocity is 2·v_i) used for **Cmδe and Cnδr only** — gives elevator/rudder authority at low speed with power (take-off rotation at 50 kt, go-arounds).
* Spiralling slipstream (FG `Cnspw`): `N_spw = −0.05 · (½ρ·v_i²) · S · b` (nose-left for clockwise prop; in-flight tuning multiplier property defaults to 1). At take-off (T ≈ 2 700 N, V ≈ 0) v_i = sqrt(T/(2ρA)) = 19.4 m/s → N_spw = −0.05·230·16.165·10.91 = −2 030 N·m. The rudder sits in the same slipstream (q̄_tail = ½ρ(0 + 2·19.4)² = 922 Pa), so full rudder gives 2 930 N·m and ≈ 70 % right rudder is needed at brake release; by 60 kt (T ≈ 2 000 N, v_i ≈ 7.3 m/s) N_spw falls to ≈ −290 N·m against 4 000 N·m of rudder authority (≈ 7 %) — consistent with real 172 behaviour (lots of right rudder early in the roll, little at rotation).

### 4.7 P-factor

JSBSim: shift the thrust application point laterally by `Δy = sense · kP · angle` where `angle = atan2(|v_tangential|, u + v_i)` is the local inflow angle at the disk and the shift is along the local (v, w) direction (`FGPropeller.cpp`, `P_Factor`): c172p kP = 5 in, FG c172p kP = 15 in (0.381 m). Pure α case: Δy = kP·α → at α = 10° with T = 2 700 N: N = −T·Δy = −2700·0.0665 = −180 N·m (nose left). Yaw-moment equivalent: ΔCn = −T·kP·α/(q̄·S·b). Implement both P-factor and torque as force/moment at the prop hub location (FS −37.7 in, WL 26.6–29.3 in in c172p; 1.98 m ahead of CG, 0.07 m below the CG waterline — the thrust line passes ≈ through the CG).

### 4.8 Mixture (simplified) and EGT

`mixture_lever ∈ [0,1]`, FA from §4.3; best power at FA ≈ 0.078–0.088 (η_mix = 1), peak EGT near stoichiometric 0.068, lean misfire below 0.052. Cruise leaning: pilot leans until rpm peaks (fixed pitch) — emerges automatically from η_mix(FA) × ṁ_fuel. EGT (for the gauge only): `EGT = 1 000 °F + 500·(1 − |FA − 0.068|/0.02)` clamped, with a 3 s lag. Mixture cut-off (lever 0) → FA 0 → P_ind 0 → engine windmills/stops.

---

## 5. Landing gear (tricycle, per-wheel spring-damper)

### 5.1 Geometry and constants (JSBSim c172p structural frame, inches; x aft of datum, z up)

| Contact | x (in) | y (in) | z (in) | k (lb/ft) | c (lb·s/ft) | μ_static | μ_dynamic | μ_rolling | Steer | Brake |
|---|---|---|---|---|---|---|---|---|---|---|
| Nose | −6.8 | 0 | −19.5 | 1 800 (FG: 3 600) | 600 (FG: 1 200; c172x rebound 2 000) | 0.8 | 0.5 | 0.02 | ±10° (FG allows 30° with side force) | none |
| Left main | 58.2 | −43 | −15.5 | 5 400 | 1 600 (FG 1 800; c172x 160/320 rebound) | 0.8 | 0.5 | 0.02 | 0 | left |
| Right main | 58.2 | +43 | −15.5 | 5 400 | 1 600 | 0.8 | 0.5 | 0.02 | 0 | right |
| Nose skid/prop, tail skid, wing tips | −37.7/188/43.2 | 0/0/±214.8 | 26.6/8/59.4 | 20 000 | 2 000 | 0.2 | 0.2 | 0.2 | — | — |

SI: mains k = 78.8 kN/m, c = 23.4 kN·s/m (FG: 26.3); nose k = 26.3 kN/m (FG 52.5), c = 8.76 kN·s/m (FG 17.5). CG at FS 41 → wheelbase 65 in (1.65 m), nose carries ≈ 0.26 of weight statically on this geometry (real 172: ~ 0.2); track 86 in (2.18 m; real 172S 100 in = 2.54 m — use real). Static deflections at 2550 lb: mains 2.5 in, nose 1.7 in; natural frequencies ≈ 2.0 Hz (mains) / 2.4 Hz (nose); ζ ≈ 1.8 / 2.5 (over-damped — JSBSim's choice for robustness; ζ 0.7–1.0 feels livelier, use rebound damping = 2× compression damping as c172x does).

### 5.2 Per-wheel algorithm (evaluate inside every integrator stage)

```ts
for each wheel w:
  r_w  = body-frame position of the unloaded wheel contact point relative to CG (incl. tyre radius)
  p_w  = pos_NED + C_nb·r_w                         // world position of contact point
  h_g  = terrain.height(p_w.N, p_w.E); n_g = terrain.normal(...)   // same function the renderer uses
  δ    = (h_g − (−p_w.D))·n_g.z-ish → compression along strut axis (approximate strut axis = body −z); δ = max(0, δ)
  if (δ == 0) { F_w = 0; continue }
  v_w  = v_body + ω × r_w  (body) → world; v_strut = −(v_w · ẑ_body)   (positive compressing)
  v_strut = clamp(v_strut, −δ/dt, δ/dt)             // JSBSim: limits compressSpeed to compressLength/dt
  F_n  = k·δ + (v_strut ≥ 0 ? c_comp : c_rebound)·v_strut ;  F_n = max(F_n, 0)   // never pull
  // in-plane velocities in the wheel frame (rotate by steer angle ψ_w about strut axis)
  v_long = v_w·t̂_w ; v_lat = v_w·ŝ_w
  slip_deg = −atan2(v_lat, |v_long|)·180/π           // JSBSim WheelSlip
  μ_lat  = D·sin(C·atan(B·s − E·(B·s − atan(B·s)))) with s = slip_deg, B=0.06, C=2.8, D=μ_static(0.8), E=1.03  (Pacejka, JSBSim defaults)
  μ_long = μ_rolling + brake_w·(μ_static − μ_rolling)       // JSBSim ComputeBrakeForceCoefficient (anti-skid assumption)
  F_lat  = −μ_lat·F_n·sat(v_lat / v_eps)                      // see §5.6 for sat()
  F_long = −μ_long·F_n·sat(v_long / v_eps)
  // friction circle
  F_f = (F_long, F_lat); if |F_f| > μ_dynamic·F_n when sliding (|v_lat| > 0.5 m/s or skid): scale to μ_dynamic·F_n
  F_w  = F_n·n̂_ground + F_long·t̂_w + F_lat·ŝ_w  → body frame; M_w = r_w(compressed) × F_w
```

Pacejka with these constants: μ_lat ≈ 0.13·slip_deg for small slip (D·C·B), ≈ 0.57 at 5°, peaks at D = 0.8 near 12° slip, then falls slowly (0.67 at 25°) — a forgiving, non-twitchy taxi behaviour.

### 5.3 Nose-wheel steering and differential braking

172: rudder pedals steer the nose wheel ±10° through spring links; castering to ~30° under differential braking. `ψ_nose = 10°·rudder_cmd` (FG uses max 30° so side force lets the bungee-less model turn tightly). Brakes: `brake_left/right ∈ [0,1]` from toe brakes or keyboard; parking brake sets both to 1. Differential braking torque emerges from F_long on each main × half-track (1.27 m). Optional controllability aid for keyboard users: scale steering by `clamp(1 − V_ground/40 kt, 0.3, 1)`.

### 5.4 Rolling-resistance/brake limiting to avoid velocity reversal

Never apply more friction impulse than needed to stop the wheel's in-plane velocity within the step: `|F| ≤ m_eff·|v|/dt`, with `m_eff ≈ m/(number of wheels on ground)`. This single rule removes most low-speed jitter.

### 5.5 Sleep state

If all gear are on the ground, |v_body| < 0.05 m/s, |ω| < 0.02 rad/s, thrust < 50 N and (brakes set or slope < 1°): zero velocities and skip aerodynamic/gear integration ("parked"); wake on any input change or wind > 25 kt.

### 5.6 Ground-reaction stability tips (why sims jitter, and the fixes)

1. **Discontinuous Coulomb friction** flipping sign each step → use `sat(x) = tanh(x)` or `clamp(x,−1,1)` with v_eps = 0.2–0.5 m/s, plus the impulse limit of §5.4.
2. **Explicit damping with large c/m** (nose gear c/m ≈ 60 s⁻¹) → fine at 120 Hz with RK4; with Euler use ≥ 240 Hz or semi-implicit ordering (velocity update before position).
3. **Spring too stiff for the mass** (structure points, 20 000 lb/ft on wingtips) → only contact occasionally; clamp F_n ≤ 3·W and δ ≤ 0.3 m; if a structure point exceeds its limit flag "crash" instead of integrating.
4. **Terrain normal discontinuities** → sample the same height field the renderer uses, bilinear-filtered; smooth normals.
5. **Zero aerodynamic damping at rest** → gear dampers are the only damping of pitch/roll rocking; ζ ≥ 0.7 keeps it dead-beat. JSBSim's issue #89 (pitch oscillation at rest with crosswind) was fixed by using q̄_uw instead of q̄ for the α̇ terms — do the same.
6. **Brakes while steering** → JSBSim assumes anti-skid; apply the friction circle so braked wheels still generate side force proportionally (|F| ≤ μF_n total).
7. **Castering/steer angle vs velocity direction** → compute slip from the wheel frame, never from the body frame.
8. Integrate gear in the same RK4 as the airframe (no separate "physics engine" with its own step) — two solvers coupled through forces always fight.

---

## 6. Mass properties

| Item | 172P (c172p / FG) | 172S (POH) | SI (172S) |
|---|---|---|---|
| Empty weight | 1 500 lb (c172p), 1 467 lb basic (FG, from 172P POH, CG 39.06 in), 1 454 (c172x) | ≈1 663 lb standard empty (varies by serial) | 754 kg |
| MTOW | 2 400 lb (172P) | 2 550 lb | 1 157 kg |
| Max landing | 2 400 | 2 550 | |
| Fuel | 2×21.5 usable (172P) | 56 total / 53 usable gal; 318 lb usable | 144 kg |
| Ixx | 948 slug·ft² | — | 1 285 kg·m² |
| Iyy | 1 346 (Roskam; FG 1 285) | — | 1 825 kg·m² |
| Izz | 1 967 (FG 1 906) | — | 2 667 kg·m² |
| Ixz | 0 (Roskam) | — | 0 (realistic 0–70 kg·m²; small positive for a high wing with nose-low thrust line is fine) |
| CG range | — | fwd 35.0 in at ≤1 950 lb → 41.0 in at 2 550 lb (linear); aft 47.3 in | LEMAC ≈ FS 25.9 in, MAC 58.8 in → 15.5 %–36.4 % MAC |
| Datum | front face of firewall | | |
| Point masses (c172p) | pilot/copilot 180 lb at FS 36, BL ±14, WL 24; rear pax FS 70; baggage FS 95 | | |

Composite inertia: `I_total = I_empty + Σ m_i·(|r_i|²·1 − r_i r_iᵀ)` with r_i relative to the instantaneous CG; recompute when fuel changes by > 1 kg. Scale empty inertia with empty mass if a user selects a different variant: `I ∝ m` is a fair first approximation.

---

## 7. ISA atmosphere, airspeeds, Mach

Constants: T0 = 288.15 K, p0 = 101 325 Pa, ρ0 = 1.225 kg/m³, L = −0.0065 K/m (0–11 km), R = 287.05287 J/(kg·K), g0 = 9.80665, γ = 1.4, a0 = 340.29 m/s. Troposphere: `T = T0 + L·h`, `p = p0·(T/T0)^(−g0/(R·L)) = p0·(T/T0)^5.25588`; stratosphere 11–20 km: `T = 216.65`, `p = 22 632.06·exp(−g0·(h − 11 000)/(R·216.65))`. `ρ = p/(R·T)`, `a = sqrt(γ·R·T)`, dynamic viscosity (Sutherland) `μ = 1.458e-6·T^1.5/(T + 110.4)`. Non-standard day: add ΔT_ISA to T (keep p from geopotential altitude), which is how density altitude enters.

| h (m) | T (K) | p (Pa) | ρ (kg/m³) | a (m/s) |
|---|---|---|---|---|
| 0 | 288.15 | 101 325 | 1.2250 | 340.3 |
| 1 000 | 281.65 | 89 875 | 1.1117 | 336.4 |
| 2 000 | 275.15 | 79 495 | 1.0066 | 332.5 |
| 2 438 (8 000 ft) | 272.3 | 75 262 | 0.9629 | 330.8 |
| 3 000 | 268.65 | 70 109 | 0.9093 | 328.6 |
| 5 000 | 255.65 | 54 020 | 0.7364 | 320.5 |
| 8 000 | 236.65 | 35 600 | 0.5258 | 308.4 |
| 10 000 | 223.15 | 26 436 | 0.4127 | 299.5 |
| 11 000 | 216.65 | 22 632 | 0.3639 | 295.1 |
| 15 000 | 216.65 | 12 045 | 0.1937 | 295.1 |
| 20 000 | 216.65 | 5 475 | 0.0880 | 295.1 |

Airspeeds (JSBSim `FGAuxiliary` formulas):

```
M    = V/a
q_c  = p·[(1 + 0.2·M²)^3.5 − 1]                  // impact pressure, subsonic
CAS  = a0·sqrt(5·[(q_c/p0 + 1)^(2/7) − 1])       // what a perfect pitot-static system shows
EAS  = V·sqrt(ρ/ρ0)   (≈ CAS below M 0.3)
IAS  = CAS + Δ_position_error(CAS, flaps)        // instrument/position error table
```

172S position error (normal static source; the POH table hosts were unreachable — these are *approximate* reconstructions consistent with the published Vs 48 KIAS = 53 KCAS and Vs0 40 KIAS = 48 KCAS; replace with POH Section 5 "Airspeed Calibration" when available):

```
flaps up : KIAS 40  50  60  70  80  90 100 110 120 130 140 150 160
           KCAS 48  56  62  70  79  88  98 107 117 127 136 146 156
flaps 30°: KIAS 40  50  60  70  80  85
           KCAS 47  54  61  69  78  83
```

Altimeter: indicated altitude from p with the Kollsman setting: `h_ind = (T0/|L|)·[1 − (p/p_set)^(R·|L|/g0)]`, p_set = QNH. Vertical speed: filtered `−Ḋ` with τ ≈ 2–3 s (real VSI lag). Mach is irrelevant for the 172 (M < 0.25) but required for the jet.

---

## 8. Wind, shear, gusts and turbulence (real-time)

### 8.1 Mean wind and shear

`W_NED(h) = W_ref · (ln(h/z0)/ln(h_ref/z0))` for h > z0 (MIL-F-8785C logarithmic profile; z0 = 0.15 ft = 0.046 m, h_ref = 20 ft = 6.1 m) up to ~300 m, constant above; cap the ratio at 2. Direction veer with height optional (+10–20° per 1 000 m in the NH boundary layer).

### 8.2 Discrete "1-cosine" gust (MIL-F-8785C)

`V_gust(x) = (V_m/2)·(1 − cos(π·x/d_m))` for 0 ≤ x ≤ d_m, x = distance flown since gust start; typical V_m 5–15 kt, d_m 30–120 m (≈ 1–3 s at 172 speeds). Apply along any axis (vertical gusts give the "bump").

### 8.3 Dryden turbulence — MIL-F-8785C parameters (from `FGWinds.cpp`, with page refs to the spec)

Scale lengths (ft) and intensities (ft/s) vs altitude h (ft AGL) and W20 = wind speed at 20 ft (kt → ft/s ×1.6878; light 15 kt, moderate 30 kt, severe 45 kt):

```
h ≤ 1000 ft:   L_w = h ;  L_u = L_v = h / (0.177 + 0.000823·h)^1.2        (Fig. 10, p. 55)
               σ_w = 0.1·W20 ;  σ_u = σ_v = σ_w / (0.177 + 0.000823·h)^0.4  (Fig. 11, p. 56)
1000–2000 ft:  linear interpolation of L (→1750) and σ (→ POE table) between the two models
h ≥ 2000 ft:   L_u = L_v = L_w = 1750 ft (Sec. 3.7.2.1, p. 48);  σ_u = σ_v = σ_w = POE table (Fig. 7, p. 49):
   h(ft):        500  1750  3750  7500 15000 25000 35000 45000 55000 65000 75000 80000
   index 1 (10^-1):  3.2  2.2  1.5  0    0     0     0     0     0     0     0     0   ft/s
   index 2 (10^-2):  4.2  3.6  3.3  1.6  0     0     0     0     0     0     0     0
   index 3 (10^-3, "light"):    6.6  6.9  7.4  6.7  4.6  2.7  0.4  0  0  0  0  0
   index 4 (10^-4, "moderate"): 8.6  9.6 10.6 10.1  8.0  6.6  5.0 4.2 2.7 0  0  0
   index 5 (10^-5, "severe"):  11.8 13.0 16.0 15.1 11.6  9.7  8.1 8.2 7.9 4.9 3.2 2.1
   index 6: 15.6 17.6 23.0 23.6 22.1 20.0 16.0 15.1 12.1 7.9 6.2 5.1 ;  index 7: 18.7 21.5 28.4 30.2 30.7 31.0 25.2 23.1 17.5 10.7 8.4 7.2
Clamp h ≥ 10 ft. Use the airspeed relative to the mean air mass (not including turbulence) for V.
```

Continuous forming filters (MIL-F-8785C form; τ = L/V; white noise with two-sided PSD π so that output variance = σ²):

```
H_u(s) = σ_u·sqrt(2L_u/(πV)) / (1 + τ_u s)
H_v(s) = σ_v·sqrt(L_v/(πV))·(1 + √3 τ_v s) / (1 + τ_v s)²
H_w(s) = σ_w·sqrt(L_w/(πV))·(1 + √3 τ_w s) / (1 + τ_w s)²
H_p(s) = σ_w·sqrt(0.8/V)·(π/(4b))^(1/6) / (L_w^(1/3)·(1 + (4b/(πV)) s))
H_q(s) = (s/V)/(1 + (4b/(πV)) s) · H_w(s) ;  H_r(s) = (s/V)/(1 + (3b/(πV)) s) · H_v(s)
```

**Discrete real-time form** (Yeager 1998 eqs. 30–35 as implemented in JSBSim `ttStandard`; ν ~ N(0,1) per step, T = dt; variance-correct for T ≪ τ):

```
ξ_u = (1 − T/τ_u)·ξ_u + σ_u·sqrt(2T/τ_u)·ν_u
ξ_v = (1 − 2T/τ_u)·ξ_v + σ_u·sqrt(4T/τ_u)·ν_v          // JSBSim assumes L_v = L_u
ξ_w = (1 − 2T/τ_w)·ξ_w + σ_w·sqrt(4T/τ_w)·ν_w
ξ_p = (1 − T/τ_p)·ξ_p + σ_p·sqrt(2T/τ_p)·ν_p,   σ_p = 1.9·σ_w/sqrt(L_w·b),  L_p = sqrt(L_w·b)/2.6,  τ_p = L_p/V
ξ_q = (1 − T/τ_q)·ξ_q + (π/(4b))·(ξ_w − ξ_w_prev),  τ_q = 4b/(πV)
ξ_r = (1 − T/τ_r)·ξ_r + (π/(3b))·(ξ_v − ξ_v_prev),  τ_r = 3b/(πV)
turbulence_NED = (cosψ_w·ξ_u + sinψ_w·ξ_v, −sinψ_w·ξ_u + cosψ_w·ξ_v, ξ_w)  // ψ_w = wind heading
turb_pqr_body  = (cosψ·ξ_p + sinψ·ξ_q, −sinψ·ξ_p + cosψ·ξ_q, ξ_r)   // JSBSim adds these to the aero p,q,r
```

Guard: require T/τ < 0.5 (at 120 Hz and V = 50 m/s this needs L > 0.8 m — always true). Cheaper alternative for a browser: a sum of 3–4 sines per axis with random phases and amplitudes shaped to σ — but Dryden costs 6 multiply-adds per step; just use it. For a flyable "feel", the 172 at 100 kt in moderate turbulence (W20 = 30 kt, 500 ft AGL): σ_w = 5.1 ft/s = 1.5 m/s, L_w = 152 m, τ_w ≈ 3 s → vertical gust RMS 1.5 m/s → Δα RMS ≈ 1.7°, Δn ≈ ±0.2 g. Severe (45 kt) doubles that. Implement as a proper second-order filter (bilinear/Tustin, JSBSim `ttTustin` eqs. 18–26) if the first-order approximations above show too little high-frequency content.

---

## 9. Trim, controls, control feel

### 9.1 Surface limits (172, matching JSBSim c172p `aerosurface_scale` ranges; FAA TCDS 3A12 values are the same within ±1°)

| Surface | Travel | Rate (actuator/pilot) | Note |
|---|---|---|---|
| Elevator | −28° (TE up) … +23° (TE down) | 1st-order lag τ = 0.05–0.08 s, rate limit ≈ 80°/s | normalized cmd ∈ [−1,1] maps asymmetrically |
| Ailerons | left: −20° (up) … +15° (down); right mirrored (differential) | τ 0.05 s, 100°/s | Clδa uses *left* aileron angle (or average) |
| Rudder | ±16° | τ 0.05 s, 100°/s | nose-wheel steering ±10° follows pedals |
| Flaps | 0/10/20/30° detents | ≈ 2–3 s per detent (c172p 2/1/1 s); Vfe 110/85 KIAS | electric motor; add speed-dependent "blowback" only for realism |
| Elevator trim tab | ≈ 22° up / 19° down (TCDS, *verify*) | trim wheel: full travel in ≈ 6–8 s with key held; ±0.15 norm/s | implemented as offset on elevator |
| Throttle / mixture | 0–1 | τ 0.3 s on MAP (engine), lever instantaneous | |

### 9.2 Trim implementation

JSBSim c172p: `elevator_cmd = clamp(stick + trim_cmd, −1, 1)` with trim_cmd ∈ [−1, 1] — i.e. full trim = full elevator (too much). Recommend `δe_total = δe_stick + δe_trim`, `δe_trim ∈ [−0.45, +0.35]·travel` (≈ ±10–12°) so the aircraft can be trimmed hands-off from Vy to Vne at any legal CG, but a full stick input still wins. A proper tab model (`Cmδt ≈ 0.3·Cmδe`, tab moves the free elevator to its floating angle) only matters with force-feedback hardware; skip.

Pitch-trim autotrim helper for spawning in flight: solve for (α, δe, throttle) giving u̇ = ẇ = q̇ = 0 at target (V, γ): Newton iteration on the 3×3 Jacobian evaluated by finite differences through the full force model; converges in < 10 iterations from α = 3°, δe = −2°, thr = 0.6. Initialize q from (φ=0, θ = α + γ, ψ), `v_body = (V cosα, 0, V sinα)`, RPM from the propeller torque balance.

### 9.3 Input shaping for keyboard/gamepad

* Keyboard: command rate 1.5 norm/s with auto-centering 3 norm/s, exponential (`cmd³` blend 30 %) for gamepad sticks, dead zone 3 %.
* Optional "assist" modes (MSFS has them) are separate from the FDM: a rate-command/attitude-hold wrapper that drives δe/δa from desired q/p — keep it outside this module.

---

## 10. Validation checklist (172S, 2 550 lb, ISA SL unless noted) with expected numbers

| # | Test | POH / reference | Expected from this model (computed) | Tolerance |
|---|---|---|---|---|
| 1 | Vs1 power-off, flaps 0, 1 g | 48 KIAS / 53 KCAS | 54.3 KCAS with CLmax 1.47 (56 with δe-up penalty) → tune CLmax 1.55–1.60 | ±3 kt |
| 2 | Vs0 flaps 30 | 40 KIAS / 48 KCAS | 48.8 KCAS (CLmax 1.82) | ±3 kt |
| 3 | Accelerated stall 60° bank | 68 KIAS (flaps 0) ≈ Vs·√2 | 1.41·Vs1 | ±3 kt |
| 4 | Cruise 75 % power, 8 000–8 500 ft | 124 KTAS, ~10.1 gph (manualslib scan shows 2500 rpm / 115 KTAS / 10.1 gph, altitude unreadable; *approx.*) | 125–128 KTAS with CD0 0.032, k 0.08, η_p 0.80 → slightly fast; raise CD0 to 0.034 if needed | ±5 kt, ±1 gph |
| 5 | Max level speed SL | 126 KTAS | ≈126–130 | ±5 kt |
| 6 | Rate of climb SL at Vy 74 KIAS | 730 fpm | 700–820 fpm (η_p ≈ 0.67 at J 0.44, rpm ≈ 2 500 WOT at Vy) | ±100 fpm |
| 7 | Vx / Vy | 62 / 74 KIAS | sweep γ(V) | ±4 kt |
| 8 | Service ceiling (100 fpm) | 14 000 ft | 13 000–15 000 | ±1 500 ft |
| 9 | Take-off ground roll, flaps 10, Vr 55 | 960 ft (1 630 ft over 50 ft) | 720–950 ft (simple integration gave 724 ft with constant 2 350 rpm thrust; rpm actually rises with speed) | ±150 ft |
| 10 | Landing ground roll, flaps 30, 61 KIAS over fence, max braking | 575 ft (1 335 over 50 ft) | μ_brake 0.8·anti-skid: ≈ 500–650 ft | ±150 ft |
| 11 | Best glide 68 KIAS, prop windmilling | 1.5 NM per 1 000 ft ≈ 9.1:1 (POH "Maximum Glide"; [confirmed arithmetic](https://flyawaysimulation.com/ask/answers/cessna-172-best-glide-speed/)) | L/Dmax 10.6 clean (CD0 .0271/k .0815 fit) → add windmilling-prop ΔCD ≈ 0.010 (Ct<0 region of the prop table does it automatically) → ≈ 9.0–9.5:1 | 8.5–10:1 |
| 12 | Static rpm, full throttle, brakes | 2 300–2 400 rpm | ≈ 2 250–2 300 with NACA-640 table | ±100 rpm |
| 13 | Idle rpm | 600–700 | set by MAP_idle | |
| 14 | Short-period mode at 100 KTAS | ζ ≈ 0.6–0.8, period ≈ 1–1.5 s (textbook GA) | ωn 5.4 rad/s, ζ 0.75 (Cmα −1.0); ωn 6.8, ζ 0.6 (Cmα −1.8) | |
| 15 | Phugoid | period ≈ 20–30 s, lightly damped | √2·g/V → 23 s at 100 KTAS | |
| 16 | Dutch roll | ωn ≈ 2–3 rad/s, ζ ≈ 0.1–0.25 (172 is lightly damped) | ωn 2.55 rad/s, ζ 0.24 | |
| 17 | Roll mode | τ ≈ 0.1–0.2 s | 0.09 s at 100 KTAS (Clp −0.484) | |
| 18 | Spiral | neutral to slowly divergent (T₂ > 20 s) | depends on Clβ·Cnr − Clr·Cnβ = (−0.0923)(−0.0937) − (0.0798)(0.0587) = +0.0040 > 0 → stable/neutral at CL 0.3 ✓ | |
| 19 | Ground: parked on 3° slope, brakes on | no creep, no jitter for 10 min | sleep state engages | 0 drift |
| 20 | Ground: 15 kt crosswind, idle, brakes off | weathervanes slowly, no oscillation | | |
| 21 | Full-stall → spin entry with pro-spin controls, recovery with PARE | enters within 1 turn, recovers within 1–1.5 turns after controls | needs the FG α-dependent Clβ/Clδa/Cnδa/Cmδe fades | qualitative |
| 22 | Energy: 60 s glide, power off, smooth air | total energy decreases monotonically; no numerical gain | RK4 at 120 Hz | |
| 23 | Determinism: same inputs → bit-identical state | run twice | seeded RNG for turbulence | exact |

Confirmed 172S numbers used above (Purdue data sheet, H-Aviation, flyawaysimulation, Textron POH excerpts via search): Vr 55, Vx 62, Vy 74, Vg 68, Va 105 (2 550 lb) / 98 (2 200) / 90 (1 900), Vfe 110 (10°) / 85 (full), Vno 129, Vne 163 KIAS; MTOW 2 550 lb; 53 gal usable; 180 bhp @ 2 700 rpm; max cruise 124 KTAS at 75 % / 8 500 ft; range 518 NM at 75 %; climb 730 fpm; ceiling 14 000 ft; take-off 960 / 1 630 ft; landing 575 / 1 335 ft; Vs0 40 KIAS (48 KCAS), Vs1 48 KIAS (53 KCAS).

---

## 11. Second archetype: 737/A320-class twin-jet (JSBSim `737.xml` + parametric derivation)

### 11.1 Numbers from JSBSim `737.xml` (737-300/-800 class; aero data tagged as approximate by its author)

| Item | Value |
|---|---|
| S / b / c̄ | 1 171 ft² (108.8 m²) / 94.7 ft (28.87 m) / 12.31 ft (3.752 m); AR 7.66 |
| H-tail area/arm, V-tail area/arm | 348 ft² / 48.04 ft ; 297 ft² / 44.5 ft → V_H = 1.16, V_v = 0.119 |
| Empty weight | 83 000 lb (37 650 kg); MTOW 737-800 real: 174 200 lb (79 016 kg) |
| Ixx / Iyy / Izz / Ixz | 562 000 / 1 473 000 / 1 894 000 / 8 000 slug·ft² = 762 000 / 1 997 000 / 2 568 000 / 10 850 kg·m² |
| CG / ARP | FS 639 / 625 in |
| Gear (k, c, c_rebound lb/ft, lb·s/ft) | nose 90 000 / 4 000 / 8 000, steer ±35°; mains 120 000 / 10 000 / 20 000 at x 648 in, y ±100 in, z −84 in; nose x 158 in. SI: nose 1.31 MN/m, mains 1.75 MN/m |
| CL(α) table (rad → CL) | −0.20 → −0.68; 0 → 0.20; 0.23 → 1.20 (CLmax clean ≈1.2 at 13°); 0.46 → 0.20 |
| ΔCL flaps (×flap-pos-norm) | 0.9 (full) |
| CLδe | 0.2 |
| CD0(α) | 0 → 0.021; ±0.26 → 0.042; ±1.57 → 1.5 |
| CDi | 0.043·CL² (×kCDge) |
| CD Mach | 0 up to M 0.79; 0.023 at M 1.1; 0.015 at M 1.8 |
| CD flaps / gear / speedbrake / spoilers / δe | 0.059·flap_norm / 0.015 / 0.02 / 0.04 / 0.059·|δe| |
| CDβ | 0 → 0.05 at |β| 0.26 → 1.23 at 1.57 |
| kCLsb / kCLsp (lift loss) | 1 → 0.85 ; 1 → 0.6 |
| CYβ | −1.0 |
| Clβ / Clp / Clr | −0.09 / −0.4 / 0.09 |
| Clδa | 0.10 at M 0 → 0.033 at M 2 (linear) |
| Clδr | 0.01 |
| Cmα / Cmq / Cmα̇ | −0.6 / −27.0 / −16.0 |
| Cmδe | −1.20 at M 0 → −0.30 at M 2 |
| Cnβ / Cnr / Cnδr | 0.26 / −0.35 / −0.20 |
| Engines (CFM56, JSBSim) | 2 × 20 000 lbf SLS, bypass 5.9, TSFC 0.657 lb/(lbf·h), idle N1 30 %; `MilThrust` table (fraction of rated vs Mach rows 0/0.2/0.4/0.6/0.8/1.0 and altitude cols −10k/0/10k/20k/30k/40k/50k ft): M0: 1.26/1.00/0.74/0.534/0.372/0.241/0.149; M0.2: 1.171/0.934/0.697/0.506/0.355/0.231/0.143; M0.4: 1.15/0.921/0.692/0.506/0.357/0.233/0.145; M0.6: 1.181/0.951/0.721/0.532/0.378/0.248/0.154; M0.8: 1.258/1.02/0.782/0.582/0.417/0.275/0.17; M1.0: 1.369/1.12/0.871/0.651/0.475/0.315/0.195. Idle thrust fractions: M0: 0.042/0.0436/0.0528/0.0694/0.0899/0.1183/0.1467. Real CFM56-7B26: 26 300 lbf; cruise TSFC ≈ 0.6. Spool: N1 first-order lag τ ≈ 1.5–3 s (faster at high N1), thrust ∝ N1². |

Thrust line below CG (engines under the wing) → pitch-up with thrust: `M = T·z_eng`, z_eng ≈ 1.5–2 m below CG. Jet-specific extras: Mach buffet/tuck (`Cm_M`), speedbrakes/spoilers (lift dump on landing), autobrake, reversers (−40 % of forward idle-ish thrust at full reverse), stab trim as a movable horizontal stabilizer (`Cm_iH ≈ −2.5 to −3 /rad`, ±(4…14)° travel), flaps 1/2/5/10/15/25/30/40 with slats.

### 11.2 Parametric derivation of plausible coefficients for a new aircraft (DATCOM-lite; Nelson *Flight Stability and Automatic Control* ch. 2–3, Raymer *Aircraft Design* ch. 12 & 16)

Inputs: S, b, c̄, λ (taper), Λ_c/4 (sweep), Γ (dihedral), S_t, l_t, S_v, l_v, z_v, wing height (high/mid/low), elevator/rudder/aileron chord ratios c_f/c, CG position, cruise M.

```
AR = b²/S ;  β_M = sqrt(1 − M²) ;  η_airfoil ≈ 0.95
CLα_w  = 2π·AR / (2 + sqrt(4 + (AR·β_M/η_airfoil)²·(1 + tan²Λ_c/2 / β_M²)))      (Raymer 12.6; ≈ 4.6 for the 172, 5.0–5.5 for an AR 8–10 swept jet)
dε/dα  = 2·CLα_w / (π·AR)        (≈ 0.40 for AR 7.4)
CLα    = CLα_w·(1 + 0.1·fuselage) + η_t·(S_t/S)·CLα_t·(1 − dε/dα)   η_t ≈ 0.9 (0.95 in slipstream), CLα_t from the same formula with AR_t
x_np/c̄ = x_ac_w/c̄ + η_t·V_H·(CLα_t/CLα_w)·(1 − dε/dα) − fuselage term (−0.03…−0.08)   ;  V_H = S_t·l_t/(S·c̄)
Cmα    = −CLα·(x_np − x_cg)/c̄     (static margin 0.10–0.25 typical)
Cmq    ≈ −2.2·η_t·CLα_t·V_H·(l_t/c̄)      (×1.1 for wing/body; 172: −2.2·0.9·3.5·0.394·3.2 ≈ −8.7 … Roskam −12.4)
Cmα̇    ≈ Cmq·(dε/dα)/1.1 ≈ −2·η_t·CLα_t·V_H·(l_t/c̄)·dε/dα
CLq    ≈ 2·η_t·CLα_t·V_H ;  CLα̇ ≈ CLq·dε/dα
τ(c_f/c) ≈ 0.25 → 0.45, 0.30 → 0.52, 0.40 → 0.60, 0.50 → 0.68 (flap effectiveness)
Cmδe   = −η_t·V_H·CLα_t·τ_e ;  CLδe = η_t·(S_t/S)·CLα_t·τ_e
V_v    = S_v·l_v/(S·b)
Cnβ    = η_v·V_v·CLα_v·(1 + dσ/dβ) + Cnβ_fus,   (1+dσ/dβ)·η_v ≈ 0.724 + 3.06·(S_v/S)/(1 + cosΛ) + 0.4·z_w/d_f + 0.009·AR ;  Cnβ_fus ≈ −1.3·(Vol_fus/(S·b))·(d_f/w_f) (destabilizing, ≈ −0.02…−0.06)
CYβ    = −η_v·(S_v/S)·CLα_v·(1 + dσ/dβ) − 0.0001·|Γ_deg|·57.3 − k_body (≈ −0.2 for a fat fuselage)
Clβ    = Clβ_Γ + Clβ_Λ + Clβ_wingpos + Clβ_v
         Clβ_Γ = −(CLα_w·Γ_rad/4)·(1 + 2λ)/(3(1 + λ))    (≈ −0.05 for 172's 1.7° dihedral)
         Clβ_Λ ≈ −CL·sin(2Λ)/8 … /4 (rough; calibrate)   ;  Clβ_wingpos ≈ −0.03 (high wing) / 0 (mid) / +0.03 (low), ×(CL/0.4)
         Clβ_v = CYβ_v·(z_v·cosα − l_v·sinα)/b
Clp    = −(CLα_w/12)·(1 + 3λ)/(1 + λ)·k_AR   (strip theory; k_AR ≈ 0.7 for AR 6–8: gives −0.49 for the 172 vs −0.484 Roskam)   + Clp_tail (−0.02)
Clr    ≈ CL/4 ;  Cnp ≈ −CL/8 ;  Cnr ≈ −2·η_v·V_v·CLα_v·(l_v/b) − CD/4 − 0.02
Cnδr   = −η_v·V_v·CLα_v·τ_r ;  CYδr = η_v·(S_v/S)·CLα_v·τ_r ;  Clδr = CYδr·z_v/b
Clδa   = (2·CLα_w·τ_a·c_root/(S·b))·∫_{y1}^{y2} c(y)/c_root·y dy   (two ailerons; for a straight-taper wing: = (CLα_w·τ_a·c_r/(S·b))·[ (y2²−y1²) − (2/3)(1−λ)(y2³−y1³)/(b/2) ])
Cnδa   ≈ −0.2·CL·Clδa  (adverse yaw; Frise/differential ailerons reduce to −0.1·CL·Clδa)
Inertia (Raymer ch. 16 nondimensional radii of gyration): Ixx = m·(R_x·b/2)² ; Iyy = m·(R_y·L/2)² ; Izz = m·(R_z·(b+L)/4)² ; Ixz ≈ 0.01…0.03·Izz
   Typical R_x/R_y/R_z: single-engine prop 0.25/0.38/0.39 ; jet transport 0.25/0.38/0.46 ; twin turboprop 0.22/0.34/0.38
   172 check (m 1 157 kg, b 10.91 m, L 8.28 m): Raymer radii give 2 150 / 2 865 / 4 050 kg·m² vs the Roskam set 1 285 / 1 825 / 2 667 → effective radii 0.19/0.30/0.32. Use the Roskam set for the 172 and Raymer's radii (± 30 %) only for generated aircraft.
```

Sanity bounds for any generated set (reject/flag otherwise): CLα 4–6.5, Cmα −0.3…−2.0, Cmq −8…−40, Cnβ 0.05–0.3, Clβ −0.03…−0.15, Clp −0.3…−0.6, Cnr −0.08…−0.4, Cmδe −0.8…−2.0, Clδa 0.05–0.25, Cnδr −0.04…−0.25, CD0 0.018–0.035 (jet/GA clean), e 0.75–0.85 (jet) / 0.6–0.8 (GA).

---

## 12. TypeScript interface sketches

```ts
// ---------- configuration ----------
export interface Table1D { x: Float64Array; y: Float64Array }                 // linear interp, clamped
export interface Table2D { rows: Float64Array; cols: Float64Array; data: Float64Array } // row-major

export interface AircraftConfig {
  meta: { name: string; variant: string; sources: string[]; license: string };
  geometry: {
    S: number; b: number; cbar: number;                 // m², m, m
    arpOffset: [number, number, number];                // ARP relative to empty-CG, body frame (m)
    macHeightAboveGear: number;                         // for h/b in ground effect (m)
  };
  mass: {
    emptyMass: number; emptyCG: [number, number, number];            // kg, body-frame position vs datum (m)
    emptyInertia: { Ixx: number; Iyy: number; Izz: number; Ixz: number }; // kg·m² about empty CG
    stations: { name: string; pos: [number, number, number]; massMax: number; mass: number }[];
    tanks: { name: string; pos: [number, number, number]; capacityKg: number; usableKg: number; contentsKg: number; feedOrder: number }[];
    cgLimits: { fwdAtMass: [number, number][]; aft: number };         // metres from datum
  };
  aero: {
    CL: { table: Table2D /* alpha x hyst */; hystOn: number; hystOff: number; dFlap: Table1D; dElev: number; q: number; adot: number; CD90: number; CLminNegStall: number };
    CD: { CD0: number; alphaFlapTable: Table2D; dFlap: Table1D; dElevAbs: number; betaAbs: number; kInducedOverride?: number };
    CY: { beta: Table1D | number; p: number; r: number; da: number; dr: number };
    Cl: { beta: number; p: number; r: Table1D | number; da: number; dr: number; spinScale?: Table1D };
    Cm: { Cm0: number; alpha: number; q: number; adot: number; de: number; dFlap: Table1D; highAlphaScale: Table1D; deHighAlphaScale: Table2D };
    Cn: { beta: number; p: Table1D | number; r: number; da: Table1D | number; dr: number; slipstream: number /* -0.05 */ };
    groundEffect: { kCL: Table1D; kCD: Table1D };                      // vs h/b
    controlsUseSlipstreamQ: { elevator: boolean; rudder: boolean };
  };
  propulsion: {
    engine: { type: 'piston'; ratedPowerW: number; ratedRPM: number; idleRPM: number; displacementM3: number; VE: number; ISFC: number; maxMAPinHg: number; minMAPinHg: number; frictionCoef: number; inertia: number; mixtureEfficiency: Table1D };
    propeller: { diameter: number; blades: number; inertia: number; Ct: Table1D; Cp: Table1D; sense: 1 | -1; pFactorM: number; position: [number, number, number]; tiltDeg: [number, number] };
  } | {
    engine: { type: 'turbofan'; ratedThrustN: number; tsfc: number; idleN1: number; spoolTau: number; milThrust: Table2D; idleThrust: Table2D; position: [number, number, number][]; reverserFraction: number };
  };
  gear: {
    name: string; pos: [number, number, number]; type: 'bogey' | 'structure';
    k: number; cComp: number; cRebound: number; tyreRadius: number;
    muStatic: number; muDynamic: number; muRolling: number; pacejka: { B: number; C: number; E: number };
    maxSteerDeg: number; brakeGroup: 'none' | 'left' | 'right' | 'both'; retractable: boolean;
  }[];
  controls: {
    elevator: { minDeg: number; maxDeg: number; tau: number; rateDegPerS: number };
    aileron:  { upDeg: number; downDeg: number; tau: number; rateDegPerS: number };
    rudder:   { maxDeg: number; tau: number; rateDegPerS: number };
    flaps:    { detentsDeg: number[]; transitS: number[] };
    trim:     { elevatorFraction: [number, number]; rateNormPerS: number };
  };
  limits: { VneKt: number; VnoKt: number; VaKt: number[]; VfeKt: number[]; nzMax: number; nzMin: number };
}

// ---------- runtime ----------
export interface FDMInputs {
  elevator: number; aileron: number; rudder: number;        // −1..1 (pilot)
  elevatorTrim: number; rudderTrim?: number; aileronTrim?: number;
  flapsIndex: number; throttle: number; mixture: number;    // 0..1
  brakeLeft: number; brakeRight: number; parkingBrake: boolean;
  magnetos: 0 | 1 | 2 | 3; starter: boolean; fuelSelector: 'off' | 'left' | 'right' | 'both';
  gearDown?: boolean; speedbrake?: number; reverser?: number;
}

export interface Environment {
  originLatDeg: number; originLonDeg: number; originAltM: number;   // tangent-plane origin
  terrainHeight(n: number, e: number): number;                       // m above origin datum
  terrainNormal(n: number, e: number, out: Float64Array): void;
  windNED(posNED: Float64Array, out: Float64Array): void;            // mean wind + shear + gust (m/s)
  turbulence: { W20Kt: number; poeIndex: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; seed: number };
  deltaTisaK: number; qnhPa: number;
}

export interface FDMState extends RigidState {
  t: number;
  rpm: number; map_inHg: number; fuelFlowKgS: number; egtK: number; engineRunning: boolean;
  surfaces: { elevatorRad: number; aileronLRad: number; aileronRRad: number; rudderRad: number; flapDeg: number; trimRad: number };
  gear: { compression: number; normalForce: number; onGround: boolean; wheelSpeed: number; steerRad: number }[];
  turb: Float64Array;                                 // ξ_u ξ_v ξ_w ξ_p ξ_q ξ_r + prev
  stallHyst: 0 | 1;
  tanksKg: Float64Array;
}

export interface FDMOutputs {                          // derived each step for instruments/audio/UI
  alpha: number; beta: number; alphaDot: number;
  Vtrue: number; Vcas: number; Vias: number; Veas: number; mach: number; qbar: number;
  rho: number; pStatic: number; T: number; a: number;
  altitudeMSL: number; altitudeAGL: number; altitudeIndicated: number; verticalSpeed: number;
  eulerRad: [number, number, number]; headingMagRad: number;
  nz: number; ny: number; nx: number;                   // body load factors (g)
  groundSpeed: number; track: number; onGround: boolean;
  forces: { aero: Float64Array; prop: Float64Array; gear: Float64Array }; moments: typeof forces;
  coefficients: { CL: number; CD: number; CY: number; Cl: number; Cm: number; Cn: number };
  engine: { powerW: number; thrustN: number; torqueNm: number; pctPower: number };
  warnings: { stall: boolean; overspeed: boolean; overG: boolean; gearOverspeed: boolean };
}

export interface FDM {
  readonly config: AircraftConfig;
  state: FDMState;
  reset(init: { latDeg: number; lonDeg: number; altM: number; headingRad: number; speedKt?: number; onGround: boolean }): void;
  trim(target: { VcasKt: number; gammaRad: number; altM: number }): boolean;
  step(dt: number, inputs: FDMInputs, env: Environment): FDMOutputs;   // fixed dt, RK4 internally
}
```

### 12.1 RK4 step skeleton (forces evaluated per stage)

```ts
function derivatives(s: FDMState, u: FDMInputs, env: Environment, out: Float64Array): void {
  const air = atmosphere(altitude(s), env.deltaTisaK);
  const rel = relativeWind(s, env);                       // α, β, V, q̄, q̄_uw using wind+turbulence
  const F = new Float64Array(3), M = new Float64Array(3);
  addAero(cfg, s, rel, air, F, M);                        // §2–3 incl. ground effect, slipstream q̄
  addPropulsion(cfg, s, rel, air, F, M);                  // §4: thrust at hub, torque, P-factor, gyro
  addGear(cfg, s, env, F, M);                             // §5
  addGravity(s, F);
  // u̇ v̇ ẇ, ṗ q̇ ṙ, q̇uat, ṗos  → out ; plus RPṀ, fuel, actuator and turbulence filter rates
}
function rk4Step(s, u, env, dt) { k1 = f(s); k2 = f(s + dt/2·k1); k3 = f(s + dt/2·k2); k4 = f(s + dt·k3); s += dt/6·(k1+2k2+2k3+k4); normalize(s.q); }
```

Turbulence noise ν must be drawn **once per step** (not per stage) and held; stall-hysteresis flag and brake/contact booleans are updated once per step after the RK4 substeps to keep the stages consistent.

---

## 13. Open questions / items to verify when the network allows

1. 172S POH Section 5 tables (cruise performance rows, airspeed calibration, stall speeds vs bank) — only Vs0/Vs1/Vx/Vy/Vg/ROC/take-off/landing headline numbers were cross-confirmed; the position-error table in §7 is a reconstruction.
2. Exact Lycoming IO-360 power curve (Lycoming Operator's Manual 60297-12, altitude-performance chart) to calibrate VE/ISFC in §4.3 — currently tuned to "180 hp at 2 700/28.5 inHg" and "≈10 gph at 75 %".
3. Roskam Appendix B attribution (Cessna 182 vs 172) — does not affect the implementation but should be stated correctly in the docs.
4. Flap transit time (JSBSim 4 s total vs ~7–9 s real) and trim-tab travel (22°/19°) — from memory of the TCDS, not fetched.
5. Whether to adopt the FlightGear spin tables wholesale (GPL-2.0) or re-derive them (recommended: re-derive; the shapes are described in §3.3).
6. Licensing: our JSON aircraft file should be our own compilation (numbers tuned to POH), with attribution to JSBSim/FlightGear/NACA in a NOTICE file; do not ship their XML.
