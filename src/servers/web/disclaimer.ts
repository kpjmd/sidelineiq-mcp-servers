// Canonical Tier 2 (Injury Desk) disclaimer — single source of truth.
//
// Every physician-attributed kpjmd.com post must carry this exact footer; the
// content linter (linter.ts, checkDisclaimer) blocks publish when it is absent
// from the body. Centralized here because the wording is subject to a separate
// counsel / malpractice-carrier review before the first Phase 3 publish — when
// that lands, change the string HERE and the linter, the desk editor, and the
// kpjmd handoff all stay in sync.
//
// Source: master plan §"Disclaimer language" → Tier 2 footer.

export const TIER2_DISCLAIMER =
  "Commentary by Keith P. Johnson, MD is general educational analysis based on " +
  "publicly reported information. Dr. Johnson has not examined or treated these " +
  "athletes. This is not a diagnosis, not medical advice, and does not create a " +
  "physician-patient relationship.";

// The distinctive substring the linter matches (case- and whitespace-normalized)
// so light edits to surrounding wording don't defeat detection. If the canonical
// text above is revised, keep this fingerprint pointed at a phrase that survives
// the revision (ideally the "has not examined or treated" clause — the legally
// load-bearing line).
export const DISCLAIMER_FINGERPRINT = "has not examined or treated";
