import { useState } from "react";
import { AgeGate } from "./AgeGate";
import { AppPlayer } from "./AppPlayer";
import { Onboarding } from "./Onboarding";
import { needsOnboarding } from "../lib/onboarding";

/** The app: the first-visit screens once, then behind the age screen (for
 *  anyone who was already here before those existed). */
export function AppRoot() {
  const [onboarding, setOnboarding] = useState(needsOnboarding);
  if (onboarding) return <Onboarding onDone={() => setOnboarding(false)} />;
  return (
    <AgeGate>
      <AppPlayer />
    </AgeGate>
  );
}
