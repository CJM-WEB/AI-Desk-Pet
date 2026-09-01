BEGIN;

-- 共享包仍必须通过对象键、MIME 和精确大小校验，完成后直接进入人工队列。
CREATE OR REPLACE FUNCTION complete_submission_upload(
  p_submission_id text,
  p_assets jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
  v_updated integer;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_assets) <> 'array'
    OR jsonb_array_length(p_assets) <> 2 THEN
    RAISE EXCEPTION 'invalid completed assets' USING ERRCODE = 'P1002';
  END IF;

  UPDATE assets AS asset
  SET actual_size = provided.actual_bytes,
      sha256 = NULL,
      mime_type = provided.content_type,
      signature_valid = true,
      scan_status = 'pending',
      updated_at = now()
  FROM jsonb_to_recordset(p_assets) AS provided(
    role text,
    storage_key text,
    actual_bytes bigint,
    content_type text
  )
  WHERE asset.submission_id = p_submission_id
    AND asset.role = provided.role
    AND asset.object_key = provided.storage_key
    AND asset.declared_size = provided.actual_bytes
    AND asset.mime_type = provided.content_type
    AND provided.role IN ('cover', 'package')
    AND provided.actual_bytes > 0;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 2 THEN
    RAISE EXCEPTION 'completed assets mismatch' USING ERRCODE = 'P1002';
  END IF;

  UPDATE submissions
  SET status = 'manual_review_pending',
      status_version = status_version + 1,
      moderation_lease_until = NULL,
      moderation_attempts = 0,
      moderation_next_retry_at = NULL,
      moderation_last_error = NULL,
      moderation_alerted_at = NULL,
      purge_after = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status = 'uploading'
    AND cleanup_started_at IS NULL
  RETURNING * INTO v_submission;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload cannot be finalized' USING ERRCODE = 'P1002';
  END IF;
  RETURN to_jsonb(v_submission);
END;
$$;

-- 反馈与建议无需文件扫描，创建时直接进入人工队列。
CREATE OR REPLACE FUNCTION create_text_submission(p_submission jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_submission) <> 'object'
    OR p_submission ->> 'kind' NOT IN ('feedback', 'suggestion') THEN
    RAISE EXCEPTION 'invalid text submission payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO submissions (
    id, kind, title, body, status, status_token_hash
  ) VALUES (
    p_submission ->> 'id',
    p_submission ->> 'kind',
    p_submission ->> 'title',
    p_submission ->> 'body',
    'manual_review_pending',
    p_submission ->> 'status_token_hash'
  )
  RETURNING * INTO v_submission;
  INSERT INTO public_engagement (submission_id)
  VALUES (v_submission.id);
  RETURN to_jsonb(v_submission);
END;
$$;

-- 遗留系统队列原子转入人工队列，只清理 worker 运行态并保留历史审核事实。
UPDATE submissions
SET status = 'manual_review_pending',
    status_version = status_version + 1,
    moderation_lease_until = NULL,
    moderation_attempts = 0,
    moderation_next_retry_at = NULL,
    moderation_last_error = NULL,
    moderation_alerted_at = NULL,
    updated_at = now()
WHERE status = 'system_reviewing';

COMMIT;
