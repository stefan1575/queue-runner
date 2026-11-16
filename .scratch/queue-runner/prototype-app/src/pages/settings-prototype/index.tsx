// PROTOTYPE (throwaway): three layouts of the Settings page on the existing /settings route,
// switched by ?variant=A|B|C (and ?data=new for a new install). The content is #36's decision; the
// question is only how it's laid out. State is shared and in memory (state.ts); the floating bar
// switches layout and data set and shows what the runner would store.
//
//   A  one long page of stacked sections
//   B  categories on the left that stay put, every section on one scrolling page, with search
//      (picked by Stefan on 2026-11-16; reworked from his feedback)
//   C  the settings written as plain sentences with the choices inline
//
// Two rounds are kept side by side: ?round=1 is every layout as first shown, the default (round 2)
// is after Stefan's first feedback. The bar switches rounds, and so do the 1 and 2 keys.
import { useUrl } from "@/lib/router";
import { PrototypeBar } from "./PrototypeBar";
import { VariantA as A1 } from "./round1/VariantA";
import { VariantB as B1 } from "./round1/VariantB";
import { VariantC as C1 } from "./round1/VariantC";
import { useSettings } from "./state";
import { VariantA, name as nameA } from "./VariantA";
import { VariantB, name as nameB } from "./VariantB";
import { VariantC, name as nameC } from "./VariantC";

const VARIANTS = [
  { key: "A", name: nameA, View: VariantA, First: A1 },
  { key: "B", name: nameB, View: VariantB, First: B1 },
  { key: "C", name: nameC, View: VariantC, First: C1 },
];

export function SettingsPrototype() {
  const { params } = useUrl();
  const st = useSettings();
  const current = VARIANTS.find((v) => v.key === (params.get("variant") ?? "A").toUpperCase()) ?? VARIANTS[0];
  const round = params.get("round") === "1" ? 1 : 2;
  const View = round === 1 ? current.First : current.View;
  return (
    <>
      {/* Room at the bottom so the bar never covers the last setting. */}
      <div className="pb-28"><View st={st} /></div>
      <PrototypeBar variants={VARIANTS} current={current} round={round} st={st} />
    </>
  );
}
