-- Full-text index for permission-filtered company search.
CREATE INDEX "Segment_text_fts_idx" ON "Segment" USING GIN (to_tsvector('simple', "text"));
