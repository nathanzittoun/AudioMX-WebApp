# AudioMX editorial image set

## Purpose

Create eight polished raster assets that give the AudioMX product site a wider
visual vocabulary. Each image must reveal a different aspect of AudioMX One so
the homepage no longer repeats the same full-device render across unrelated
content blocks.

The set is an editorial product-photography system rather than eight unrelated
concepts. It should have the finish, restraint, and material sensitivity of a
premium consumer-electronics launch while remaining recognizably AudioMX and
clinically credible.

## Creative direction

The approved direction is **product cinema**: controlled studio photography,
extreme component details, and a small amount of environmental context.

The image family uses the existing site palette:

- white and pale ice blue for clarity;
- brushed silver and soft grey for the device materials;
- metallic navy for visual weight;
- restrained AudioMX blue as a rim light or screen accent.

Lighting should be soft and directional, with long gradients over the shell,
precise specular highlights on machined parts, and natural contact shadows.
Surfaces remain clean but not synthetic: brushed aluminium, satin glass, fine
machining, and softly textured studio backdrops should all be visible.

## Product invariants

All images must preserve the AudioMX One identity established by the supplied
references and the project render assets:

- a tall, narrow, softly rounded silver enclosure;
- a dark rectangular display in the upper front face;
- one circular fluted metal dial below and to the right of the display;
- two matched circular microphone grilles on the lower front face;
- a USB-C port centered on the underside;
- vertically brushed aluminium with softly rolled edge highlights.

No generated image may add controls, camera lenses, speakers, medical probes,
Apple branding, partner branding, or a second display. Small geometric drift is
acceptable only in extreme macros where the complete enclosure is not visible.

## Deliverables

Final selected files will live in `public/site/editorial/` with descriptive,
stable names. The set contains:

1. **`dual-mems-macro`** — a near-symmetrical close-up of both microphone
   grilles, with shallow depth of field and cool metallic light. Primarily for
   the “A matched pair of microphones” card. Target crop: square.
2. **`screen-glass-macro`** — the recording display and its transition into
   the aluminium shell, showing a restrained blue waveform and timer. Primarily
   for “A recording is only the start.” Target crop: 8:5 landscape.
3. **`usb-c-underside`** — a low-angle detail of the underside and centered
   USB-C port, with a fine blue rim light. Suitable for connectivity content.
   Target crop: square.
4. **`control-dial-macro`** — an extreme close-up of the fluted crown, its
   machining, and its shadow on the brushed shell. Suitable for the one-control
   design story. Target crop: square.
5. **`continuous-shell-profile`** — a quiet side-profile study emphasizing the
   uninterrupted enclosure and rounded seams. Suitable for the “one continuous
   shell” chapter. Target crop: 4:5 portrait.
6. **`ice-studio-three-quarter`** — a complete three-quarter product portrait
   on a luminous pale-blue surface. Suitable for protocol or general product
   content. Target crop: 4:5 portrait.
7. **`midnight-studio-three-quarter`** — a complete product portrait emerging
   from metallic navy, with controlled blue edge light and generous negative
   space. Suitable for a dark feature card or closing section. Target crop: 4:5
   portrait.
8. **`clinical-desk-context`** — AudioMX One standing on a refined, uncluttered
   clinical desk with only neutral supporting objects and no people or patient
   information. Suitable for the closing call to action. Target crop: 4:5
   portrait.

## Composition and usage

The assets should remain useful when cropped responsively. Important product
details stay inside the central 70% of the frame, while at least one side or
corner retains quiet negative space. No marketing headline is baked into an
image; HTML remains responsible for copy and accessibility.

The screen macro may contain only the simple recording state already used by
the project: timer, waveform, microphone indicator, and battery indicator. Any
patient identifier must be synthetic. Other images should keep the screen dark
or visually simple so generated UI text cannot undermine the product finish.

## Clinical and brand guardrails

- Do not show diagnoses, risk scores, probabilities, model outputs, or claims
  that the current static application cannot make.
- Do not imply HIPAA readiness or show real patient information.
- Do not claim a recording was written to a real Epic chart.
- Do not show WCM, NYP, Apple, Epic, or other third-party logos.
- Do not add people, faces, hands, gloves, holograms, floating interfaces, or
  science-fiction medical effects.
- Do not add text, captions, watermarks, or decorative logos to the images.

## Generation workflow

Use the built-in image-generation path with the project's product renders as
high-fidelity visual references. The full-device renders establish silhouette
and proportions; `screen-ui.png` is a supporting reference only for the screen
macro. Generate each deliverable separately with a prompt tailored to its crop
and feature rather than requesting interchangeable variants from one prompt.

Inspect every output for product geometry, material realism, unintended text,
duplicate controls, background quality, and responsive crop safety. Iterate on
one defect at a time. Keep only the final selected version of each deliverable
in `public/site/editorial/`; source alternatives may remain outside the project
only while evaluating them.

## Acceptance criteria

The set is complete when all eight images:

- are visually distinct at thumbnail size;
- read as one coherent AudioMX campaign;
- preserve the device identity and feature placement;
- contain no unsupported clinical claim or third-party mark;
- survive their target crop without losing the feature being illustrated;
- are saved in the project at practical web dimensions;
- have been visually inspected at full size and as thumbnails.

Homepage markup and stylesheet integration are outside this asset-generation
request. The images will be delivered with suggested block mappings so a later
implementation can replace repeated assets deliberately.
