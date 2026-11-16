// PROTOTYPE (throwaway): three layouts of the Settings page on the existing /settings route,
// switched by ?variant=A|B|C (and ?data=new for a new install). The content is #36's decision; the
// question is only how it's laid out. State is shared and in memory (state.ts); the floating bar
// switches layout and data set and shows what the runner would store.
//
//   A  one long page of stacked sections
//   B  categories on the left that stay put, every section on one scrolling page, with search
//      (picked by Stefan on 2026-11-16; reworked from his feedback)
//   C  the settings written as plain sentences with the choices inline
import { useUrl } from "@/lib/router";
import { PrototypeBar } from "./PrototypeBar";
import { useSettings } from "./state";
import { VariantA, name as nameA } from "./VariantA";
import { VariantB, name as nameB } from "./VariantB";
import { VariantC, name as nameC } from "./VariantC";

const VARIANTS = [
  { key: "A", name: nameA, View: VariantA },
  { key: "B", name: nameB, View: VariantB },
  { key: "C", name: nameC, View: VariantC },
];

export function SettingsPrototype() {
  const { params } = useUrl();
  const st = useSettings();
  const current = VARIANTS.find((v) => v.key === (params.get("variant") ?? "A").toUpperCase()) ?? VARIANTS[0];
  return (
    <>
      {/* Room at the bottom so the bar never covers the last setting. */}
      <div className="pb-28"><current.View st={st} /></div>
      <PrototypeBar variants={VARIANTS} current={current} st={st} />
    </>
  );
}
