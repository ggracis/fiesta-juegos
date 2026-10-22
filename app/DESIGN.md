# Design direction: "Amanecer" (Sunrise Party)

A sun rising over a festive crowd: red at the edges, a glowing coral-to-sun core, soft glass layers on top. Every screen has one glowing focal point, big rounded shapes and soft depth so it reads from across a room. The characters ("los Distintos", glossy jelly blobs with faces) are the brand on every screen. Premium tech feel, fluid motion, but fun and festive. No third-party logos or brand names anywhere.

## Tokens

| Token | Value |
|-------|-------|
| red | `#E4002B` |
| deep red | `#8F0A24` |
| night wine (panel base) | `#2A0610` |
| coral | `#FF5A4D` |
| orange | `#FF8A3D` |
| sun | `#FFC14D` |
| cream | `#FFF7F3` |
| ink | `#2B0B12` |
| mint (only for "correct") | `#2BD9A0` |
| magenta pop (confetti/accents) | `#FF2D8A` |

- `--sunrise: radial-gradient(120% 90% at 50% 100%, #FFC14D 0%, #FF8A3D 25%, #FF5A4D 50%, #E4002B 75%, #2A0610 100%)` for the panel attract screen and landing hero.
- `--grad-btn: linear-gradient(135deg, #E4002B, #FF5A4D 60%, #FF8A3D)`.
- Glass on dark: `rgba(255,255,255,.14)` fill, 1px `rgba(255,255,255,.35)` border. No `backdrop-filter` on panels.
- Type: display Bricolage Grotesque 800; UI Outfit 500/600/800; numbers Outfit 800 with `tabular-nums`. Panel: titles 120-180px, body >= 36px, labels >= 28px. Landing: h1 `clamp(44px, 13vw, 64px)`, body 17px, inputs >= 16px.
- Radii: 20 / 32 / 48px, pills 999px.
- Shadows are warm, never grey. Card: `0 24px 48px -20px rgba(143,10,36,.55), inset 0 2px 0 rgba(255,255,255,.5)`. Jelly button: `0 14px 28px -10px rgba(228,0,43,.6), inset 0 -4px 0 rgba(0,0,0,.12), inset 0 2px 0 rgba(255,255,255,.35)`.
- Motion: standard `cubic-bezier(.2,.8,.2,1)` 320ms; spring `cubic-bezier(.34,1.56,.64,1)` 450ms; exit `cubic-bezier(.4,0,1,1)` 180ms; press scale .94 in 90ms; ambient loops 4-8s.

## Screens

**Landing hero (phone).** Full-bleed sunrise, mascot trio on a glowing sun disc with a slowly rotating conic-ray layer (one element, 40s). Date pill "30 · NOV". Headline word-by-word reveal (GSAP SplitText, words not chars), mascots rise with spring stagger 80ms, sticky CTA "Reservar mi lugar" that breathes (scale 1 to 1.03, 2.4s). Info cards (Lugar, Programa, Info útil) become horizontal snap chips. Copy: "Se acaba el año. Empieza la fiesta." / "Reserva tu lugar en 20 segundos."

**Registration.** Large glass search pill, results stagger in (40ms) with mascot-initial avatars, `aria-live`. Tap a row and it expands into the confirm card (GSAP Flip). "Hola, {nombre}. ¿Eres tú?" with "Soy yo" and "No soy yo". Confirm turns into spinner then check. Friendly errors: "No te encontramos. Prueba con tu apellido."

**Ticket reveal (reward moment, ~2.4s).** Sealed envelope "Toca para abrir tu entrada", tap = `navigator.vibrate(20)` + flap opens (rotateX 400ms), ticket springs up, one foil sheen sweep (900ms), QR fades in, confetti burst from the ticket, PIN digits flip in 90ms apart. Perforated notch (CSS mask). Copy: "¡Estás dentro!" / "Tu PIN es tu llave en las pantallas". Keep the download button. Reduced motion: 200ms fade only. Returning visitors see the ticket directly (no envelope).

