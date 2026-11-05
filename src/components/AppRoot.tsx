import { AgeGate } from "./AgeGate";
import { AppPlayer } from "./AppPlayer";

/** The app, behind the age screen. */
export function AppRoot() {
  return (
    <AgeGate>
      <AppPlayer />
    </AgeGate>
  );
}
