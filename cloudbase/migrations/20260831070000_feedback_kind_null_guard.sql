BEGIN;

/** 前向替换只收紧 NULL kind；键集列、排序、权限和返回形状保持原契约。 */
CREATE OR REPLACE FUNCTION list_public_feedback(
  p_kind text,
  p_limit integer,
  p_cursor_time timestamptz DEFAULT NULL,
  p_cursor_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  kind text,
  title text,
  body text,
  created_at timestamptz,
  published_at timestamptz,
  public_engagement jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
      <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('feedback', 'suggestion') THEN
    RAISE EXCEPTION 'invalid feedback kind' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid list limit' USING ERRCODE = '22023';
  END IF;
  IF (p_cursor_time IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'cursor pair required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    submission.id,
    submission.kind,
    submission.title,
    submission.body,
    submission.created_at,
    submission.published_at,
    jsonb_build_object('like_count', engagement.like_count)
  FROM public.submissions AS submission
  JOIN public.public_engagement AS engagement
    ON engagement.submission_id = submission.id
  WHERE submission.status = 'published'
    AND submission.kind = p_kind
    AND (
      p_cursor_time IS NULL
      OR (submission.published_at, submission.id) < (p_cursor_time, p_cursor_id)
    )
  ORDER BY submission.published_at DESC, submission.id DESC
  LIMIT p_limit + 1;
END
$$;

REVOKE ALL ON FUNCTION list_public_feedback(text, integer, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_feedback(text, integer, timestamptz, text)
  TO service_role;

COMMIT;