**Panel attract.** Dark wine base + sunrise, huge pulsing sun disc (scale 1 to 1.08, 3s), 6-8 giant mascots (~280px) bobbing around it, one visibly odd that winks every 6s. Title "¿ENCUENTRAS AL DISTINTO?" ~160px, giant pill "TOCA PARA JUGAR" with an expanding ring ripple every 2s, and a phantom-hand tap hint every 8s. Bottom strip: "Mejores puntajes de esta pantalla" (top 3 stored locally), cross-fading. Slow, large motion only.

**PIN numpad.** Glass card ~1100px wide, six gradient-bead dots, 3x4 jelly keys 160x120px with 72px digits, "Borrar" and "Salir" as 36px text keys. Press: scale .94 + highlight layer. Dot pops in with spring. Wrong: shake (320ms) + dots flash red. Right: dots turn mint and fly together. Hint: "Tu PIN está en tu entrada".

**Name confirm.** "¡Hola, {nombre}!" ~140px with letter pop (30ms stagger), mascot avatar with the initial on its belly. "¡Soy yo, a jugar!" (wide primary) and "No soy yo" (narrow ghost), 120px tall.

**How-to.** Looping 3x3 demo: odd character with pulsing mint halo, a hand taps it, "+10" floats. Captions Mira / Encuentra / Toca 1.2s apart. 10s progress ring around "EMPEZAR"; "Saltar" button >= 56px.

**Gameplay.** Glossy blob characters (highlight ellipse, inner shade ellipse, blinking eyelids via class toggle every 3-5s staggered) rendered as SVG `<symbol>` + `<use>`. Cells pop in rippling from the centre (15ms stagger). Timer bar drains with `transform: scaleX`, sun to orange to red in the last 3s with a gentle pulse, number at 64px. Correct: odd one jumps (scale 1.25 spring) + mint ring + "+n" floats + 12-spark burst; other cells collapse in a diagonal wave; next round after 500ms. Wrong: cell shakes red, "−2" appears, stage shakes 6px. Round banner "Ronda 4" wipes across in 600ms; from round 7 badge "¡Nivel experto!". HUD: round pips + score with count-up. Hard rounds must not depend on colour alone: add a shape/accessory cue (colour-blind players).

**Result.** Board dims, medallion drops with spring, score counts up over 1.2s. Tiers: < 40 "¡Buen intento!", 40-70 "¡Muy bien!", > 70 "¡Increíble!". Confetti 60-80 particles. "¡Récord de la pantalla!" badge when it beats the local top. 5s countdown ring "Volviendo en 5…", iris/wipe back to attract. Copy: "¡Gracias! Pásale la pantalla al siguiente."

**Sound.** Off by default (noisy venue). Optional 56px speaker toggle on the panel; Web Audio oscillator blips (< 250ms): key tick, correct chime, wrong buzz, result fanfare. Never the only cue.

## Effects budget (weak Android panels)

Use: CSS spring presses and pops, one rotating conic layer, staggered pop-ins, ring ripples, foil sweep, canvas-confetti (cap 80 particles, `disableForReducedMotion`), count-ups, GSAP timelines/SplitText/Flip.

Avoid: WebGL/three, particle libraries, animating `filter`, `backdrop-filter` or `box-shadow`, animating `background-position` on large gradients, SVG filters on characters, more than ~40 simultaneously animated nodes, `will-change` everywhere (only the sun disc and timer bar).

## Accessibility

Text contrast >= 4.5:1 (white only on red at >= 18px bold; ink on sun/orange). Correct/wrong use icon + motion + colour. `prefers-reduced-motion` disables ambient loops and the ticket sequence on phones. Visible `:focus-visible`, labelled inputs, `role="alert"` on errors. Touch targets >= 56px with >= 16px gaps. Kiosk touch hygiene (no zoom/scroll/context menu) only on panel pages, never on the landing.
