# Previous Node migration history

These immutable SQL files and journal come from
[`legacy-rust-final`](https://github.com/CaiZongyuan/labworld/tree/legacy-rust-final/packages/server/migrations),
commit `2fef28c35afea44ae2018f0e4b6a3a18a96a2bf7`.
[provenance.json](provenance.json) records their SHA256 values.

They are historical test inputs. The service runs only the current baseline
in `packages/server/migrations`. The archive-history test applies these
original migrations through the platform migration API to create genuine
one-row and three-row histories. It verifies refusal before migration
statements, unchanged applied history and safe archive failure/recovery.
It does not seed history rows or convert previous data.
