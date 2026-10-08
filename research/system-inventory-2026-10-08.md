# Local compute inventory — 2026-10-08

- Host: Lenovo 81DE, Windows 11 Pro 64-bit
- CPU: Intel Core i3-8130U, 2 physical cores / 4 logical processors
- Memory: 4,199,780,352 bytes installed (about 3.91 GiB)
- Free physical memory at initial audit: about 250 MiB; Windows paging was active
- Free C: storage at initial audit: 94,421,196,800 bytes (about 87.9 GiB)
- Runtime used: Node.js v24.19.0; project minimum is Node.js 22
- Python: unavailable and not required
- Third-party runtime packages: none

The representative 30-day research cache used 74,131,220 bytes and the Node
process reported 235,061,248 bytes RSS. The bounded worker recommendation is
one: additional processes would duplicate the tick slots and cached features
on a memory-constrained two-core host.

The existing 30-day immutable compressed archive is about 12 MB. The additional
60 days needed for the first 90-day target are estimated at about 24 MB of raw
gzip chunks plus roughly 2 MB of manifest metadata. The detailed 12,012-trial
ledger is expected to be tens of MB and remains outside Git. Available storage
is therefore sufficient; public API request rate, not disk, is the binding
collection constraint.
