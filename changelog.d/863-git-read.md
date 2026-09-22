## 🔒 Security
- Added a per-operation Git read allowlist for the five read-only kit roles, with hardened Git configuration and no fetch or writing operations.
- Moved base and pull-request ref acquisition into a trusted workflow check, while documenting that full no-write enforcement still depends on the planned OS boundary.
