# AudioMX Blender UI pack

Six 960 × 600 interface plates for the on-device screen in the AudioMX hero
animation. `00-storyboard.png` is the combined overview; files `01` through
`06` are the full-resolution display textures.

## Sequence

1. `01-select-patient.png` — select synthetic Patient 0047.
2. `02-epic-connected.png` — confirm an Epic SMART on FHIR connection.
3. `03-select-test.png` — choose Pa-Ta-Ka from the six-task voice protocol.
4. `04-recording-pataka.png` — show the live 8-second capture.
5. `05-take-accepted.png` — show the quality gate and saved state.
6. `06-task-complete.png` — hold on the final marketing message.

## Suggested timing

- Patient: 0.0–2.0 s
- Epic: 2.0–3.5 s
- Test selection: 3.5–5.5 s
- Recording: 5.5–9.0 s, with the timer accelerated to 8.0 s
- Accepted: 9.0–11.0 s
- Complete: 11.0–14.0 s

Move from a full three-quarter device view into a macro screen view, then pull
back during the final plate. Use opacity and 8–12 px vertical movement for UI
transitions. Do not use a mouse pointer, hand, floating hologram, or 3D-extruded
interface.

## Product guardrails

- `Epic connected` is a product-vision moment. Do not say the take was written
  to the Epic chart.
- Do not add a diagnosis, risk score, probability, or model output.
- Use synthetic patient identifiers only.
- Do not show WCM or NYP logos without publication permission.

`screens.html` is the editable deterministic source used to render the PNGs.
