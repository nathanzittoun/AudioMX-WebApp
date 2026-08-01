# audiomx-ax1.glb

The 3D model the hero frames were rendered from. 13 named parts —
`body_shell`, `mid_rail`, `screen_glass`, `display`, `usb_c_port`,
`speaker_grille_l/r`, `button_ring`, `button_cap`, `button_flutes`,
`logo_audiomx_front`, `logo_nyp_back`, `logo_wcm_back`, `back_etching`.

**Nothing loads this at runtime**, and that is the point: the product page uses
150 pre-rendered WebP frames instead. A frame sequence needs no 3D library, no
WebGL context and no GPU, and it can be scrubbed frame-accurately from a scroll
handler — none of which is true of a live scene. Re-rendering the sequence is
what this file is for.

It lives outside `public/` so it is never shipped. Moving it into `public/`
would add 520 KB to every visit for a file no page requests.

**Before the parts carrying `logo_nyp_back` and `logo_wcm_back` appear in any
published render**, get written permission from those institutions. A partner
logo on a product page reads as an endorsement.
