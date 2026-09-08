import { Badge } from "@/components/ui/badge";
import { parseSittings, sittingLabel } from "@shared/mcqSittings";

// The one tag every question carries: the exam sitting(s) it is known from,
// the way the college names them ("2004.2"), derived from the question's code
// and paper tags by shared/mcqSittings.ts. Never the Black Bank's letter code
// — "KD39" is a filing key in a study bank, not a fact about the exam — so a
// question with no dated evidence says so instead of showing one.
const SHOWN = 3;

export function sittingTagText(code: string, papers: readonly string[]): { text: string; title: string; known: boolean } {
  const labels = parseSittings(code, papers).map(sittingLabel);   // newest first
  if (labels.length === 0) {
    return { text: "Sitting unknown", title: "No exam sitting is recorded for this question", known: false };
  }
  const rest = labels.length - SHOWN;
  return {
    text: labels.slice(0, SHOWN).join(" · ") + (rest > 0 ? ` +${rest}` : ""),
    title: `Exam sitting${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}`,
    known: true,
  };
}

export function SittingTag({
  code, papers, className = "", testId,
}: {
  code: string;
  papers: readonly string[];
  className?: string;
  testId?: string;
}) {
  const { text, title, known } = sittingTagText(code, papers);
  return (
    <Badge
      variant={known ? "secondary" : "outline"}
      className={`font-mono ${known ? "" : "text-muted-foreground"} ${className}`.trim()}
      title={title}
      data-testid={testId}
    >
      {text}
    </Badge>
  );
}
