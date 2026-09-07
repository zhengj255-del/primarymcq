/**
 * Renders the graph/diagram a question's stem refers to ("Please see graph
 * below…"). A handful of official questions were transcribed without their
 * plate, which left options like "A / B / C (no change) / D / E" completely
 * unanswerable. The figures under client/public/mcq-figures/ are ORIGINAL
 * drawings reconstructed from the underlying physiology — not scans of the
 * copyrighted exam paper — so the caption says so rather than implying the
 * candidate is looking at the real ANZCA plate.
 */

interface FigureMeta {
  /** Screen-reader description — must convey what a sighted user can read off the plot. */
  alt: string;
  /** Shown under the figure. */
  caption: string;
}

// Only keys listed here render. An unknown key draws nothing rather than a
// broken image: a missing figure should degrade to today's behaviour, not to a
// torn-page icon in the middle of a question.
export const MCQ_FIGURES: Record<string, FigureMeta> = {
  "vascular-function-curve": {
    alt: "Vascular function curves plotting venous return against right atrial pressure. Dashed curve C is the baseline, crossing zero flow at seven millimetres of mercury. Curve A is shifted right, exactly parallel to C, crossing at ten and a half. Curve B is both shifted left, crossing at five and a half, and steeper than C. Curve D is shifted left parallel to C, crossing at three. Curve E is flatter than C but crosses at the same seven. All five flatten to a horizontal plateau below a right atrial pressure of about minus two, where the great veins collapse; the plateau height differs between curves but begins at the same pressure on all five.",
    caption: "Vascular (venous return) function curves — reconstructed figure, not the original exam plate.",
  },
  // For the bare-letter question this alt text IS the option list, so it must
  // say where every letter sits.
  "circle-system": {
    alt: "Schematic circle breathing system, drawn with fresh gas flowing. Components: fresh gas inlet, inspiratory and expiratory unidirectional valves shown as circles containing a direction triangle, corrugated inspiratory and expiratory limbs, Y-piece joining them at the patient, reservoir bag, APL valve venting to scavenging, and a carbon dioxide absorber canister. Five labelled points: A on the common limb between the Y-piece and the patient; B on the return conduit between the reservoir bag junction and the absorber inlet; C between the absorber outlet and the fresh gas inlet; D between the fresh gas inlet and the inspiratory unidirectional valve; E on the reservoir bag mount.",
    caption: "Circle breathing system — reconstructed figure, not the original exam plate.",
  },
  "circle-system-plain": {
    alt: "Schematic circle breathing system with each component named: fresh gas inlet, inspiratory unidirectional valve, corrugated inspiratory limb, Y-piece joining the limbs at the patient, corrugated expiratory limb, expiratory unidirectional valve, APL valve venting to scavenging, reservoir bag, and carbon dioxide absorber canister. The valves are drawn as circles containing a triangle showing the direction each admits gas.",
    caption: "Circle breathing system — reconstructed figure, not the original exam plate.",
  },
  "airway-pressure-vcv": {
    alt: "Airway pressure against time over three identical, equally spaced mandatory breaths, with no negative deflection before any breath. Each breath steps up from a positive end-expiratory baseline of five to about ten, rises linearly during constant-flow inspiration to a peak of twenty, drops abruptly to a flat plateau of fifteen during an inspiratory pause, then decays exponentially back to the baseline of five.",
    caption: "Airway pressure against time — reconstructed figure, not the original exam plate.",
  },
  "bis-eeg-light": {
    alt: "An eight second raw electroencephalogram trace showing continuous rhythmic activity of roughly fifty microvolts peak to peak. A dominant alpha-frequency oscillation of about ten cycles per second waxes and wanes in spindle-like packets, riding on a slower undulation of about one per second, with only faint low-amplitude fast activity and no burst suppression, isoelectric periods or blink artefact.",
    caption: "Raw EEG trace from a BIS monitor — reconstructed figure, not the original exam plate.",
  },
};

export function McqFigure({ figure }: { figure: string | null | undefined }) {
  if (!figure) return null;
  const meta = MCQ_FIGURES[figure];
  if (!meta) return null;

  return (
    <figure className="my-3" data-testid={`mcq-figure-${figure}`}>
      {/* The plates carry their own light background so they stay legible in
          the app's dark theme, the same way a photo would. max-w-full keeps
          them inside the content column on a phone. */}
      <img
        src={`/mcq-figures/${figure}.svg`}
        alt={meta.alt}
        className="w-full max-w-full h-auto rounded-md border border-border bg-white"
      />
      <figcaption className="mt-1 text-[11px] text-muted-foreground">{meta.caption}</figcaption>
    </figure>
  );
}
