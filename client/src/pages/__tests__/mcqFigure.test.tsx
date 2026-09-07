// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { McqFigure, MCQ_FIGURES } from "@/components/McqFigure";

// ---------------------------------------------------------------------------
// Questions like "Please see graph below… which line will the curve most
// resemble?" ship options that are the bare letters A–E. Without the plate the
// question is unanswerable, so the figure has to actually reach the DOM — and
// an unknown key must degrade to nothing rather than to a broken-image icon
// sitting in the middle of an exam question.
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe("McqFigure", () => {
  it("renders the plate for a known figure key", () => {
    render(<McqFigure figure="vascular-function-curve" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/mcq-figures/vascular-function-curve.svg");
    // The alt text IS the figure for a screen-reader user, and for the
    // bare-letter questions it has to convey which line is which.
    expect(img.alt).toMatch(/dashed curve C is the baseline/i);
    expect(img.alt).toMatch(/curve A is shifted right/i);
  });

  it("scales inside the phone content column instead of stretching the page", () => {
    render(<McqFigure figure="circle-system" />);
    const img = screen.getByRole("img");
    expect(img.className).toMatch(/max-w-full/);
    expect(img.className).toMatch(/h-auto/);
  });

  it("says the plate is a reconstruction rather than implying it is the real exam figure", () => {
    render(<McqFigure figure="bis-eeg-light" />);
    expect(screen.getByText(/not the original exam plate/i)).toBeTruthy();
  });

  it("renders nothing at all when there is no figure, or the key is unknown", () => {
    const { container: a } = render(<McqFigure figure={null} />);
    expect(a.innerHTML).toBe("");
    cleanup();
    const { container: b } = render(<McqFigure figure="no-such-figure" />);
    expect(b.innerHTML).toBe("");
  });

  it("gives the lettered circle plate an alt that locates every letter", () => {
    // 2018-30's options are bare letters, so a screen-reader user can only
    // answer if the alt text says where A–E sit.
    const alt = MCQ_FIGURES["circle-system"].alt;
    for (const letter of ["A", "B", "C", "D", "E"]) {
      expect(alt).toMatch(new RegExp(`\\b${letter} on |\\b${letter} between `));
    }
    // The plain plate must NOT claim letters it does not draw.
    expect(MCQ_FIGURES["circle-system-plain"].alt).not.toMatch(/labelled points|A to E/i);
  });
});
