-- 016_desk_sections.sql
-- Phase 3 — the kpjmd.com handoff contract.
--
-- Until now a desk_post's body was one TEXT column (markdown_body) fed by one
-- textarea in the /desk editor. kpjmd.com's builder
-- (KPJMD-website/scripts/build-injury-desk.js) does not consume a flowing body:
-- it requires seven named prose sections (snapshot, what_happened, anatomy,
-- treatment, timeline, bridge, dr_take) and renders each through
-- textToHtmlParagraphs() — split on blank lines, wrap in <p>, HTML-escape.
-- Section-scoped rendering is what produces the Snapshot callout (the citable
-- AI-Overview chunk), the FAQPage JSON-LD, and the meta description.
--
-- So SidelineIQ becomes the structured author. `sections` holds the seven
-- required strings; `meta` holds kpjmd's optional fields so the downloaded JSON
-- needs no hand-editing before it is dropped into content/injury-desk/published/.
--
-- markdown_body is NOT dropped — it becomes a deterministic serialization of
-- sections (see serializeSections in servers/web/client.ts). That keeps
-- desk_post_versions, the editor preview, and every existing read working
-- unchanged, and keeps content_hash a single scalar the publish gate can compare.
--
-- NO BACKFILL, deliberately. Existing rows keep sections/meta NULL. The linter
-- blocks publish on NULL/incomplete sections, which forces any pre-existing
-- DRAFT to be re-sectioned before it can ship — correct, since such a post
-- cannot produce a valid kpjmd JSON. Already-PUBLISHED rows are untouched; the
-- gate only runs on publish.
--
-- Applied manually like 007-015: psql $DATABASE_URL -f this file.

-- The seven required prose sections, as a flat object of strings:
--   {snapshot, what_happened, anatomy, treatment, timeline, bridge, dr_take}
ALTER TABLE desk_posts
  ADD COLUMN IF NOT EXISTS sections JSONB;

-- kpjmd's optional fields, authored by the MD in /desk:
--   {short_title?, meta_description?, treatment_heading?, player?,
--    conflict_flag?: {team_timeline, otm_range, rationale},
--    relevant_tool?, faqs?: [{q,a}], related_slugs?: string[],
--    anatomy_diagram?, anatomy_diagram_alt?}
-- These are covered by content_hash (see deskContentHash) so they cannot be
-- edited after attestation without invalidating the publish gate.
ALTER TABLE desk_posts
  ADD COLUMN IF NOT EXISTS meta JSONB;

-- kpjmd.com is a SECOND, downstream publishing surface. published_at already
-- means "published on SidelineIQ" and is set by the desk_publish gate; these
-- track the separate fact that the page is live on kpjmd.com, and are only ever
-- set after a server-side fetch of the live URL confirms both a 200 and a
-- matching x-sideline-content-hash meta tag. Never set from a client checkbox.
ALTER TABLE desk_posts
  ADD COLUMN IF NOT EXISTS kpjmd_published_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE desk_posts
  ADD COLUMN IF NOT EXISTS kpjmd_url TEXT;
-- The content_hash that was verified live, so a later edit or Return Watch
-- append makes the confirmation visibly stale rather than silently wrong.
ALTER TABLE desk_posts
  ADD COLUMN IF NOT EXISTS kpjmd_content_hash VARCHAR(64);

-- Version history has to capture the same content the hash covers, or a
-- rollback would restore prose without its metadata.
ALTER TABLE desk_post_versions
  ADD COLUMN IF NOT EXISTS sections JSONB;
ALTER TABLE desk_post_versions
  ADD COLUMN IF NOT EXISTS meta JSONB;
