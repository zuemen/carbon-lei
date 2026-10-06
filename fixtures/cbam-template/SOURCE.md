# Source of the CBAM Communication Template files

Both files are published by the European Commission (DG TAXUD) on the page
"CBAM communication and FAQs":
https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-communication-and-faqs_en

They are the Commission's template for the transitional period (Implementing Regulation (EU) 2023/1773) and the
Commission's filled example for it. The example installation, its address and its data are fictional
("Example Screw Production Plant"). As of 2026-10-07 the Commission has not published a template for the
definitive period.

| File in this folder | Template version (sheet `0_Versions`) | Downloaded from | sha256 |
|---|---|---|---|
| `CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx` | 2.1 (2024-06-05) | `4 CBAM SEE V2.1_Example Steel 3 Screws and nuts_final.xlsx`, extracted from `Communication-template-examples.zip` (sha256 `8869495c30def9600d95e60313d3fc753721efbbe90f54fb3a860c08fc577705`), https://taxation-customs.ec.europa.eu/document/download/8d00a979-e57d-4e53-a11f-8b01370236a9_en?filename=Communication-template-examples.zip | `47512690d157640ba3828e65fab20f34725dc8aef72406073ca31d5bcbb6fd93` |
| `CBAM_Communication_template_for_installations_en_20241213.xlsx` | 2.1.1 (2024-12-13), blank | https://taxation-customs.ec.europa.eu/document/download/2c15cd0e-2447-4ef8-ab70-68b80b66ede8_en?filename=CBAM%20Communication%20template%20for%20installations_en_20241213.xlsx | `5a4e28fdbccfdca45a2c0520184b551a20c0c7bba3db79f87d78c9e58a6c0917` |

Downloaded on 2026-10-06 at 16:43 GMT (HTTP `date` header of both responses).

**Changes:** the example file was renamed (spaces replaced by underscores, `_final` dropped). The contents of both
files are unchanged; the sha256 values above are those of the files as downloaded.

## Copyright and reuse

© European Union, reuse authorised under Commission Decision 2011/833/EU. The Commission's reuse policy is implemented by that Decision of
12 December 2011 on the reuse of Commission documents. The legal notice linked from the page above
(https://commission.europa.eu/legal-notice_en, read on 2026-10-07) states: "Unless otherwise indicated (e.g. in
individual copyright notices), content owned by the EU on this website is licensed under the Creative Commons
Attribution 4.0 International (CC BY 4.0) licence. This means that reuse is allowed, provided appropriate credit
is given and changes are indicated." The files carry no individual copyright notice.

Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
(legal code: https://creativecommons.org/licenses/by/4.0/legalcode). Credit as used in the demo panel:
"© European Union, CC BY 4.0 (file renamed); see SOURCE.md". The only change is the file name of the example
(see **Changes** above).

The files themselves state: "This data collection template has been developed on behalf of the Commission by its
consultants (Umweltbundesamt GmbH Austria)", "The views expressed in this file represent the views of the authors
and not necessarily those of the European Commission", and a disclaimer that neither the authors nor the
Commission can be held liable for results of the calculations.

These two files are not covered by this repository's MIT licence.

## Use in this repository

`sdk/template.ts` reads them; `sdk/test/template.test.ts` checks the values read against values copied by hand
from the example; the demo's Supplier tab loads the example on request. Using the Commission's template does not
mean that CarbonLEI is endorsed by the Commission or connected to the CBAM Registry.
