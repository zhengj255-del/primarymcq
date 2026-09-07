import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

// End-user 404: theme-aware (hardcoded light-mode greys glare in dark mode)
// and honest copy with a way back — "did you forget to add the page to the
// router?" is developer talk, not something to show the user.
export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">404 — page not found</h1>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            That address doesn't match any page in MCQ Study.{" "}
            <a href="#/" className="underline underline-offset-2 hover:text-foreground" data-testid="link-notfound-home">
              Back to Study
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
