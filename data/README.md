# Roll Call sample city

`buildings.json` and `responders.json` contain top-level arrays of 48 fictional buildings and 12 fictional responders. They follow the `Building` and `Responder` shapes in [CONTRACTS.md](../CONTRACTS.md).

The grid is centered near Hollywood to match the web demo area. The addresses and manager identities are invented, and the phone numbers use the 555-0100 to 555-0199 fictional range. The fixtures let the API and dispatch teams work offline with examples of senior housing, walk-ups, different egress options, and all three responder types.

From the repository root, run `python3 data/generate_sample_city.py` to regenerate both files with the fixed seed. The script uses the Python standard library and writes beside itself.
