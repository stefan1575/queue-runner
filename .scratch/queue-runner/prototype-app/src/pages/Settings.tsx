// PROTOTYPE (throwaway): the Settings pop-up. Its layout is the one #36's layout prototype settled
// on, a copy of T3 Code's settings; see ./settings-prototype/SettingsScreen.tsx.
import { SettingsScreen } from "./settings-prototype/SettingsScreen";
import { useSettings } from "./settings-prototype/state";

export function SettingsPage({ onClose }: { onClose: () => void }) {
  return <SettingsScreen st={useSettings()} onClose={onClose} />;
}
