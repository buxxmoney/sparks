// Render BillSankey for real, with the live branch's 14 charge lines. This is the
// check the typechecker could not make: `gutterWidth` was in scope as a property
// of `layout`, never as a binding, so only executing the component catches it.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BillSankey } from "../bill-sankey";

const mk = (key: string, group: string, label: string, amountCents: number, quantity: number | null, qUnit: string | null) =>
  ({ key, group, label, amountCents, quantity, quantityUnit: qUnit, rateValue: 1, rateUnit: "c_per_kwh",
     rateDisplay: "1.00 c/kWh", source: null, season: "all", touPeriod: "all" }) as never;

const lines = [
  mk("a","active_energy","Summer · Block 5: above 3 000 kWh",1581884,3375,"kWh"),
  mk("b","active_energy","Winter · Block 5: above 3 000 kWh",1158664,2402,"kWh"),
  mk("c","active_energy","Summer · Block 4: 2 001-3 000 kWh",265192,584,"kWh"),
  mk("d","active_energy","Winter · Block 3: 1 001-2 000 kWh",188394,416,"kWh"),
  mk("e","fixed","Service charge",89045,null,null),
  mk("f","fixed","Capacity charge",85372,null,null),
  mk("g","ancillary","2% surcharge",84509,null,null),
  mk("h","ancillary","Network surcharge",52666,8777,"kWh"),
];
const total = lines.reduce((s, l: never) => s + (l as { amountCents: number }).amountCents, 0);

test("renders without throwing, in both themes", () => {
  for (const isDark of [false, true]) {
    const html = renderToStaticMarkup(
      <BillSankey lines={lines} totalCents={total} isDark={isDark} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Network surcharge");
    // The node hit-target rect that referenced the undefined binding.
    expect(html).toContain("<rect");
  }
});

test("renders a single-charge tariff", () => {
  const one = [mk("x","fixed","Service charge",89045,null,null)];
  const html = renderToStaticMarkup(<BillSankey lines={one} totalCents={89045} isDark={false} />);
  expect(html).toContain("<svg");
});
