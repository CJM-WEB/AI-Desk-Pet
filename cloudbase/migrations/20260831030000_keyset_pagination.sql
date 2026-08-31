BEGIN;

CREATE INDEX submissions_public_kind_keyset_idx
  ON submissions (kind, published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX submissions_admin_keyset_idx
  ON submissions (status, created_at DESC, id DESC);

/** 社区列表只读取真实 published_at 键集，并以 JSON 关系保持现有适配器形状。 */
CREATE FUNCTION list_public_community(
  p_limit integer,
  p_cursor_time timestamptz DEFAULT NULL,
  p_cursor_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  title text,
  body text,
  published_at timestamptz,
  publication_basis text,
  assets jsonb,
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
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid list limit' USING ERRCODE = '22023';
  END IF;
  IF (p_cursor_time IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'cursor pair required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    submission.id,
    submission.title,
    submission.body,
    submission.published_at,
    submission.publication_basis,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'object_key', asset.object_key,
        'original_name', asset.original_name,
        'actual_size', asset.actual_size,
        'mime_type', asset.mime_type,
        'role', asset.role
      ) ORDER BY asset.id)
      FROM public.assets AS asset
      WHERE asset.submission_id = submission.id
        AND asset.role IN ('cover', 'package')
    ), '[]'::jsonb),
    jsonb_build_object(
      'like_count', engagement.like_count,
      'download_count', engagement.download_count
    )
  FROM public.submissions AS submission
  JOIN public.public_engagement AS engagement
    ON engagement.submission_id = submission.id
  WHERE submission.status = 'published'
    AND submission.kind = 'shared_package'
    AND (
      p_cursor_time IS NULL
      OR (submission.published_at, submission.id) < (p_cursor_time, p_cursor_id)
    )
  ORDER BY submission.published_at DESC, submission.id DESC
  LIMIT p_limit + 1;
END
$$;

/** 反馈列表同样以 published_at 决定稳定位置，created_at 仅作为公开展示事实。 */
CREATE FUNCTION list_public_feedback(
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
  IF p_kind NOT IN ('feedback', 'suggestion') THEN
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

/** 管理员状态属于游标 scope；数据库只接受已由适配器解码出的 created_at 键集。 */
CREATE FUNCTION list_admin_submissions(
  p_limit integer,
  p_status text DEFAULT NULL,
  p_cursor_time timestamptz DEFAULT NULL,
  p_cursor_id text DEFAULT NULL
)
RETURNS SETOF submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
      <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid list limit' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN (
    'uploading', 'system_reviewing', 'manual_review_pending', 'published',
    'auto_rejected', 'admin_rejected', 'deleted_quarantined', 'purged'
  ) THEN
    RAISE EXCEPTION 'invalid submission status' USING ERRCODE = '22023';
  END IF;
  IF (p_cursor_time IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'cursor pair required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT submission.*
  FROM public.submissions AS submission
  WHERE (p_status IS NULL OR submission.status = p_status)
    AND (
      p_cursor_time IS NULL
      OR (submission.created_at, submission.id) < (p_cursor_time, p_cursor_id)
    )
  ORDER BY submission.created_at DESC, submission.id DESC
  LIMIT p_limit + 1;
END
$$;

REVOKE ALL ON FUNCTION list_public_community(integer, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION list_public_feedback(text, integer, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION list_admin_submissions(integer, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_community(integer, timestamptz, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION list_public_feedback(text, integer, timestamptz, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION list_admin_submissions(integer, text, timestamptz, text)
  TO service_role;

COMMIT;
